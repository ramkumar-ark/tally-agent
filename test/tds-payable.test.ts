import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { calendarMonths, depositDue, interestOn } from "../src/tds-law.js";
import {
  buildStatement,
  openFindings,
  payableCandidates,
  partyKindOf,
  statementRow,
  type PayableDecision,
  type TdsPayableCandidate,
  type TdsPayableFinding,
} from "../src/tds-payable.js";
import {
  buildPayableDecisions,
  buildPayableStatement,
  payableDecisionsFileName,
  payableRunDigest,
  payableStatementFileName,
  type PayableRunIdentity,
} from "../src/tds-payable-template.js";
import { parsePayableDecisions } from "../src/tds-payable-file.js";
import type { Clause21bBookRow, TdsLiability } from "../src/tds.js";
import { readWorkbook, type GridSheet } from "../src/xlsx-read.js";
import { buildWorkbook } from "../src/xlsx.js";

/**
 * The TDS payable statement (design of record:
 * docs/design/2026-10-01-tds-payable-statement-design.md): the pure projector,
 * the decisions-workbook round trip, the run-identity refusal, and the
 * s.201(1A) interest checked against the review's OWN schedule helpers so a
 * second formula can never creep in.
 *
 * Every name and PAN here is invented. `orchid` and `medical` are the repo's
 * planted secrets — the session-level result must never carry them.
 */

const COMPANY_PAN = "MEDCA1234F"; // 4th character C — a company
const FIRM_PAN = "ORCHT1234F"; // 4th character T — a firm
const GSTIN = `27${FIRM_PAN}1Z9`; // a 15-char GSTIN whose chars 3-12 are the PAN

const finding = (over: Partial<TdsPayableFinding> & { id: string }): TdsPayableFinding => ({
  check: "tds_not_deducted",
  severity: "critical",
  section: "194C",
  amount: 5000,
  detail: "no duty credit was found on this bill",
  ...over,
});

const bookRow = (over: Partial<Clause21bBookRow> & { findingId: string }): Clause21bBookRow => ({
  party: "Sample Traders",
  date: "20250510",
  voucherNumber: "P/12",
  gross: 250000,
  tdsDone: 0,
  tdsDeposited: 0,
  depositDate: null,
  section: "194C",
  reason: "not_deducted",
  liability: 5000,
  ...over,
});

const liability = (
  party: string,
  date: string,
  voucherNumber: string,
  rate: number,
  section = "194C",
): TdsLiability =>
  ({
    section,
    liableBase: 100,
    liability: 100 * rate,
    rate,
    deduction: null,
    booking: { party, date, voucherNumber },
  }) as unknown as TdsLiability;

const candidate = (over: Partial<TdsPayableCandidate> & { findingId: string }): TdsPayableCandidate => ({
  check: "tds_not_deducted",
  party: "Sample Traders",
  section: "194C",
  date: "20250510",
  amountPaid: 250000,
  taxPayable: 5000,
  taxDeducted: 0,
  deductionDate: null,
  depositDate: null,
  shortfall: 5000,
  rate: 0.02,
  detail: "no duty credit was found on this bill",
  ...over,
});

const decisionsOf = (ids: string[], d: PayableDecision): Map<string, PayableDecision> =>
  new Map(ids.map((id) => [id, d]));

/** Every cell text in a workbook — the parts are deflated, so bytes lie. */
const allCellText = (buf: Buffer): string =>
  readWorkbook(buf)
    .flatMap((s) => s.rows)
    .flatMap((r) => [...r.cells.values()])
    .map((c) => String(c.value ?? ""))
    .join("\n");

