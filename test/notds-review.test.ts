import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { buildNotdsTemplate } from "../src/notds-template.js";
import { parseNotdsTemplate, type NotdsDecision, type NotdsOperatorFile } from "../src/notds-file.js";
import { booksCandidates } from "../src/notds.js";
import { canonicalKey } from "../src/key.js";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";

/**
 * Session-level tests for the clause 21(b) merge (tb_tds_review's cached
 * books + the operator decisions workbook → masked review + lastNoTds).
 * Fixture style follows the TDS review fake in test/review.test.ts; every
 * name, PAN and figure here is invented (orchid/medical planted-secret
 * pattern: the parties below must never appear in the masked JSON).
 */

const MASTERS = JSON.stringify([
  { name: "Site Repairs Contract", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: "Orchid Builders LLP", parent: "Sundry Creditors", IncomeTaxNumber: "ORCHB1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
  { name: "Orchid Traders", parent: "Sundry Creditors", gstin: "27ORCHT1234F1Z9", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
  { name: "No Pan Vendor", parent: "Sundry Creditors", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
]);

const mkSession = (
  vouchersByLedger: Record<string, unknown> = {},
  operator: OperatorFile = OPERATOR,
  masters: string = MASTERS,
) => {
  const s = createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: masters }), {
      ledgerVoucherRows: async (_c: any, ledgerName: string, _f: string, _t: string) => {
        const body = vouchersByLedger[String(ledgerName).toLowerCase()] ?? { source: "ledger-vouchers-report", vouchers: [] };
        const row = (v: any) => ({
          date: String(v.date).replace(/[-/.\s]/g, ""),
          voucherType: String(v.voucherType ?? ""),
          voucherNumber: String(v.voucherNumber ?? ""),
          reference: "",
          counterparty: String(v.counterLedgerName ?? v.partyLedgerName ?? "").trim(),
          amount: typeof v.amount === "number" ? v.amount : Number(String(v.amount ?? "0").replace(/,/g, "")),
          matchStatus: "matched" as const,
          tax: null,
        });
        const rows = (body.vouchers as any[])
          .map(row)
          .filter((r: any) => r.date >= _f && r.date <= _t);
        return { rows, dropped: 0 } as never;
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  return s;
};

const booking = (party: string, amount: number, date: string, voucher: string) => ({
  date,
  voucherType: "Purchase",
  voucherNumber: voucher,
  amount,
  partyLedgerName: party,
});

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [
    { ledger: "Site Repairs Contract", section: "194C" },
    { ledger: "TDS Contractors", section: "194C" },
  ],
  parties: [
    { ledger: "Orchid Builders LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: "Orchid Traders", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: "No Pan Vendor", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
};

const mainSession = async (extra: Record<string, unknown> = {}) => {
  const s = mkSession({
    "site repairs contract": {
      source: "ledger-vouchers-report",
      vouchers: [
        booking("Orchid Builders LLP", 250000, "2025-05-10", "P/12"),
        booking("Orchid Traders", 250000, "2025-06-10", "P/13"),
        booking("No Pan Vendor", 250000, "2025-07-10", "P/14"),
        ...((extra.vouchers as unknown[]) ?? []),
      ],
    },
    "orchid builders llp": { source: "ledger-vouchers-report", vouchers: [] },
    "orchid traders": { source: "ledger-vouchers-report", vouchers: [] },
    "no pan vendor": { source: "ledger-vouchers-report", vouchers: [] },
  });
  await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
  return s;
};

interface ProjectedCandidate {
  key: string;
  party: string;
  date: string;
  voucherNumber: string;
  gross: number;
  tdsDone: number;
  tdsDeposited: number;
  depositDate: string | null;
  section: string;
  liability: number;
  pan: string | null;
  panFromGstin: boolean;
}

const candidate = (party: string, date: string, voucher: string, over: Partial<ProjectedCandidate> = {}): ProjectedCandidate => ({
  key: `${canonicalKey(party)}|${date}|${voucher}|194C`,
  party,
  date,
  voucherNumber: voucher,
  gross: 250000,
  tdsDone: 0,
  tdsDeposited: 0,
  depositDate: null,
  section: "194C",
  liability: 5000,
  pan: null,
  panFromGstin: false,
  ...over,
});

const ORCHID_BUILDERS = candidate("Orchid Builders LLP", "20250510", "P/12", { pan: "ORCHB1234A" });
const ORCHID_TRADERS = candidate("Orchid Traders", "20250610", "P/13", { pan: "ORCHT1234F", panFromGstin: true });
const NO_PAN = candidate("No Pan Vendor", "20250710", "P/14");

type CellRow = Array<string | number | null>;

const CAND_HEADERS = [
  "Key", "Party", "Date", "Voucher", "Section",
  "Gross", "TDS Done", "TDS Deposited", "Deposit Date", "Liability", "PAN",
  "Include", "Cure Reason", "Residency", "NR Section",
  "Nature of Payment", "Address", "City", "State", "PIN", "Country",
  "Amount Override", "Notes",
];

const MANUAL_HEADERS = [
  "Sheet", "Party", "Date", "Amount", "Tax/Levy Deducted", "Tax/Levy Deposited",
  "Section", "Nature of Payment", "PAN/Aadhaar", "Address", "City", "State",
  "PIN", "Country", "Notes",
];

type DecisionCols = Partial<Record<
  "Include" | "Cure Reason" | "Residency" | "NR Section" | "Nature of Payment" | "Amount Override" | "Notes",
  string | number | null
>>;

const candidateRow = (c: ProjectedCandidate, ops: DecisionCols = {}): CellRow => [
  c.key, c.party, "2026-01-15", c.voucherNumber, "194C",
  c.gross, c.tdsDone, c.tdsDeposited, null, c.liability, c.pan,
  ops.Include ?? null,
  ops["Cure Reason"] ?? null,
  ops.Residency ?? null,
  ops["NR Section"] ?? null,
  ops["Nature of Payment"] ?? null,
  null, null, null, null, null,
  ops["Amount Override"] ?? null,
  ops.Notes ?? null,
];

const manualRow = (
  sheet: string,
  over: Partial<Record<string, string | number | null>> = {},
): CellRow => [
  sheet,
  over.Party ?? "Sample Traders",
  over.Date ?? "2026-02-05",
  over.Amount ?? 40000,
  over["Tax/Levy Deducted"] ?? null,
  over["Tax/Levy Deposited"] ?? null,
  over.Section ?? null,
  over["Nature of Payment"] ?? null,
  over["PAN/Aadhaar"] ?? null,
  null, null, null, null, null,
];

const worksheet = (
  candidates: CellRow[],
  manual: CellRow[] = [],
): Buffer => {
  const sheets: Sheet[] = [
    { name: "Candidates", columns: CAND_HEADERS.map((header) => ({ header })), rows: candidates },
  ];
  if (manual.length || candidates.length === 0) {
    sheets.push({ name: "Manual Rows", columns: MANUAL_HEADERS.map((header) => ({ header })), rows: manual });
  }
  return buildWorkbook(sheets);
};

const templatePath = (buf: Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "tally-agent-notds-"));
  const p = join(dir, "notds-operator.xlsx");
  writeFileSync(p, buf);
  return p;
};

const decision = (key: string, over: Partial<NotdsDecision> = {}): NotdsDecision => ({
  key,
  include: true,
  residency: "R",
  ...over,
});

const PAN_SHAPE = /[A-Z]{5}[0-9]{4}[A-Z]/;
const PLANTED = /orchid|no pan vendor/i;

const out = (r: unknown): string => JSON.stringify(r);

describe("noTdsReview", () => {
  it("refuses to run before a TDS review cached the books", async () => {
    const s = mkSession({});
    await expect(s.noTdsReview({})).rejects.toThrow(/run tb_tds_review first/);
  });

  it("projects the candidates onto the resident sheet by default, masked, with unmasked rows cached (sort by date then party)", async () => {
    const s = await mainSession();
    const r = await s.noTdsReview({});
    expect(r.sheets["40(a)(ia) to resident"]).toBe(3);
    expect(r.sheets["40(a)(i) to non-resident"]).toBe(0);
    expect(r.sheets["40(a)(ib) - Equalisation Levy"]).toBe(0);
    expect(r.sheets["40(a)(iii)"]).toBe(0);
    expect(r.cureExcluded).toBe(0);
    expect(r.manualCount).toBe(0);
    expect(r.candidates).toBe(3);
    // One residency-defaulted note per candidate (blank operator input; the
    // books cannot show residency), one no-PAN line for the PAN-less party.
    expect(r.findings.filter((f) => f.check === "notds_residency_defaulted")).toHaveLength(3);
    const noPan = r.findings.find((f) => f.check === "notds_no_pan");
    expect(noPan).toBeDefined();
    expect(noPan!.amount).toBe(250000);
    for (const f of r.findings) {
      expect(f.id).toMatch(/^NOTDS-\d{3}-\d+$/);
      expect(f.party === "" || f.party).toBeTruthy();
    }
    expect(r.counts.review).toBe(r.findings.length);

    // Focus #5: the derived-PAN row's detail shows the TaxId pseudonym and
    // the derivation note; the raw derived PAN never leaves.
    const tradersLine = r.findings.find((f) => f.check === "notds_residency_defaulted" && f.detail.includes("derived from"))!;
    expect(tradersLine.detail).toMatch(/TaxId \d+/);

    // lastNoTds is unmasked with real names and real PANs, sorted by date.
    const rows = s.notdsRows()!;
    expect(rows.map((x) => x.party)).toEqual(["Orchid Builders LLP", "Orchid Traders", "No Pan Vendor"]);
    expect(rows[0]).toMatchObject({ sheet: "40(a)(ia) to resident", date: "20250510", amount: 250000, section: "194C", tdsDone: 0, tdsDeposited: 0 });
    expect(rows[2]!.pan).toBeNull();
    expect(rows[1]!.pan).toBe("ORCHT1234F");

    // Masked output: no planted party name, no PAN anywhere.
    const json = out(r);
    expect(json).not.toMatch(PLANTED);
    expect(json).not.toMatch(PAN_SHAPE);
    expect(json).not.toContain("ORCHT1234F");
  });

  it("round-trips the generated template: blank decisions parse as all-include, all-resident", async () => {
    const cands: ProjectedCandidate[] = [ORCHID_BUILDERS, ORCHID_TRADERS, NO_PAN];
    const path = templatePath(buildNotdsTemplate({ company: "Sample Company", candidates: cands, generatedOn: "20260925" }));
    // The generated operator columns are blank: every key parses to the all-include default.
    const file = parseNotdsTemplate(await import("node:fs/promises").then((m) => m.readFile(path)));
    expect(file.decisions.get(ORCHID_BUILDERS.key)!.include).toBe(true);
    expect(file.decisions.get(ORCHID_BUILDERS.key)!.residency).toBe("R");
    expect(file.decisions.size).toBe(3);
    expect(file.manual).toEqual([]);

    const s = await mainSession();
    const r = await s.noTdsReview({ templatePath: path });
    expect(r.sheets["40(a)(ia) to resident"]).toBe(3);
    expect(r.cureExcluded).toBe(0);
    expect(r.candidates).toBe(3);
    expect(s.notdsRows()!.map((x) => x.party)).toEqual(["Orchid Builders LLP", "Orchid Traders", "No Pan Vendor"]);
  });

  it("drops an Include=N candidate and restates the cure reason masked (Focus #2)", async () => {
    const buf = worksheet(
      [
        candidateRow(ORCHID_BUILDERS, { Include: "N", "Cure Reason": "payee-filed-return" }),
        candidateRow(ORCHID_TRADERS),
        candidateRow(NO_PAN),
      ],
    );
    const s = await mainSession();
    const r = await s.noTdsReview({ templatePath: templatePath(buf) });
    expect(r.cureExcluded).toBe(1);
    expect(r.candidates).toBe(3);
    expect(r.sheets["40(a)(ia) to resident"]).toBe(2);
    const cured = r.findings.find((f) => f.check === "notds_cure_excluded")!;
    expect(cured).toBeDefined();
    expect(cured.amount).toBe(250000);
    expect(cured.detail).toContain("payee-filed-return");
    expect(out(r)).not.toMatch(PLANTED);
    // The excluded row is absent from the unmasked cache, the two kept rows remain.
    expect(s.notdsRows()!.map((x) => x.party)).toEqual(["Orchid Traders", "No Pan Vendor"]);
  });

  it("applies an amount override to the row and restates it (review prose)", async () => {
    const buf = worksheet(
      [
        candidateRow(ORCHID_BUILDERS, { "Amount Override": 200000 }),
        candidateRow(ORCHID_TRADERS),
        candidateRow(NO_PAN),
      ],
    );
    const s = await mainSession();
    const r = await s.noTdsReview({ templatePath: templatePath(buf) });
    const over = r.findings.find((f) => f.check === "notds_amount_override")!;
    expect(over).toBeDefined();
    expect(over.amount).toBe(200000);
    expect(over.detail).toContain("2,00,000.00");
    expect(over.detail).toContain("2,50,000.00");
    const rows = s.notdsRows()!;
    expect(rows.find((x) => x.party === "Orchid Builders LLP")!.amount).toBe(200000);
    expect(rows.find((x) => x.party === "Orchid Traders")!.amount).toBe(250000);
  });

  it("routes a marked-NR row to the non-resident sheet with the operator's NR section", async () => {
    const buf = worksheet(
      [
        candidateRow(ORCHID_BUILDERS),
        candidateRow(NO_PAN, { Residency: "NR", "NR Section": "195" }),
      ],
    );
    const s = await mainSession();
    const r = await s.noTdsReview({ templatePath: templatePath(buf) });
    expect(r.sheets["40(a)(i) to non-resident"]).toBe(1);
    const rows = s.notdsRows()!;
    const nr = rows.find((x) => x.party === "No Pan Vendor")!;
    expect(nr.sheet).toBe("40(a)(i) to non-resident");
    expect(nr.section).toBe("195");
    // An explicit NR mark does not produce the residency-defaulted line...
    const defaults = r.findings.filter((f) => f.check === "notds_residency_defaulted");
    expect(defaults.map((f) => f.party)).not.toContain(nr.party);
  });

  it("drops an NR-routed row with no NR section and reports it (review-time guard, Focus #3)", async () => {
    const s = await mainSession();
    const file: NotdsOperatorFile = {
      decisions: new Map([[NO_PAN.key, decision(NO_PAN.key, { residency: "NR" })]]),
      manual: [],
    };
    const r = await s.noTdsReview({ operator: file });
    const dropped = r.findings.find((f) => f.check === "notds_nr_missing_section")!;
    expect(dropped).toBeDefined();
    expect(dropped.severity).toBe("critical");
    expect(dropped.amount).toBe(250000);
    expect(r.sheets["40(a)(i) to non-resident"]).toBe(0);
    expect(s.notdsRows()!.find((x) => x.party === "No Pan Vendor")).toBeUndefined();
  });

  it("refuses a resident-list spelling on an NR-routed row (review-time guard, Focus #3)", async () => {
    const s = await mainSession();
    const file: NotdsOperatorFile = {
      decisions: new Map([[NO_PAN.key, decision(NO_PAN.key, { residency: "NR", nrSection: "194C" })]]),
      manual: [],
    };
    const r = await s.noTdsReview({ operator: file });
    expect(r.findings.find((f) => f.check === "notds_nr_missing_section")).toBeDefined();
    expect(s.notdsRows()!.find((x) => x.party === "No Pan Vendor")).toBeUndefined();
  });

  it("appends operator manual rows, restated masked, whatever the sheet (levy/salary take no section)", async () => {
    const buf = worksheet(
      [candidateRow(ORCHID_BUILDERS), candidateRow(ORCHID_TRADERS), candidateRow(NO_PAN)],
      [
        ["40(a)(ia) to resident", "Sample Traders", "2026-02-05", 40000, null, null, "194J", "rent top-up paid cash", "SAMPF1234A", null, null, null, null, null],
        ["40(a)(iii)", "Sample Overseas GmbH", "2026-01-20", 250000, null, null, null, "salary paid abroad", null, null, null, null, null, null],
      ],
    );
    const s = await mainSession();
    const r = await s.noTdsReview({ templatePath: templatePath(buf) });
    expect(r.manualCount).toBe(2);
    expect(r.sheets["40(a)(ia) to resident"]).toBe(4); // 3 candidates + 1 manual
    expect(r.sheets["40(a)(iii)"]).toBe(1);
    const restated = r.findings.filter((f) => f.check === "notds_manual_row");
    expect(restated).toHaveLength(2);
    // A manual row with no PAN anywhere gets its own no-PAN line; the
    // one that carried a PAN does not.
    expect(r.findings.filter((f) => f.check === "notds_no_pan")).toHaveLength(2); // candidate + salary manual row
    const rows = s.notdsRows()!;
    const manual = rows.find((x) => x.party === "Sample Traders")!;
    expect(manual).toMatchObject({ sheet: "40(a)(ia) to resident", date: "20260205", amount: 40000, section: "194J", pan: "SAMPF1234A" });
    expect(out(r)).not.toMatch(/sample traders|sample overseas/i);
  });

  it("reports the aggregate unsectioned-bookings line once, count and gross only", async () => {
    const s = mkSession({
      "site repairs contract": {
        source: "ledger-vouchers-report",
        vouchers: [
          booking("Orchid Builders LLP", 5000, "2025-08-10", "P/20"),
          booking("Orchid Builders LLP", 7000, "2025-08-11", "P/21"),
        ],
      },
      "orchid builders llp": { source: "ledger-vouchers-report", vouchers: [] },
    });
    // "Site Repairs Contract" is deliberately NOT in the operator sections:
    // its bookings carry section null and must never become candidates.
    const op: OperatorFile = { ...EMPTY_TDS_OPERATOR, parties: OPERATOR.parties };
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", op, "json");
    const r = await s.noTdsReview({});
    const agg = r.findings.filter((f) => f.check === "notds_unsectioned_bookings");
    expect(agg).toHaveLength(1);
    expect(agg[0]!.amount).toBe(12000);
    expect(agg[0]!.detail).toContain("2"); // count survives scrubDigits (only ≥6-digit runs are mangled)
    expect(r.candidates).toBe(0);
    expect(r.sheets["40(a)(ia) to resident"]).toBe(0);
    expect(s.notdsRows()).toEqual([]);
  });

  it("yields no candidates at all when 194Q is suppressed, and no crash (Focus #1)", async () => {
    const masters = JSON.stringify([
      { name: "Goods Seller", parent: "Sundry Creditors", IncomeTaxNumber: "GOODF1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
      { name: "Goods Purchase", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
    ]);
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      section194QApplicable: false,
      sections: [
        { ledger: "Goods Purchase", section: "194Q" },
        { ledger: "TDS Contractors", section: "194Q" },
      ],
      parties: [{ ledger: "Goods Seller", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false }],
    };
    const s = mkSession(
      {
        "goods purchase": {
          source: "ledger-vouchers-report",
          vouchers: [booking("Goods Seller", 6000000, "2025-05-10", "G/1")],
        },
        "goods seller": { source: "ledger-vouchers-report", vouchers: [] },
        "tds contractors": { source: "ledger-vouchers-report", vouchers: [] },
      },
      op,
      masters,
    );
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", op, "json");
    const r = await s.noTdsReview({});
    expect(r.candidates).toBe(0);
    expect(Object.values(r.sheets).every((n) => n === 0)).toBe(true);
    expect(r.findings).toEqual([]);
    expect(s.notdsRows()).toEqual([]);
  });

  it("carries the Winman spelling of a 194-I(a) law key into the rows (Focus #6)", async () => {
    const masters = JSON.stringify([
      { name: "Office Rent", parent: "Indirect Expenses", IsTDSApplicable: "Yes" },
      { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
      { name: "Rent Payee LLP", parent: "Sundry Creditors", IncomeTaxNumber: "RENTF1234A", IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
    ]);
    const op: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [
        { ledger: "Office Rent", section: "194-I(a)" },
        { ledger: "TDS Contractors", section: "194-I(a)" },
      ],
      parties: [{ ledger: "Rent Payee LLP", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false }],
    };
    const s = mkSession(
      {
        "office rent": {
          source: "ledger-vouchers-report",
          // Year gross must clear the 194-I(a) perMonth proxy's year cap
          // (perMonth 50,000 × 12 — the 26k guard, silent below it).
          vouchers: [booking("Rent Payee LLP", 700000, "2025-09-10", "R/1")],
        },
        "rent payee llp": { source: "ledger-vouchers-report", vouchers: [] },
        "tds contractors": { source: "ledger-vouchers-report", vouchers: [] },
      },
      op,
      masters,
    );
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", op, "json");
    const r = await s.noTdsReview({});
    expect(r.candidates).toBe(1);
    const rows = s.notdsRows()!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.section).toBe("194I (a)");
    expect(rows[0]!.sheet).toBe("40(a)(ia) to resident");
  });
});

describe("booksCandidates — deposit facts beyond the 1:1 join (2026-09-26e/i)", () => {
  const bk = { date: "20250910", voucherNumber: "R/1", party: "Ledger Held LLP", gross: 700000, ledger: "Office Rent", section: "194-I(a)", candidates: [] };
  const liab = (deduction: unknown) => [
    { booking: bk, section: "194-I(a)", liableBase: 700000, liability: 50000, rate: 0.1, deduction },
  ];
  const events = (deductions: unknown[], deposits: unknown[]) =>
    ({ bookings: [], payments: [], deductions, deposits }) as never;
  const run = (deduction: unknown, deposits: unknown[]): NoTdsCandidateRow[] =>
    booksCandidates(events([deduction], deposits), liab(deduction), () => null, () => false);

  it("a month-pool-covered credit (depositCovered) is not a clause 21(b) row", () => {
    const ded = { date: "20250910", voucherNumber: "R/1", party: "Ledger Held LLP", tax: 50000, section: "194-I(a)", joinedTo: "Bank", depositCovered: true };
    expect(run(ded, [])).toEqual([]);
  });

  it("a subsequent-year challan-covered credit is not a clause 21(b) row", () => {
    const ded = { date: "20250910", voucherNumber: "R/1", party: "Ledger Held LLP", tax: 50000, section: "194-I(a)", joinedTo: "Bank", subsequentDeposit: "20260710" };
    expect(run(ded, [])).toEqual([]);
  });

  it("a covered credit that was short-deducted stays a row and carries the deposit facts", () => {
    const ded = {
      date: "20250910", voucherNumber: "R/1", party: "Ledger Held LLP", tax: 30000,
      section: "194-I(a)", joinedTo: "Bank", subsequentDeposit: "20260710", depositCovered: true,
    };
    expect(run(ded, [])).toEqual([
      expect.objectContaining({
        tdsDone: 30000,
        // Challan date quoted over the pool (which records no single date).
        tdsDeposited: 30000,
        depositDate: "20260710",
      }),
    ]);
  });

  it("the 1:1 joined deposit still wins over the stamps when it exists", () => {
    const ded = { date: "20250910", voucherNumber: "R/1", party: "Ledger Held LLP", tax: 40000, section: "194-I(a)", joinedTo: "Bank" };
    const dep = { date: "20251115", party: "Ledger Held LLP", tax: 40000, section: "194-I(a)", deduction: ded };
    expect(run(ded, [dep])).toEqual([
      expect.objectContaining({ tdsDeposited: 40000, depositDate: "20251115" }),
    ]);
  });
});
