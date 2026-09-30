import { describe, expect, it } from "vitest";
import { analyzeTds, type TdsCtx, type TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { canonicalKey } from "../src/key.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile, type WinmanFacts } from "../src/tds-file.js";
import { tds3cdRows } from "../src/tds3cd.js";
import type { TcsAnalysis } from "../src/tcs.js";

/**
 * Subsequent-FY challan deposit coverage (2026-09-26i): the filed return's
 * per-deductee challan allocations (deposit dated after the FY end, on or
 * before the s.139(1) due date) cover book deductions that carry no book
 * deposit debit. Covered deductions are "deposited in the subsequent year":
 * no `tds_not_deposited`, no s.40(a)(ia) base; lateness interest (ii) still
 * runs to the challan date; clause 34's notDeposited stays zero.
 *
 * Two 2,00,000 bills (Feb + Mar 2026) cross 194C's aggregate threshold
 * whole-year liable; 2% of each is the 4,000 duty credit. PAN 4th char C
 * (via entityOf) holds the 2% rate so the credits join cleanly.
 */

const PARTY_A = "Subseq Builders";
const PARTY_B = "Subseq Second Works";
const EXPENSE = "Subseq Job Work";
const DUTY = "Subseq TDS on Contractors";

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: EXPENSE, section: "194C" },
    { ledger: DUTY, section: "194C", kind: "duty" },
  ],
  parties: [
    { ledger: PARTY_A, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: PARTY_B, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
};

const row = (date: string, voucher: string, amount: number, counterparty: string): LedgerVoucherRow => ({
  date,
  voucherType: "Purchase",
  voucherNumber: voucher,
  reference: "",
  counterparty,
  amount,
  matchStatus: "matched",
  tax: null,
});

/** A 2,00,000 bill with its 4,000 duty credit on the same voucher. */
const bill = (party: string, date: string, voucher: string, withDeposit: boolean) => ({
  expense: row(date, voucher, 200000, party),
  party: row(date, voucher, -196000, EXPENSE),
  credit: row(date, voucher, -4000, party),
  deposit: withDeposit ? row(date, voucher, 4000, party) : null,
});

const FEB_A = bill(PARTY_A, "20260220", "PU/1", false);
const MAR_A = bill(PARTY_A, "20260320", "PU/2", false);
const MAR_B = bill(PARTY_B, "20260312", "PU/3", false);

const alloc = (party: string, dedDate: string, depositDate: string, tax = 4000) => ({
  party,
  section: "194C",
  tax,
  dedDate,
  depositDate,
});

const ctxWith = (subsequentDeposits: TdsCtx["subsequentDeposits"]): TdsCtx & { operator: OperatorFile } => ({
  tdsParties: [PARTY_A, PARTY_B],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: () => "194C",
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => "C",
  certificateRateOf: () => null,
  transporterDeclared: () => false,
  deducteeFiledReturn: () => false,
  asOnDate: "20260331",
  period: { fromDate: "20250401", toDate: "20260331" },
  operator: OPERATOR,
  subsequentDeposits,
});

const ledgersOf = (bills: ReturnType<typeof bill>[]): { duty: TdsLedgerRows[]; expense: TdsLedgerRows[]; party: TdsLedgerRows[] } => ({
  duty: [{ ledger: DUTY, rows: bills.flatMap((b) => (b.deposit ? [b.credit, b.deposit] : [b.credit])) }],
  expense: [{ ledger: EXPENSE, rows: bills.map((b) => b.expense) }],
  party: [{ ledger: "party", rows: bills.map((b) => b.party) }],
});

const checks = (findings: { check: string }[]): string[] => findings.map((f) => f.check);
const count = (findings: { check: string }[], check: string): number => checks(findings).filter((c) => c === check).length;

const NO_TCS: TcsAnalysis = { collections: [], deposits: [], totals: { byNature: [], notDeposited: 0 } };

describe("subsequent-year challan coverage (2026-09-26i)", () => {
  it("covers post-FY challan deductions: no not_deposited, no 40(a)(ia); Feb runs late, Mar is on-time silent", () => {
    const L = ledgersOf([FEB_A, MAR_A]);
    const { events, findings } = analyzeTds(
      L.duty,
      L.expense,
      L.party,
      ctxWith([alloc(PARTY_A, "20260220", "20260430"), alloc(PARTY_A, "20260320", "20260430")]),
    );
    expect(count(findings, "tds_not_deposited")).toBe(0);
    expect(count(findings, "tds_exposure_40a_ia")).toBe(0);
    const late = findings.filter((f) => f.check === "tds_late_deposit");
    expect(late).toHaveLength(1);
    expect(late[0].detail).toContain("30-Apr-2026");
    expect(late[0].detail).toContain("per the return's challan");
    expect(late[0].schedule).toEqual([
      { kind: "ii", amount: late[0].schedule?.[0]?.amount, from: "20260220", to: "20260430", basis: expect.any(String) },
    ]);
    const byDate = new Map(events.deductions.map((d) => [d.date, d]));
    expect(byDate.get("20260220")?.subsequentDeposit).toBe("20260430");
    expect(byDate.get("20260220")?.interestII).toBeGreaterThan(0);
    expect(byDate.get("20260320")?.subsequentDeposit).toBe("20260430");
    expect(byDate.get("20260320")?.interestII).toBeUndefined();
  });

  it("spends each allocation once: two same-month deductions, one challan row", () => {
    const FEB_A2 = bill(PARTY_A, "20260220", "PU/1b", false);
    const L = ledgersOf([FEB_A, FEB_A2]);
    const { findings } = analyzeTds(L.duty, L.expense, L.party, ctxWith([alloc(PARTY_A, "20260220", "20260430")]));
    expect(count(findings, "tds_late_deposit")).toBe(1);
    expect(count(findings, "tds_not_deposited")).toBe(1);
  });

  it("challan date overrides an in-window book deposit for lateness (2026-09-26t inbox 075)", () => {
    // The books carry a same-day (on-time) deposit; the return's challan for the
    // same deduction lands 30-Apr-2026. The captain's rule (075): the challan is
    // the filing evidence, so its date drives s.201(1A)(ii) — late, not "reads
    // exactly as no allocation" — while the deduction stays deposited (no
    // not_deposited, no 40(a)(ia)).
    const FEB_PAID = bill(PARTY_A, "20260220", "PU/1", true);
    const L = ledgersOf([FEB_PAID, MAR_A]);
    const withAlloc = analyzeTds(L.duty, L.expense, L.party, ctxWith([alloc(PARTY_A, "20260220", "20260430")]));
    expect(count(withAlloc.findings, "tds_late_deposit")).toBe(1);
    const late = withAlloc.findings.find((f) => f.check === "tds_late_deposit");
    expect(late?.detail).toContain("30-Apr-2026");
    expect(count(withAlloc.findings, "tds_not_deposited")).toBe(1); // MAR_A remains uncovered
  });

  it("follows the deductee, not the section+month: B and a stranger stay uncovered", () => {
    const L = ledgersOf([MAR_A, MAR_B]);
    const { findings } = analyzeTds(
      L.duty,
      L.expense,
      L.party,
      ctxWith([
        alloc(PARTY_A, "20260320", "20260430"),
        { party: "STRANGER DEDUCTEE", section: "194C", tax: 4000, dedDate: "20260312", depositDate: "20260430" },
      ]),
    );
    expect(count(findings, "tds_late_deposit")).toBe(0);
    expect(count(findings, "tds_not_deposited")).toBe(1);
  });

  it("an allocation past the s.139(1) due date covers nothing: not_deposited plus the 40(a)(ia) exposure", () => {
    const L = ledgersOf([FEB_A]);
    const { findings } = analyzeTds(L.duty, L.expense, L.party, ctxWith([alloc(PARTY_A, "20260220", "20261115")]));
    expect(count(findings, "tds_not_deposited")).toBe(1);
    expect(count(findings, "tds_exposure_40a_ia")).toBe(1);
    expect(count(findings, "tds_late_deposit")).toBe(0);
  });

  it("keeps subsequent-covered tax out of clause 34's notDeposited", () => {
    const L = ledgersOf([FEB_A, MAR_A]);
    const covered = analyzeTds(
      L.duty,
      L.expense,
      L.party,
      ctxWith([alloc(PARTY_A, "20260220", "20260430"), alloc(PARTY_A, "20260320", "20260430")]),
    );
    const bare = analyzeTds(L.duty, L.expense, L.party, ctxWith([]));
    const rowOf = (events: typeof covered.events): number | undefined =>
      tds3cdRows({ company: "c", tan: null, tds: { events, totals: covered.totals }, tcs: NO_TCS, operator: OPERATOR, asOnDate: "20260331" }).tds.find(
        (r) => r.section === "194C",
      )?.notDeposited;
    expect(rowOf(covered.events)).toBe(0);
    expect(rowOf(bare.events)).toBe(8000);
  });
});

describe("review wiring: the Winman name joins the template declaration (2026-09-26i)", () => {
  const PARTY = "Join Builders";
  const EXP = "Join Job Work";
  const DUTY = "Join TDS Duty";
  const WINMAN_NAME = "WINMAN JOIN BUILDERS";

  const MASTERS = JSON.stringify([
    { name: PARTY, parent: "Sundry Creditors", IncomeTaxNumber: "AABCX9999Z" },
    { name: EXP, parent: "Purchase Accounts" },
    { name: DUTY, parent: "Duties & Taxes" },
  ]);

  const operatorWith = (winmanName: string | undefined): OperatorFile => ({
    ...EMPTY_TDS_OPERATOR,
    sections: [
      { ledger: EXP, section: "194C" },
      { ledger: DUTY, section: "194C", kind: "duty" },
    ],
    parties: [
      {
        ledger: PARTY,
        tdsApplicable: true,
        transporterDeclaration: false,
        deducteeFiledReturn: false,
        ...(winmanName ? { winmanName } : {}),
      },
    ],
  });

  const WINMAN: WinmanFacts = {
    challans: [],
    allocations: [{ name: WINMAN_NAME, section: "194C", tax: 4000, dedDate: "20260220", depositDate: "20260430" }],
    deductees: [],
    formType: "26Q",
    tan: null,
    skipped: { noSection: 0, noJoin: 0 },
  };

  const run = async (operator: OperatorFile) => {
    const byLedger = new Map<string, LedgerVoucherRow[]>([
      [canonicalKey(EXP), [row("20260220", "PU/1", 200000, PARTY)]],
      [canonicalKey(PARTY), [row("20260220", "PU/1", -196000, EXP)]],
      [canonicalKey(DUTY), [row("20260220", "PU/1", -4000, PARTY)]],
    ]);
    const s = createSession(
      Object.assign(fakeDownstream({ tally_get_ledgers: MASTERS }), {
        ledgerVoucherRows: async (_c: unknown, ledger: string, f: string, t: string) => ({
          rows: (byLedger.get(canonicalKey(ledger)) ?? []).filter((r) => r.date >= f && r.date <= t),
          dropped: 0,
        }),
      } as never),
      EMPTY_OVERRIDES,
      EMPTY_WRONG_GROUP,
    );
    return s.tdsReview(undefined, "20250401", "20260331", "20260331", operator, "json", WINMAN);
  };

  it("a declared Winman name covers the deduction; an undeclared one is dropped", async () => {
    const declared = await run(operatorWith(WINMAN_NAME));
    expect(declared.findings.filter((f) => f.check === "tds_not_deposited")).toHaveLength(0);
    expect(declared.findings.filter((f) => f.check === "tds_late_deposit")).toHaveLength(1);

    const undeclared = await run(operatorWith(undefined));
    expect(undeclared.findings.filter((f) => f.check === "tds_not_deposited")).toHaveLength(1);
    expect(undeclared.findings.filter((f) => f.check === "tds_late_deposit")).toHaveLength(0);
  });
});

describe("clause 21(b) engine rows (2026-09-26 005)", () => {
  // The four sheets must reconcile to the review's findings, so the engine
  // collects every Clause21bBookRow at exactly the raise point of the
  // not_deducted / short / not_deposited finding it produces. These tests pin
  // the collection, not the projection (test/notds-review.test.ts) or the
  // workbook (test/notds-write.test.ts).

  it("an uncovered deduction yields one not_deposited row with its booking's base", () => {
    const L = ledgersOf([FEB_A]);
    const { clause21b } = analyzeTds(L.duty, L.expense, L.party, ctxWith([]));
    expect(clause21b).toEqual([
      {
        party: PARTY_A,
        date: "20260220",
        voucherNumber: "PU/1",
        gross: 200000,
        tdsDone: 4000,
        tdsDeposited: 0,
        depositDate: null,
        section: "194C",
        reason: "not_deposited",
        liability: 4000,
        deductionDate: "20260220",
        findingId: "TDS-004-1",
      },
    ]);
  });

  it("a subsequent-year challan-covered deduction yields no row", () => {
    const L = ledgersOf([FEB_A]);
    const { clause21b } = analyzeTds(L.duty, L.expense, L.party, ctxWith([alloc(PARTY_A, "20260220", "20260430")]));
    expect(clause21b).toEqual([]);
  });

  it("a month-pool-covered deduction yields no row", () => {
    const L = ledgersOf([FEB_A]);
    // A duty-ledger deposit debit dated inside the Rule 30 window but not the
    // deduction's own date, so the 1:1 join cannot claim it: the month pool
    // covers the February need and the row disappears.
    const covered = {
      ...L,
      duty: [{ ledger: DUTY, rows: [...L.duty[0]!.rows, row("20260310", "CH/9", 4000, "Bank")] }],
    };
    const { clause21b } = analyzeTds(covered.duty, covered.expense, covered.party, ctxWith([]));
    expect(clause21b).toEqual([]);
  });

  it("an undeducted booking yields one not_deducted row with tdsDone 0", () => {
    const L = ledgersOf([FEB_A]);
    const { findings, clause21b } = analyzeTds([], L.expense, L.party, ctxWith([]));
    expect(clause21b).toEqual([
      expect.objectContaining({
        party: PARTY_A,
        date: "20260220",
        voucherNumber: "PU/1",
        gross: 200000,
        tdsDone: 0,
        tdsDeposited: 0,
        section: "194C",
        reason: "not_deducted",
      }),
    ]);
    // The row declares its producing finding id: the 21(b) sheet maps 1:1 to
    // the review (2026-09-26 007).
    const raising = findings.find((f) => f.check === "tds_not_deducted" && f.deductee === PARTY_A);
    expect(clause21b[0]!.findingId).toBe(raising!.id);
  });

  it("splits a lump 194T credit per partner and names each partner's expense share", () => {
    // Dr Partner Alpha 10,00,000 / Dr Partner Beta 20,00,000 / Cr Duty 3,00,000
    const duty194T: TdsLedgerRows = {
      ledger: DUTY,
      rows: [
        {
          ...row("20250910", "J/1", -300000, "Partners Current"),
          draws: [
            { ledger: "Partner Alpha", amount: 1000000 },
            { ledger: "Partner Beta", amount: 2000000 },
          ],
        },
      ],
    };
    const ctx194T: TdsCtx & { operator: OperatorFile } = {
      ...ctxWith([]),
      resolveSection: () => ({ section: "194T", candidates: [] }),
      dutySectionOf: () => "194T",
    };
    const { clause21b } = analyzeTds([duty194T], [], [], ctx194T);
    expect(clause21b.map((r) => ({ party: r.party, gross: r.gross, done: r.tdsDone, reason: r.reason }))).toEqual([
      { party: "Partner Alpha", gross: 1000000, done: 100000, reason: "not_deposited" },
      { party: "Partner Beta", gross: 2000000, done: 200000, reason: "not_deposited" },
    ]);
  });

  it("names each 194T partner's expense as the section's proportional base, not the draw (2026-09-26 009)", () => {
    // A 40,00,000 partner-remuneration booking carries one lump 4,00,000 duty
    // credit split across two partner draws (1,00,000 / 3,00,000 → tax
    // 1,00,000 / 3,00,000). Nothing is deposited. The clause 21(b) expense is
    // the expenditure whose tax went unpaid — 40,00,000 × each partner's share
    // of the section's tax = 10,00,000 / 30,00,000 — not the draw itself.
    const duty194T: TdsLedgerRows = {
      ledger: DUTY,
      rows: [
        {
          ...row("20250910", "J/1", -400000, "Partners Current"),
          draws: [
            { ledger: "Partner Alpha", amount: 100000 },
            { ledger: "Partner Beta", amount: 300000 },
          ],
        },
      ],
    };
    const expense194T: TdsLedgerRows = {
      ledger: "Partner Remuneration",
      rows: [row("20250910", "J/1", 4000000, "Partners Current")],
    };
    const ctx194T: TdsCtx & { operator: OperatorFile } = {
      ...ctxWith([]),
      resolveSection: (l: string) => ({ section: "194T", candidates: [] }),
      dutySectionOf: () => "194T",
    };
    const { clause21b } = analyzeTds([duty194T], [expense194T], [], ctx194T);
    expect(clause21b.map((r) => ({ party: r.party, gross: r.gross, done: r.tdsDone, deposited: r.tdsDeposited }))).toEqual([
      { party: "Partner Alpha", gross: 1000000, done: 100000, deposited: 0 },
      { party: "Partner Beta", gross: 3000000, done: 300000, deposited: 0 },
    ]);
  });
});