describe("payableCandidates", () => {
  it("keeps only the critical findings and joins each one's clause 21(b) row", () => {
    const out = payableCandidates({
      findings: [
        finding({ id: "TDS-001-1", amount: 5000 }),
        finding({ id: "TDS-003-1", check: "tds_late_deducted", severity: "warning", amount: 100 }),
        finding({ id: "TDS-002-1", check: "tds_short_deducted", severity: "critical", amount: 120 }),
      ],
      clause21b: [
        bookRow({ findingId: "TDS-001-1" }),
        bookRow({ findingId: "TDS-002-1", reason: "short_deducted", liability: 500, tdsDone: 0 }),
      ],
      liabilities: [],
    });
    expect(out.map((c) => c.findingId)).toEqual(["TDS-001-1", "TDS-002-1"]);
    expect(out[0]).toMatchObject({
      party: "Sample Traders",
      date: "20250510",
      amountPaid: 250000,
      taxPayable: 5000,
      taxDeducted: 0,
      shortfall: 5000,
    });
    // A short-deduction 21(b) row carries tdsDone 0 by design; the books'
    // actual credit is its own liability less the finding's shortfall.
    expect(out[1].taxDeducted).toBe(380);
  });

  it("reports a critical finding with no 21(b) row honestly rather than guessing", () => {
    const out = payableCandidates({
      findings: [finding({ id: "TDS-001-9", amount: 4200 })],
      clause21b: [],
      liabilities: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ party: "", date: "", amountPaid: 0, taxPayable: 0, rate: null, shortfall: 4200 });
  });

  it("takes the rate from the cached liability, then from the statutory rate — never a ratio", () => {
    const [exact, loose, statutory] = payableCandidates({
      findings: [
        finding({ id: "TDS-001-1" }),
        finding({ id: "TDS-001-2", section: "194Q", amount: 250 }),
        finding({ id: "TDS-001-3", section: "194Q", amount: 250 }),
      ],
      clause21b: [
        bookRow({ findingId: "TDS-001-1" }),
        // A 194Q party-month row: no voucher number, so the engine's own
        // per-booking key cannot match it; the party|date|section key does.
        bookRow({ findingId: "TDS-001-2", party: "Monthly Vendor", date: "20250801", voucherNumber: "", section: "194Q", gross: 250000, liability: 250 }),
        // No liability matched at all. The old fallback divided liability by
        // gross, which read 0.2% for a 194Q party whose real rate is 0.1% —
        // the base is the engine's threshold-adjusted base, not the bill.
        bookRow({ findingId: "TDS-001-3", party: "Ratio Vendor", date: "20250901", voucherNumber: "", section: "194Q", gross: 200000, liability: 400 }),
      ],
      liabilities: [
        liability("Sample Traders", "20250510", "P/12", 0.01),
        liability("Monthly Vendor", "20250801", "P/30", 0.001, "194Q"),
      ],
      // The engine's own rateFor, as the session binds it.
      statutoryRateOf: (party, section) => (section === "194Q" ? 0.001 : 0.02),
    });
    expect(exact.rate).toBe(0.01);
    expect(loose.rate).toBe(0.001);
    expect(statutory.rate).toBe(0.001);
    expect(statutory.rate).not.toBeCloseTo(400 / 200000, 6);
  });

  it("carries no rate at all when neither a liability nor the law resolves one", () => {
    const out = payableCandidates({
      findings: [finding({ id: "TDS-001-4", section: "999X" })],
      clause21b: [bookRow({ findingId: "TDS-001-4", section: "999X", gross: 200000, liability: 400 })],
      liabilities: [],
      statutoryRateOf: () => null,
    });
    expect(out[0].rate).toBeNull();
  });
});

describe("partyKindOf", () => {
  it("reads the PAN's 4th character, and a GSTIN-derived PAN counts the same", () => {
    expect(partyKindOf(COMPANY_PAN)).toBe("Company");
    expect(partyKindOf(FIRM_PAN)).toBe("Non-company");
    // The 15-char GSTIN carries the PAN in chars 3-12; the review derives it
    // and the statement reads it through the same door.
    expect(GSTIN.slice(2, 12)).toBe(FIRM_PAN);
    expect(partyKindOf(GSTIN.slice(2, 12))).toBe("Non-company");
    expect(partyKindOf("29MEDCA1234F1Z9".slice(2, 12))).toBe("Company");
  });

  it("never guesses a PAN that cannot be found", () => {
    expect(partyKindOf(null)).toBe("Not determinable (no PAN)");
    expect(partyKindOf("")).toBe("Not determinable (no PAN)");
    expect(partyKindOf("NOTAPAN")).toBe("Not determinable (no PAN)");
    expect(partyKindOf("29ABCDE1234F1Z9")).toBe("Not determinable (no PAN)");
  });
});

