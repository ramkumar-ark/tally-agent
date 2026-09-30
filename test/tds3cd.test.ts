import { describe, expect, it } from "vitest";
import { analyzeTds, type SubsequentDeposit, type TdsCtx, type TdsEvents, type TdsLedgerRows, type TdsTotals } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { tds3cdRows } from "../src/tds3cd.js";
import type { TcsAnalysis } from "../src/tcs.js";

const dutyLedger = "TDS Contractors";
const expenseLedger = "Site Repairs Contract";
const rentLedger = "Generator Hire Rent";
const certParty = "Sample Builders LLP";
const plainParty = "Sample Consultants";
const company = "TestCo Private Limited";

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [{ ledger: expenseLedger, section: "194C" }],
};

const ctx: TdsCtx & { operator: OperatorFile } = {
  tdsParties: [certParty, plainParty],
  resolveSection: () => ({ section: "194C", candidates: [] }),
  dutySectionOf: () => "194C",
  panKeyOf: (party) => `TaxId ${party}`,
  entityOf: () => null,
  certificateRateOf: (party) => (party === certParty ? 0.03 : null),
  transporterDeclared: () => false,
  deducteeFiledReturn: () => false,
  asOnDate: "20260331",
  period: { fromDate: "20250401", toDate: "20260331" },
  operator: OPERATOR,
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

const events194c = (): ReturnType<typeof analyzeTds> => {
  const expenseRows: TdsLedgerRows[] = [
    { ledger: expenseLedger, rows: [row("20250510", "PU/C", 250000, certParty), row("20250510", "PU/P", 250000, plainParty)] },
  ];
  const dutyRows: TdsLedgerRows[] = [
    { ledger: dutyLedger, rows: [row("20250605", "JV/C", -7500, certParty), row("20250815", "PMT/C", 7500, certParty), row("20250605", "JV/P", -5000, plainParty), row("20250815", "PMT/P", 5000, plainParty)] },
  ];
  return analyzeTds(dutyRows, expenseRows, [], ctx);
};

describe("tds3cdRows", () => {
  it("maps 194-I(a) bookings to the exact Winman section string", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      sections: [{ ledger: rentLedger, section: "194-I(a)" }],
    };
    // analyzeTds leaves 194-I(a)'s per-month threshold unapplied (thresholds
    // in the engine are single/aggregate only), so the liable stamp is
    // handcrafted here — the point of this test is the section mapping.
    const events: TdsEvents = {
      bookings: [{ date: "20250510", voucherNumber: "PU/R", party: plainParty, gross: 100000, ledger: rentLedger, section: "194-I(a)", candidates: [], liable: 100000, rateApplied: 0.02, viaCertificate: false }],
      payments: [],
      deductions: [{ date: "20250628", voucherNumber: "PU/R", party: plainParty, tax: 2000, section: "194-I(a)", joinedTo: "PU/R" }],
      deposits: [{ date: "20250815", party: plainParty, tax: 2000, section: "194-I(a)" }],
    };
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result.tds).toEqual([{
      deductor: company,
      section: "194I (a)",
      nature: "Rent of plant & machinery / equipment",
      totalPayments: 100000,
      sumLiable: 100000,
      atRateLiable: 100000,
      atRateTds: 2000,
      lowerRateLiable: 0,
      lowerRateTds: 0,
      notDeposited: 0,
    }]);
  });

  it("splits liable base and TDS between certificate (lower) and standard (at-rate)", () => {
    const tds = events194c();
    const result = tds3cdRows({ company, tan: null, tds, tcs: emptyTcs(), operator: OPERATOR, asOnDate: "20260331" });
    expect(result.tds).toEqual([{
      deductor: company,
      section: "194C",
      nature: "Payment to contractors / sub-contractors",
      totalPayments: 500000,
      sumLiable: 500000,
      atRateLiable: 250000,
      atRateTds: 5000,
      lowerRateLiable: 250000,
      lowerRateTds: 7500,
      notDeposited: 0,
    }]);
  });

  it("assigns unjoined deductions to the lower-rate bucket when the party holds a certificate for the section", () => {
    const booking = {
      date: "20250510", voucherNumber: "PU/X", party: certParty, gross: 250000, ledger: expenseLedger,
      section: "194C", candidates: [], liable: 250000, rateApplied: 0.03, viaCertificate: true,
    };
    const events: TdsEvents = {
      bookings: [booking],
      payments: [],
      deductions: [{ date: "20250628", voucherNumber: "PU/C", party: certParty, tax: 7500, section: "194C", joinedTo: "PU/X" }],
      deposits: [{ date: "20250815", party: certParty, tax: 7500, section: "194C" }],
    };
    const operator: OperatorFile = {
      ...OPERATOR,
      certificates: [{ ledger: certParty, section: "194C", rate: 3, from: "20250401", to: "20260331", limit: 0 }],
    };
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result.tds[0].lowerRateLiable).toBe(250000);
    expect(result.tds[0].atRateLiable).toBe(0);
    expect(result.tds[0].lowerRateTds).toBe(7500);
    expect(result.tds[0].atRateTds).toBe(0);
  });

  it("emits no row for 206AA", () => {
    const events: TdsEvents = {
      bookings: [{ date: "20250510", voucherNumber: "PU/Z", party: "No Pan Party", gross: 100000, ledger: expenseLedger, section: "206AA", candidates: [], liable: 100000, rateApplied: 0.2, viaCertificate: false }],
      payments: [], deductions: [], deposits: [],
    };
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator: OPERATOR, asOnDate: "20260331" });
    expect(result.tds).toHaveLength(0);
  });

  it("floors notDeposited at zero and carries the shortfall per section", () => {
    const base = (depTax: number): TdsEvents => ({
      bookings: [{ date: "20250510", voucherNumber: "PU/X", party: plainParty, gross: 250000, ledger: expenseLedger, section: "194C", candidates: [], liable: 250000, rateApplied: 0.02, viaCertificate: false }],
      payments: [],
      deductions: [{ date: "20250628", voucherNumber: "PU/X", party: plainParty, tax: 5000, section: "194C", joinedTo: "PU/X" }],
      deposits: depTax === 0 ? [] : [{ date: "20250815", party: plainParty, tax: depTax, section: "194C" }],
    });
    const run = (depTax: number): number =>
      tds3cdRows({ company, tan: null, tds: { events: base(depTax), totals: emptyTotals() }, tcs: emptyTcs(), operator: OPERATOR, asOnDate: "20260331" }).tds[0].notDeposited;
    expect(run(3000)).toBe(2000);
    expect(run(8000)).toBe(0);
    expect(run(0)).toBe(5000);
  });

  it("emits one return row per operator statement with the FY 25-26 due dates and the accurate default", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [
        { form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 },
        { form: "24Q", quarter: "Q2", filedDate: "20251015", tdsAmount: 0, returnAccurate: "No" },
        { form: "27Q", quarter: "Q3", filedDate: "20260117", tdsAmount: 0 },
        { form: "26QB", quarter: "Q4", filedDate: "20260505", tdsAmount: 0 },
      ],
    };
    const result = tds3cdRows({ company, tan: "AAACT1234A", tds: { events: emptyEvents(), totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result.tan).toBe("AAACT1234A");
    expect(result.returns).toEqual([
      { deductor: company, form: "26Q", quarter: "Q1", dueDate: "20250731", filedOn: "20250731", accurate: "Yes" },
      { deductor: company, form: "24Q", quarter: "Q2", dueDate: "20251031", filedOn: "20251015", accurate: "No" },
      { deductor: company, form: "27Q", quarter: "Q3", dueDate: "20260131", filedOn: "20260117", accurate: "Yes" },
      { deductor: company, form: "26QB", quarter: "Q4", dueDate: "20260531", filedOn: "20260505", accurate: "Yes" },
    ]);
  });

  it("skips interest quarters whose statement form is not on the sheet dropdown", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [{ form: "26QE", quarter: "Q1", filedDate: "20250810", tdsAmount: 0 }],
    };
    const tds = events194c();
    expect(operator.statements[0].form).toBe("26QE");
    const result = tds3cdRows({ company, tan: null, tds, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result.interestTds).toHaveLength(0);
    expect(result.skippedInterestQuarters).toContain("Q1:26QE");
  });

  it("groups stamped interest by deduction quarter, merges paid rows on (form, quarter)", () => {
    const operator: OperatorFile = {
      ...OPERATOR,
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 }],
      interestPaid: [{ form: "26Q", quarter: "Q1", amount: 500, paidOn: "20251001" }],
    };
    const c = { ...ctx, operator };
    const tds = events194c();
    const q1 = tds.events.deductions.filter((d) => d.date.slice(4, 6) <= "06");
    expect(q1.length).toBe(2);
    const payable = Math.round(q1.reduce((s, d) => s + (d.interestI ?? 0) + (d.interestII ?? 0), 0));
    const result = tds3cdRows({ company, tan: null, tds, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result.interestTds).toEqual([{ form: "26Q", quarter: "Q1", payable, paid: 500, paidOn: "20251001" }]);
  });

  it("attributes challan interest per quarter, deduped by quarter-scoped challan id (item 061)", () => {
    // Two deductions in different quarters, each covered by the return's own
    // challan: Q1's challan (deposited 31-Jul-2025) paid 5,099 and Q2's
    // (30-Oct-2025) paid 36,763. The Winman `ID No.` restarts each quarter, so
    // both challans report id 5 — the dedupe must not let Q1 suppress Q2. A
    // second Q1 deduction on the same challan must not double-count it.
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [
        { form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 },
        { form: "26Q", quarter: "Q2", filedDate: "20251031", tdsAmount: 0 },
      ],
    };
    const events: TdsEvents = {
      bookings: [],
      payments: [],
      deductions: [
        { date: "20250510", voucherNumber: "D/1", party: plainParty, tax: 5000, section: "194C", joinedTo: null, subsequentDeposit: "20250731", subsequentInterestPaid: 5099, subsequentChallanId: "5", interestII: 150 },
        { date: "20250628", voucherNumber: "D/2", party: plainParty, tax: 3000, section: "194C", joinedTo: null, subsequentDeposit: "20250731", subsequentInterestPaid: 5099, subsequentChallanId: "5", interestII: 100 },
        { date: "20250820", voucherNumber: "D/3", party: plainParty, tax: 4000, section: "194C", joinedTo: null, subsequentDeposit: "20251030", subsequentInterestPaid: 36763, subsequentChallanId: "5", interestII: 200 },
      ],
      reductions: [],
      deposits: [],
    };
    const challans: SubsequentDeposit[] = [
      { party: plainParty, section: "194C", tax: 5000, dedDate: "20250510", depositDate: "20250731", interestPaid: 5099, challanId: "5" },
      { party: plainParty, section: "194C", tax: 4000, dedDate: "20250820", depositDate: "20251030", interestPaid: 36763, challanId: "5" },
    ];
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331", challans });
    expect(result.interestTds).toEqual([
      { form: "26Q", quarter: "Q1", payable: 250, paid: 5099, paidOn: "20250731" },
      { form: "26Q", quarter: "Q2", payable: 200, paid: 36763, paidOn: "20251030" },
    ]);
  });

  it("sums every challan's interest per quarter across sections, each counted once (item 068)", () => {
    // Three Q1 challans across three sections plus one Q2 challan. Paid per
    // quarter must be the Challan-sheet total, NOT only the challans whose
    // allocations joined a deduction: a challan whose allocation never landed
    // still counts. Each challan id must be counted exactly once.
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [
        { form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 },
        { form: "26Q", quarter: "Q2", filedDate: "20251031", tdsAmount: 0 },
      ],
    };
    const challans: SubsequentDeposit[] = [
      { party: plainParty, section: "194C", tax: 5000, dedDate: "20250510", depositDate: "20250731", interestPaid: 144, challanId: "1" },
      { party: plainParty, section: "194J", tax: 3000, dedDate: "20250520", depositDate: "20250731", interestPaid: 81, challanId: "2" },
      { party: plainParty, section: "194A", tax: 2000, dedDate: "20250610", depositDate: "20250731", interestPaid: 479, challanId: "3" },
      // A second allocation of challan 1 — same quarter+id, must not re-add.
      { party: "Other Party", section: "194C", tax: 1000, dedDate: "20250515", depositDate: "20250731", interestPaid: 144, challanId: "1" },
      { party: plainParty, section: "194C", tax: 9000, dedDate: "20250820", depositDate: "20251030", interestPaid: 68, challanId: "5" },
    ];
    // One deduction with interest so the Q1 row exists in payable.
    const events: TdsEvents = {
      bookings: [],
      payments: [],
      deductions: [
        { date: "20250510", voucherNumber: "D/1", party: plainParty, tax: 5000, section: "194C", joinedTo: null, interestII: 100 },
      ],
      reductions: [],
      deposits: [],
    };
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331", challans });
    expect(result.interestTds).toEqual([
      { form: "26Q", quarter: "Q1", payable: 100, paid: 704, paidOn: "20250731" },
    ]);
  });

  it("counts a challan whose deductee name never mapped, via the raw allocations (item 068)", () => {
    // `challans` only carries party-tied allocations; a challan whose Winman
    // name has no operator mapping (as challan id 2 did for 194Q) would be
    // missing. `challanAllocations` is the verbatim Winman allocations list and
    // must recover it.
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 }],
    };
    const events: TdsEvents = {
      bookings: [],
      payments: [],
      deductions: [
        { date: "20250510", voucherNumber: "D/1", party: plainParty, tax: 5000, section: "194C", joinedTo: null, interestII: 100 },
      ],
      reductions: [],
      deposits: [],
    };
    const challanAllocations = [
      { section: "194C", tax: 5000, dedDate: "20250510", paidDate: "", depositDate: "20250731", interestPaid: 144, challanId: "1" },
      { section: "194Q", tax: 3000, dedDate: "20250630", paidDate: "", depositDate: "20250731", interestPaid: 81, challanId: "2" },
      { section: "194Q", tax: 3000, dedDate: "20250630", paidDate: "", depositDate: "20250731", interestPaid: 81, challanId: "2" },
    ];
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331", challanAllocations });
    // A Winman export is in hand, so payable is the per-allocation statutory
    // figure (2026-09-26u): 5000 x 1.5% x 3 (May->Jul) + 3000 x 1.5% x 2
    // (Jun->Jul) x 2 rows = 225 + 90 + 90 = 405; paid still dedupes challan 2.
    expect(result.interestTds).toEqual([
      { form: "26Q", quarter: "Q1", payable: 405, paid: 225, paidOn: "20250731" },
    ]);
  });

  it("computes payable from Winman allocations: 1.5% late-deposit per allocation, quarter rupee-rounded (2026-09-26u)", () => {
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 }],
    };
    const challanAllocations = [
      // Deducted 10-May, challan 31-Jul (Rule 30 due 7-Jun): 1.5% x 3 x 100000 = 4500.
      { section: "194C", tax: 100000, dedDate: "20250510", paidDate: "", depositDate: "20250731", interestPaid: 4400, challanId: "1" },
      // On time: challan 5-Jun is before the 7-Jun due date -> no interest.
      { section: "194C", tax: 50000, dedDate: "20250520", paidDate: "", depositDate: "20250605", interestPaid: 0, challanId: "1" },
      // Deducted 25-Jun, challan 31-Jul: 1.5% x 2 x 12345 = 370.35 (exact), quarter rounds once.
      { section: "194J", tax: 12345, dedDate: "20250625", paidDate: "", depositDate: "20250731", interestPaid: 370, challanId: "2" },
    ];
    const events: TdsEvents = { bookings: [], payments: [], deductions: [], reductions: [], deposits: [] };
    const result = tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331", challanAllocations });
    // Payable = 4500 + 370.35 = 4870.35 -> 4870; paid = 4400 + 370 = 4770 (challan 1 once).
    expect(result.interestTds).toEqual([{ form: "26Q", quarter: "Q1", payable: 4870, paid: 4770, paidOn: "20250731" }]);
  });

  it("adds the 1% late-deduction component only when the operator toggle is on (2026-09-26u)", () => {
    const statements = [{ form: "26Q" as const, quarter: "Q1" as const, filedDate: "20250731", tdsAmount: 0 }];
    const allocation = { section: "194C", tax: 100000, dedDate: "20250510", paidDate: "20250401", depositDate: "20250605", interestPaid: 0, challanId: "1" };
    // Deposit on time; the sum was paid 1-Apr but deducted 10-May -> 1% x 2 x 100000 = 2000.
    const on: OperatorFile = { ...EMPTY_TDS_OPERATOR, statements, lateDeductionInterest: true };
    const off: OperatorFile = { ...EMPTY_TDS_OPERATOR, statements, lateDeductionInterest: false };
    const events: TdsEvents = { bookings: [], payments: [], deductions: [], reductions: [], deposits: [] };
    const run = (operator: OperatorFile) =>
      tds3cdRows({ company, tan: null, tds: { events, totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331", challanAllocations: [allocation] });
    expect(run(on).interestTds).toEqual([{ form: "26Q", quarter: "Q1", payable: 2000 }]);
    expect(run(off).interestTds).toEqual([]);
  });

  it("charges interest on an undeposited TCS collection from the due date to asOnDate", () => {
    const tcs: TcsAnalysis = {
      collections: [
        { date: "20251010", voucherNumber: "INV/1", party: "Cust One", nature: "scrap", gross: 100000, tax: 1000, ledger: "Sales TCS" },
        { date: "20251220", voucherNumber: "INV/2", party: "Cust Two", nature: "scrap", gross: 50000, tax: 500, ledger: "Sales TCS" },
      ],
      deposits: [{ date: "20260105", party: "Cust Two", tax: 500, ledger: "Sales TCS" }],
      totals: { byNature: [{ nature: "scrap", gross: 150000, tax: 1500 }], notDeposited: 1000 },
    };
    const result = tds3cdRows({ company, tan: null, tds: { events: emptyEvents(), totals: emptyTotals() }, tcs, operator: EMPTY_TDS_OPERATOR, asOnDate: "20260331" });
    // Q3 collection (due 20251107) never deposited: 1.5% x 5 months x 1,000 = 75.
    // Q4 collection (due 20260107) deposited on time: 0. On-time quarters emit no row.
    expect(result.interestTcs).toEqual([{ form: "27EQ", quarter: "Q3", payable: 75 }]);
  });

  it("keeps per-entry interest exact but rounds the per-quarter total to the rupee (item 064)", () => {
    // Two Q1 deductions carrying exact sub-rupee interests (0.02 + 0.03). The
    // per-entry figures stay exact in the schedule/findings; the 3CD Interest
    // on TDS row's payable is the rounded quarter total.
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      statements: [{ form: "26Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 0 }],
    };
    const mk = (interestII: number): TdsEvents => ({
      bookings: [],
      payments: [],
      deductions: [
        { date: "20250510", voucherNumber: "D/1", party: plainParty, tax: 5000, section: "194C", joinedTo: null, interestII: 0.02 },
        { date: "20250628", voucherNumber: "D/2", party: plainParty, tax: 3000, section: "194C", joinedTo: null, interestII: interestII },
      ],
      reductions: [],
      deposits: [],
    });
    const result = tds3cdRows({ company, tan: null, tds: { events: mk(0.03), totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result.interestTds).toEqual([{ form: "26Q", quarter: "Q1", payable: 0 }]);
    const result2 = tds3cdRows({ company, tan: null, tds: { events: mk(0.6), totals: emptyTotals() }, tcs: emptyTcs(), operator, asOnDate: "20260331" });
    expect(result2.interestTds).toEqual([{ form: "26Q", quarter: "Q1", payable: 1 }]);
  });

  it("emits TCS rows per nature with the exact Winman strings, per-transaction threshold trim and deposit shortfall", () => {
    const tcs: TcsAnalysis = {
      collections: [
        { date: "20250515", voucherNumber: "INV/1", party: "Cust One", nature: "motor-vehicle", gross: 1200000, tax: 12000, ledger: "Sales TCS" },
        { date: "20250615", voucherNumber: "INV/2", party: "Cust Two", nature: "motor-vehicle", gross: 800000, tax: 0, ledger: "Sales TCS" },
        { date: "20250720", voucherNumber: "INV/3", party: "Cust Three", nature: "unknown", gross: 1000, tax: 10, ledger: "Sales TCS" },
      ],
      deposits: [{ date: "20250810", party: "Cust One", tax: 5000, ledger: "TCS Duty" }],
      totals: { byNature: [{ nature: "motor-vehicle", gross: 2000000, tax: 12000 }, { nature: "unknown", gross: 1000, tax: 10 }], notDeposited: 7100 },
    };
    const operator: OperatorFile = {
      ...EMPTY_TDS_OPERATOR,
      tcsSections: [{ ledger: "TCS Duty", nature: "Scrap" }],
    };
    const result = tds3cdRows({ company, tan: null, tds: { events: emptyEvents(), totals: emptyTotals() }, tcs, operator, asOnDate: "20260331" });
    expect(result.tcs).toContainEqual({
      collector: company,
      nature: "Motor vehicle",
      totalReceipt: 2000000,
      sumLiable: 200000,
      atRateLiable: 200000,
      atRateTcs: 12000,
      lowerRateLiable: 0,
      lowerRateTcs: 0,
      notDeposited: 7000,
    });
    expect(result.tcs).toContainEqual({
      collector: company,
      nature: "unknown",
      totalReceipt: 1000,
      sumLiable: 1000,
      atRateLiable: 1000,
      atRateTcs: 10,
      lowerRateLiable: 0,
      lowerRateTcs: 0,
      notDeposited: 10,
    });
  });

  it("never leaks ledger or party names into any row", () => {
    const tds = events194c();
    const tcs: TcsAnalysis = {
      collections: [{ date: "20251010", voucherNumber: "INV/1", party: "Cust One", nature: "scrap", gross: 100000, tax: 1000, ledger: "Sales TCS" }],
      deposits: [{ date: "20260110", party: "Cust One", tax: 500, ledger: "TCS Duty" }],
      totals: { byNature: [{ nature: "scrap", gross: 100000, tax: 1000 }], notDeposited: 500 },
    };
    const operator: OperatorFile = { ...OPERATOR, tcsSections: [{ ledger: "TCS Duty", nature: "Scrap" }] };
    const result = tds3cdRows({ company, tan: null, tds, tcs, operator, asOnDate: "20260331" });
    const text = JSON.stringify(result);
    for (const name of [dutyLedger, expenseLedger, rentLedger, certParty, plainParty, "Cust One", "No Pan Party"]) {
      expect(text).not.toContain(name);
    }
    expect(result.tan).toBeNull();
  });
});

const emptyEvents = (): TdsEvents => ({ bookings: [], payments: [], deductions: [], deposits: [] });
const emptyTotals = (): TdsTotals => ({ bySection: [], notDeducted: 0, shortDeducted: 0, interestI: 0, interestIi: 0 });
const emptyTcs = (): TcsAnalysis => ({ collections: [], deposits: [], totals: { byNature: [], notDeposited: 0 } });
const round = (n: number): number => Math.round(n * 100) / 100;
/**
 * The backward pool (2026-09-30, inbox 018): a duty credit that settles bills
 * which were already due when it was booked earns s.201(1A)(i) on each of them,
 * and that charge is invisible to both interest bases — the books' stamps carry
 * a credit's OWN deductions, and the return's allocations know nothing of a
 * bill the books never deducted. The engine stamps it on the credit
 * (`backInterestI`) and `tds3cd` adds it, gated by the operator's
 * `lateDeductionInterest` exactly like every other late-deduction interest.
 */
describe("3CD interest on a backward settlement (inbox 018)", () => {
  // The captain's own shape (N. R. BABU, 194-C, FY 25-26): three bills of
  // 1,12,000 (10-Nov, crossing the 1,00,000 aggregate so the whole booking is
  // liable), 13,000 (22-Nov) and 12,050 (23-Dec) = 2,240 + 260 + 241 at 2%. One
  // payment of 2,750 on 01-Jan-2026 pairs to the 23-Dec bill (9 days, inside
  // the window) and its 2,509 of excess settles the two earlier bills
  // backward, oldest open first: 2,240 and 260, 3 months late each at 1%
  // (Nov -> Dec -> Jan) = 67.20 + 7.80.
  const expenseRows: TdsLedgerRows[] = [
    {
      ledger: expenseLedger,
      rows: [
        row("20251110", "PU/1", 112000, plainParty),
        row("20251122", "PU/2", 13000, plainParty),
        row("20251223", "PU/3", 12050, plainParty),
      ],
    },
  ];
  const dutyRows: TdsLedgerRows[] = [
    { ledger: dutyLedger, rows: [row("20260101", "JV/9", -2750, plainParty)] },
  ];
  const operatorFor = (lateDeductionInterest: boolean): OperatorFile => ({
    ...OPERATOR,
    statements: [{ form: "26Q", quarter: "Q4", filedDate: "20260731", tdsAmount: 2750 }],
    lateDeductionInterest,
  });
  const analysis = (lateDeductionInterest = true) =>
    analyzeTds(dutyRows, expenseRows, [], { ...ctx, lateDeductionInterest });
  const run = (lateDeductionInterest: boolean, depositDate: string | null) => {
    const operator = operatorFor(lateDeductionInterest);
    const tds = analysis(lateDeductionInterest);
    // With a Winman return the payable basis is the department's own per-
    // allocation computation, which knows nothing of the two bills the books
    // settled by hand — this challan is the credit's own, and what it charges
    // is added to the backward charge, never merged with it.
    const challanAllocations = depositDate
      ? [{ section: "194C", tax: 2750, dedDate: "20260101", paidDate: "", depositDate, interestPaid: 0, challanId: "1" }]
      : [];
    return tds3cdRows({ company, tan: null, tds, tcs: emptyTcs(), operator, asOnDate: "20260331", challanAllocations });
  };

  it("stamps the settlement's interest on the credit, beside its own deduction's", () => {
    const tds = analysis();
    const [credit] = tds.events.deductions;
    // The credit is paired to the 23-Dec bill and carries that bill's own
    // s.201(1A)(i) (2 months, Dec -> Jan); the two bills it settles backward
    // ride the separate backward stamp, so the two can never be confused.
    expect(credit.booking?.voucherNumber).toBe("PU/3");
    expect(credit.interestI).toBeCloseTo(4.82, 2);
    expect(credit.backInterestI).toBeCloseTo(75, 2);
    expect(tds.totals.interestI).toBeCloseTo(79.82, 2);
    // Nothing is left not-deducted: the pool covered both earlier bills.
    expect(tds.totals.notDeducted).toBe(0);
    expect(tds.findings.filter((f) => f.check === "tds_not_deducted")).toEqual([]);
    // Two of the three late deductions are the backward settlements.
    const late = tds.findings.filter((f) => f.check === "tds_late_deducted");
    expect(late.map((f) => f.amount).sort((a, b) => b - a)).toEqual([2240, 260, 241]);
  });

  it("adds it to the interest rows on the books' basis, with no Winman file", () => {
    // Own interest (4.82) + backward (75.00), rounded once at the quarter. The
    // quarter is the CREDIT's, and a January deduction is Q4 of the financial
    // year (Apr-Mar), like every other stamp on the sheet.
    expect(run(true, null).interestTds).toEqual([{ form: "26Q", quarter: "Q4", payable: 80 }]);
  });

  it("adds it to the Winman per-allocation basis too, once, beside the challan's own interest", () => {
    // With a return in hand the payable basis is the department's own per-
    // allocation computation, which charges nothing for a challan inside the
    // Rule 30 window (07-Feb) and never saw the two bills at all — so the
    // sheet carries the settlement alone, 75.00. The credit's own 4.82 is
    // deliberately NOT added here: the books' basis already counts it, and the
    // return's computation is the one that governs once a return is in hand.
    expect(run(true, "20260207").interestTds).toEqual([{ form: "26Q", quarter: "Q4", payable: 75 }]);
    // Deposited late, the challan is charged by its own allocation first — a
    // January deduction was due 07-Feb, so 07-Apr is 4 months late at 1.5% of
    // 2,750 = 165.00 — and the backward charge is added on top, never merged
    // into it: 165.00 + 75.00 = 240.00.
    expect(run(true, "20260407").interestTds).toEqual([{ form: "26Q", quarter: "Q4", payable: 240 }]);
  });

  it("carries nothing when the operator turns late-deduction interest off", () => {
    // The engine raises no late-deduction finding and stamps nothing, so the
    // books' basis has no payable at all and the row is absent.
    expect(run(false, null).interestTds).toEqual([]);
    // An on-time challan leaves the Winman basis with no payable either, so
    // there is no row to print.
    expect(run(false, "20260207").interestTds).toEqual([]);
    // A late challan still carries its own s.201(1A)(ii) — only the
    // late-DEDUCTION component follows the toggle.
    expect(run(false, "20260407").interestTds).toEqual([{ form: "26Q", quarter: "Q4", payable: 165 }]);
  });
});