describe("openFindings", () => {
  it("treats a blank decision and a deleted row as still open", () => {
    const cands = [
      candidate({ findingId: "TDS-001-1" }),
      candidate({ findingId: "TDS-001-2" }),
    ];
    const decided = decisionsOf(["TDS-001-1", "TDS-001-2"], "Accept");
    expect(openFindings(cands, decided)).toEqual([]);
    // The operator deleted row 2 from the sheet: not a decision.
    const partial = new Map([["TDS-001-1", "Accept" as PayableDecision]]);
    expect(openFindings(cands, partial).map((c) => c.findingId)).toEqual(["TDS-001-2"]);
    const blank = new Map([["TDS-001-1", "Accept" as PayableDecision], ["TDS-001-2", null]]);
    expect(openFindings(cands, blank).map((c) => c.findingId)).toEqual(["TDS-001-2"]);
  });
});

describe("s.201(1A) interest on the statement", () => {
  const PAYMENT = "20261031";

  it("charges an undeducted shortfall 1% from its deductible date to the payment date", () => {
    const row = statementRow({
      candidate: candidate({ findingId: "TDS-001-1", date: "20250510", shortfall: 5000 }),
      paymentDate: PAYMENT,
      pan: null,
      panFromGstin: false,
    });
    const expectedI = interestOn(0.01, calendarMonths("20250510", PAYMENT), 5000);
    expect(calendarMonths("20250510", PAYMENT)).toBe(18);
    expect(row.interestI).toBeCloseTo(expectedI, 2);
    expect(row.interestI).toBeCloseTo(900, 2);
    // Deemed deduction on payment: no late-deposit leg.
    expect(row.interestII).toBe(0);
    // The due date is the BOOKING's Rule 30 date — 7th of the next month —
    // never the date after the payment the challan is dated to.
    expect(row.depositDueDate).toBe(depositDue("20250510"));
    expect(row.depositDueDate).toBe("20250607");
    expect(row.depositDueDate).not.toBe("20261107");
    expect(row.deductionDate).toBe(PAYMENT);
    expect(row.interest).toBe(row.interestI);
  });

  it("shows a March booking's Rule 30 date of 30-Apr, on the shortfall rows too", () => {
    // Rule 30's own carve-out: a March deduction is due on 30 April.
    for (const check of ["tds_not_deducted", "tds_short_deducted"]) {
      const row = statementRow({
        candidate: candidate({ findingId: "TDS-001-9", check, date: "20260315", shortfall: 250 }),
        paymentDate: PAYMENT,
        pan: null,
        panFromGstin: false,
      });
      expect(row.depositDueDate).toBe("20260430");
      expect(row.depositDueDate).toBe(depositDue("20260315"));
    }
  });

  it("charges a not-deposited shortfall 1.5% from its deduction date, and 1% when the credit was late", () => {
    const row = statementRow({
      candidate: candidate({
        findingId: "TDS-004-1",
        check: "tds_not_deposited",
        date: "20250510",
        shortfall: 1000,
        taxDeducted: 1000,
        deductionDate: "20250620",
      }),
      paymentDate: PAYMENT,
      pan: null,
      panFromGstin: false,
    });
    // Late deduction: the credit postdates the booking, so leg (i) runs too.
    expect(row.interestI).toBeCloseTo(interestOn(0.01, calendarMonths("20250510", "20250620"), 1000), 2);
    const due = depositDue("20250620"); // 07-Jul-2025
    expect(due).toBe("20250707");
    expect(row.depositDueDate).toBe(due);
    // The Rule 30 due date (07-Jul-2025) decides that leg (ii) is owed at all;
    // the 1.5% itself runs from the 20-Jun deduction, as `analyzeTds` and the
    // 3CD interest schedule measure it.
    expect(row.interestII).toBeCloseTo(interestOn(0.015, calendarMonths("20250620", PAYMENT), 1000), 2);
    expect(row.interest).toBeCloseTo(row.interestI + row.interestII, 2);
    expect(row.deductionDate).toBe("20250620");
  });

  it("charges no late-deduction leg when the credit was taken on the booking date", () => {
    const row = statementRow({
      candidate: candidate({
        findingId: "TDS-004-2",
        check: "tds_not_deposited",
        date: "20250510",
        shortfall: 1000,
        taxDeducted: 1000,
        deductionDate: "20250510",
      }),
      paymentDate: PAYMENT,
      pan: null,
      panFromGstin: false,
    });
    expect(row.interestI).toBe(0);
    // A 10-May bill is due on 07-Jun-2025 under Rule 30 (the 7th of the
    // following month), so leg (ii) is owed — and it runs 18 months from the
    // 10-May deduction to the 31-Oct-2026 payment.
    expect(row.depositDueDate).toBe(depositDue("20250510"));
    expect(row.depositDueDate).toBe("20250607");
    expect(row.interestII).toBeCloseTo(interestOn(0.015, calendarMonths("20250510", PAYMENT), 1000), 2);
    expect(row.interestII).toBeCloseTo(270, 2);
  });

  it("rounds to paise and totals payable as shortfall plus interest", () => {
    const st = buildStatement({
      candidates: [
        candidate({ findingId: "TDS-001-1", date: "20250510", shortfall: 1234.56 }),
        candidate({ findingId: "TDS-001-2", party: "Sample Ltd", date: "20250610", shortfall: 1000, pan: "x" } as never),
      ],
      decisions: decisionsOf(["TDS-001-1", "TDS-001-2"], "Accept"),
      paymentDate: PAYMENT,
      panOf: (p) => (p === "Sample Ltd" ? COMPANY_PAN : null),
      panDerivedFromGstinOf: () => false,
    });
    expect(st.accepted).toBe(2);
    expect(st.rows.every((r) => r.interest === Math.round((r.interestI + r.interestII) * 100) / 100)).toBe(true);
    expect(st.totals.shortfall).toBeCloseTo(2234.56, 2);
    expect(st.totals.payable).toBeCloseTo(st.totals.shortfall + st.totals.interest, 2);
    // A candidate carrying no PAN is its own bucket, and it still reconciles.
    expect(st.byPartyKind.map((g) => g.kind)).toEqual(["Company", "Not determinable (no PAN)"]);
    const sum = st.byPartyKind.reduce((a, g) => a + g.totals.payable, 0);
    expect(Math.abs(sum - st.totals.payable)).toBeLessThan(0.05);
  });
});

describe("buildStatement", () => {
  it("refuses while any critical finding is undecided, naming the open ones", () => {
    const cands = [candidate({ findingId: "TDS-001-1" }), candidate({ findingId: "TDS-002-1" })];
    expect(() =>
      buildStatement({
        candidates: cands,
        decisions: new Map([["TDS-001-1", "Accept"]]),
        paymentDate: "20261031",
        panOf: () => null,
        panDerivedFromGstinOf: () => false,
      }),
    ).toThrow(/1 of 2 critical findings are not decided yet/);
    try {
      buildStatement({
        candidates: cands,
        decisions: new Map([["TDS-001-1", "Accept"]]),
        paymentDate: "20261031",
        panOf: () => null,
        panDerivedFromGstinOf: () => false,
      });
    } catch (e) {
      expect((e as Error).message).toContain("TDS-002-1");
    }
  });

  it("refuses a payment date that is not YYYYMMDD, and a run with nothing to pay", () => {
    const base = { candidates: [candidate({ findingId: "TDS-001-1" })], panOf: () => null, panDerivedFromGstinOf: () => false };
    expect(() =>
      buildStatement({ ...base, decisions: decisionsOf(["TDS-001-1"], "Accept"), paymentDate: "31-10-2026" }),
    ).toThrow(/payment date must be written YYYYMMDD/);
    expect(() =>
      buildStatement({ ...base, candidates: [], decisions: new Map(), paymentDate: "20261031" }),
    ).toThrow(/no critical findings/);
  });

  it("prices only the Accepted rows and counts the rejected ones", () => {
    const st = buildStatement({
      candidates: [
        candidate({ findingId: "TDS-001-1", shortfall: 100 }),
        candidate({ findingId: "TDS-002-1", shortfall: 900 }),
      ],
      decisions: new Map([["TDS-001-1", "Accept"], ["TDS-002-1", "Reject"]]),
      paymentDate: "20261031",
      panOf: () => null,
      panDerivedFromGstinOf: () => false,
    });
    expect(st.rows.map((r) => r.findingId)).toEqual(["TDS-001-1"]);
    expect(st.accepted).toBe(1);
    expect(st.rejected).toBe(1);
    expect(st.totals.shortfall).toBe(100);
  });
});

describe("the decisions workbook", () => {
  const IDENTITY: PayableRunIdentity = {
    company: "Sample Builders",
    fromDate: "20250401",
    toDate: "20260331",
    asOnDate: "20260331",
    criticalCount: 2,
    findingIds: ["TDS-001-1", "TDS-002-1"],
  };
  const CANDIDATES: TdsPayableCandidate[] = [
    candidate({ findingId: "TDS-001-1" }),
    candidate({ findingId: "TDS-002-1", party: "Sample Ltd", date: "20250610", shortfall: 900 }),
  ];

  const sheet = (buf: Buffer, name: string) => {
    const s = readWorkbook(buf).find((x) => x.name === name);
    if (!s) throw new Error(`no sheet ${name}`);
    return s;
  };
  /** The header cells of one Excel row, in column order. */
  const headersAt = (s: GridSheet, row: number): string[] => {
    const r = s.rows.find((x) => x.row === row);
    if (!r) return [];
    return [...r.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => String(c.value ?? ""));
  };
  const columnA = (s: GridSheet): string[] => s.rows.map((r) => String(r.cells.get(0)?.value ?? ""));

  it("round-trips: the written workbook parses back to the decisions it carries", () => {
    const buf = buildPayableDecisions({
      company: IDENTITY.company,
      candidates: CANDIDATES,
      identity: IDENTITY,
      generatedOn: "20261001",
    });
    const sheets = readWorkbook(buf).map((s) => s.name);
    expect(sheets).toEqual(["Instructions", "Findings", "Lists", "Run"]);
    // The Findings sheet lists every critical finding, undecided to begin with.
    const head = headersAt(sheet(buf, "Findings"), 1);
    expect(head.slice(0, 3)).toEqual(["Finding ID", "Check", "Party"]);
    expect(head).toContain("Decision");
    expect(head).toContain("Remarks");
    // No PAN column: a PAN belongs only on the statement.
    expect(head.some((h) => /PAN/i.test(h))).toBe(false);

    const parsed = parsePayableDecisions(buf, IDENTITY, IDENTITY.findingIds);
    expect([...parsed.decisions.entries()]).toEqual([["TDS-001-1", null], ["TDS-002-1", null]]);
    expect(parsed.undecided).toEqual(["TDS-001-1", "TDS-002-1"]);
  });

  it("reads Accept and Reject back off the sheet, case-insensitively", () => {
    const parsed = parsePayableDecisions(
      crafted([["TDS-001-1", "accept"], ["TDS-002-1", " REJECT "]]),
      IDENTITY,
      IDENTITY.findingIds,
    );
    expect([...parsed.decisions.entries()]).toEqual([["TDS-001-1", "Accept"], ["TDS-002-1", "Reject"]]);
    expect(parsed.undecided).toEqual([]);
    const st = buildStatement({
      candidates: CANDIDATES,
      decisions: parsed.decisions,
      paymentDate: "20261031",
      panOf: () => COMPANY_PAN,
      panDerivedFromGstinOf: () => false,
    });
    expect(st.rows.map((r) => r.findingId)).toEqual(["TDS-001-1"]);
    expect(st.rows[0].partyKind).toBe("Company");
  });

  it("refuses a workbook generated from another run, without echoing the digest", () => {
    const buf = buildPayableDecisions({
      company: IDENTITY.company,
      candidates: CANDIDATES,
      identity: IDENTITY,
      generatedOn: "20261001",
    });
    const other: PayableRunIdentity = { ...IDENTITY, asOnDate: "20260930", criticalCount: 3, findingIds: ["TDS-001-1", "TDS-002-1", "TDS-004-1"] };
    let message = "";
    try {
      parsePayableDecisions(buf, other, other.findingIds);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/generated from another review/);
    expect(message).toContain("a different as-on date");
    expect(message).toContain("a different number of critical findings");
    expect(message).not.toContain(payableRunDigest(IDENTITY));
  });

  /**
   * A hand-built workbook the parser will read: the same sheet names and
   * header text as the generated one, but rows the operator could produce —
   * a renamed id, a doubled row, a mistyped word. Never the writer's bytes.
   */
  const crafted = (rows: Array<Array<string | number | null>>): Buffer =>
    buildWorkbook([
      {
        name: "Findings",
        columns: [
          { header: "Finding ID", format: "text" },
          { header: "Decision", format: "text" },
        ],
        rows,
      },
      {
        name: "Run",
        columns: [{ header: "Field", format: "text" }, { header: "Value", format: "text" }],
        rows: [
          ["company", IDENTITY.company],
          ["fromDate", IDENTITY.fromDate],
          ["toDate", IDENTITY.toDate],
          ["asOnDate", IDENTITY.asOnDate],
          ["criticalCount", String(IDENTITY.criticalCount)],
          ["digest", payableRunDigest(IDENTITY)],
        ],
      },
    ]);

  it("refuses an unknown finding id, a duplicate row and a bad Decision word", () => {
    const ids = IDENTITY.findingIds;
    let message = "";
    try {
      parsePayableDecisions(crafted([["TDS-001-1", "Accept"], ["TDS-999-9", "Accept"]]), IDENTITY, ids);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/row 3, column A \(Finding ID\): not a critical finding of this review/);

    try {
      parsePayableDecisions(crafted([["TDS-001-1", "Accept"], ["TDS-001-1", "Reject"]]), IDENTITY, ids);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/this finding id already appears in row 2/);

    try {
      parsePayableDecisions(crafted([["TDS-001-1", "accept"], ["TDS-002-1", "MAYBE"]]), IDENTITY, ids);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/enter Accept or Reject/);

    // A blank id is a structural fault, not an undecided finding.
    try {
      parsePayableDecisions(crafted([[null, "Accept"]]), IDENTITY, ids);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/required cell is blank/);
  });

  it("refuses a workbook with no Findings sheet on a run that has critical findings", () => {
    const buf = buildWorkbook([
      {
        name: "Run",
        columns: [{ header: "Field", format: "text" }, { header: "Value", format: "text" }],
        rows: [
          ["company", IDENTITY.company],
          ["fromDate", IDENTITY.fromDate],
          ["toDate", IDENTITY.toDate],
          ["asOnDate", IDENTITY.asOnDate],
          ["criticalCount", String(IDENTITY.criticalCount)],
          ["digest", payableRunDigest(IDENTITY)],
        ],
      },
    ]);
    expect(() => parsePayableDecisions(buf, IDENTITY, IDENTITY.findingIds)).toThrow(/must carry a Findings sheet/);
  });

  it("accepts a Run sheet from a run with no critical findings and nothing to decide", () => {
    const empty: PayableRunIdentity = { ...IDENTITY, criticalCount: 0, findingIds: [] };
    const buf = buildWorkbook([
      {
        name: "Run",
        columns: [{ header: "Field", format: "text" }, { header: "Value", format: "text" }],
        rows: [
          ["company", empty.company],
          ["fromDate", empty.fromDate],
          ["toDate", empty.toDate],
          ["asOnDate", empty.asOnDate],
          ["criticalCount", "0"],
          ["digest", payableRunDigest(empty)],
        ],
      },
    ]);
    const parsed = parsePayableDecisions(buf, empty, []);
    expect(parsed.decisions.size).toBe(0);
    expect(parsed.undecided).toEqual([]);
  });

  it("names its files with the company slug and the date", () => {
    expect(payableDecisionsFileName("Narayanan Construction", "20261001")).toBe(
      "tds-payable-decisions-narayanan-construction-20261001.xlsx",
    );
    expect(payableStatementFileName("Narayanan Construction", "20261031")).toBe(
      "tds-payable-statement-narayanan-construction-payment20261031.xlsx",
    );
  });

  it("writes the statement workbook with its totals row and a summary sheet", () => {
    const st = buildStatement({
      candidates: CANDIDATES,
      decisions: decisionsOf(["TDS-001-1", "TDS-002-1"], "Accept"),
      paymentDate: "20261031",
      panOf: (p) => (p === "Sample Ltd" ? COMPANY_PAN : GSTIN.slice(2, 12)),
      panDerivedFromGstinOf: (p) => p !== "Sample Ltd",
    });
    const buf = buildPayableStatement({ statement: st, company: IDENTITY.company, generatedOn: "20261001" });
    expect(readWorkbook(buf).map((s) => s.name)).toEqual(["Payable statement", "Summary"]);
    const head = headersAt(sheet(buf, "Payable statement"), 9); // eight title lines first
    for (const h of [
      "Date of booking", "Party", "Party PAN", "Company or non-company",
      "Amount paid or credited", "TDS that should have been deducted", "TDS actually deducted",
      "Date of deduction", "Rate of deduction", "Shortfall to pay",
      "Interest due u/s 201(1A) to the payment date", "Deposit due date",
    ]) {
      expect(head).toContain(h);
    }
    // The PANs are on the operator's disk: one from the master, one derived
    // from the GSTIN, and the company flag follows each.
    const text = allCellText(buf);
    expect(text).toContain(COMPANY_PAN);
    expect(text).toContain(GSTIN.slice(2, 12));
    expect(text).toContain("Company");
    expect(text).toContain("Non-company");
    const summarySheet = sheet(buf, "Summary");
    const labels = columnA(summarySheet);
    expect(labels).toContain("Total payable");
    expect(labels).toContain("Total interest due u/s 201(1A)");
    expect(labels).toContain("By section");
    expect(labels).toContain("By company status");
    // The company / non-company split is on the summary and reconciles to the
    // headline total. A headline row carries its amount in column B; a group row
    // carries Payable in column G.
    const cellOf = (label: string, col: number): number => {
      const r = summarySheet.rows.find((x) => String(x.cells.get(0)?.value ?? "") === label);
      return Number(r?.cells.get(col)?.value ?? 0);
    };
    const headline = cellOf("Total payable", 1);
    expect(headline).toBeGreaterThan(0);
    expect(cellOf("Company", 6)).toBeGreaterThan(0);
    expect(cellOf("Company", 6) + cellOf("Non-company", 6)).toBeCloseTo(headline, 2);
    // And so does the by-section split.
    expect(cellOf("194C", 6)).toBeCloseTo(headline, 2);
  });
});

/** No PAN anywhere in the decisions workbook, even in the finding text. */
describe("privacy", () => {
  it("puts no PAN anywhere in the decisions workbook — a PAN belongs only on the statement", () => {
    const identity: PayableRunIdentity = {
      company: "Sample Builders", fromDate: "20250401", toDate: "20260331",
      asOnDate: "20260331", criticalCount: 1, findingIds: ["TDS-001-1"],
    };
    const buf = buildPayableDecisions({
      company: identity.company,
      candidates: [
        candidate({
          findingId: "TDS-001-1",
          party: "Sample Traders",
          detail: "no duty credit was found on this bill",
        }),
      ],
      identity,
      generatedOn: "20261001",
    });
    // A PAN-shaped token anywhere would be a column the writer added by
    // mistake, or a fact leaking into the review's prose column.
    expect(allCellText(buf)).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
  });
});
