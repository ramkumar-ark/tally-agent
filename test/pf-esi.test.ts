import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFundLedgers, employeeEvents, clause20b, type Clause20bRow } from "../src/pf-esi.js";
import { pfEsiSheets, writePfEsiReport, type PfEsiReportResult } from "../src/report.js";
import type { PfEsiMaskedFinding } from "../src/review.js";
import { createSession } from "../src/review.js";
import { EMPTY_PF_ESI } from "../src/pf-esi-file.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { createVault } from "../src/vault.js";
import { entry } from "./xlsx.test.js";

// Synthetic ledgers and amounts only: the real operator's fund ledgers, party
// names and figures never appear in the repo (captain ruling 2026-09-23).
const GROUPS: Record<string, string> = {
  "Staff PF Payable": "Provisions",
  "Staff ESI Payable": "Provisions",
  "PF Employer Contribution": "Indirect Expenses",
  "ESI Employer Contribution": "Indirect Expenses",
  Salaries: "Indirect Expenses",
  "Synthetic Consultant": "Sundry Creditors",
  "Weighing Machine XY-PF": "Plant & Machinery",
};
const ROOTS: Record<string, string> = {
  Provisions: "Current Liabilities",
  "Indirect Expenses": "Indirect Expenses",
  "Sundry Creditors": "Current Liabilities",
  "Plant & Machinery": "Fixed Assets",
};
const ctx = {
  groupOf: (l: string) => GROUPS[l] ?? "",
  rootOf: (l: string) => ROOTS[GROUPS[l] ?? ""] ?? "",
};
const masters = Object.entries(GROUPS).map(([name, parent]) => ({ name, parent }));

describe("fund ledger discovery", () => {
  it("finds the PF and ESI payable ledgers under a liability root", () => {
    const f = findFundLedgers(masters, ctx);
    expect(f.pf).toEqual(["Staff PF Payable"]);
    expect(f.esi).toEqual(["Staff ESI Payable"]);
  });

  // Review Focus #4
  it("does not pick up a fixed asset that merely matches by name", () => {
    const f = findFundLedgers(masters, ctx);
    expect(f.pf).not.toContain("Weighing Machine XY-PF");
    expect([...f.pf, ...f.esi]).not.toContain("PF Employer Contribution");
  });

  it("takes an operator override over the heuristic", () => {
    const f = findFundLedgers(masters, ctx, { pf: ["Some Other PF Ledger"] });
    expect(f.pf).toEqual(["Some Other PF Ledger"]);
  });

  // Overrides Q4 ruling: an explicit empty per-fund list is believed-in-force
  // tuning ("no payable ledger"), replacing the heuristic wholesale, while the
  // other fund keeps its heuristic.
  it("replaces the heuristic wholesale with an explicit empty list", () => {
    const f = findFundLedgers(masters, ctx, { pf: [] });
    expect(f.pf).toEqual([]);
    expect(f.esi).toEqual(["Staff ESI Payable"]);
  });
});

describe("employee contribution extraction", () => {
  // positive = debit downstream of the gateway, so a contribution CREDIT is NEGATIVE.
  const salaryJv = {
    date: "20250430", voucherType: "Journal", voucherNumber: "423", partyLedgerName: "", cancelled: false,
    entries: [{ ledger: "Salaries", amount: 250000 }, { ledger: "Staff PF Payable", amount: -30000 }],
  };
  const employerJv = {
    date: "20250430", voucherType: "Journal", voucherNumber: "421", partyLedgerName: "", cancelled: false,
    entries: [{ ledger: "PF Employer Contribution", amount: 33000 }, { ledger: "Staff PF Payable", amount: -33000 }],
  };
  const clearJv = {
    date: "20250430", voucherType: "Journal", voucherNumber: "422", partyLedgerName: "Synthetic Consultant", cancelled: false,
    entries: [{ ledger: "Staff PF Payable", amount: 63000 }, { ledger: "Synthetic Consultant", amount: -63000 }],
  };
  const funds = { pf: ["Staff PF Payable"], esi: ["Staff ESI Payable"] };

  it("takes the credit inside the salary journal and nothing else", () => {
    const { events } = employeeEvents([salaryJv, employerJv, clearJv] as never, funds, ctx);
    expect(events).toEqual([{ fund: "PF", wageMonth: "2025-04", date: "20250430", voucherNumber: "423", ledger: "Staff PF Payable", amount: 30000 }]);
  });

  it("reports the amount as a positive rupee figure although the entry is a credit", () => {
    const { events } = employeeEvents([salaryJv] as never, funds, ctx);
    expect(events[0].amount).toBeGreaterThan(0);
  });

  it("splits one salary journal that carries both funds", () => {
    const both = { ...salaryJv, voucherNumber: "5006", date: "20260131",
      entries: [...salaryJv.entries, { ledger: "Staff ESI Payable", amount: -1200 }] };
    const { events } = employeeEvents([both] as never, funds, ctx);
    expect(events.map((e) => [e.fund, e.amount])).toEqual([["PF", 30000], ["ESI", 1200]]);
  });

  it("ignores cancelled vouchers and survives entries: ['']", () => {
    const junk = { date: "20250531", voucherType: "Journal", voucherNumber: "413", partyLedgerName: "", cancelled: true, entries: [""] };
    expect(() => employeeEvents([junk, salaryJv] as never, funds, ctx)).not.toThrow();
    expect(employeeEvents([junk, salaryJv] as never, funds, ctx).events).toHaveLength(1);
  });

  it("raises a finding, not a silent drop, for a fund credit it cannot classify", () => {
    const mystery = { date: "20250731", voucherType: "Journal", voucherNumber: "999", partyLedgerName: "", cancelled: false,
      entries: [{ ledger: "Some Unknown Ledger", amount: 5000 }, { ledger: "Staff PF Payable", amount: -5000 }] };
    const { events, findings } = employeeEvents([mystery] as never, funds, ctx);
    expect(events).toHaveLength(0);
    expect(findings.map((f) => f.check)).toContain("pf_esi_unclassified_contribution");
    expect(findings[0].detail).toContain("5,000.00");   // money(), never a bare 6+-digit run
  });
});

describe("clause 20(b)", () => {
  const ev = (fund: "PF" | "ESI", wageMonth: string, amount: number) =>
    ({ fund, wageMonth, date: `${wageMonth.replace("-", "")}30`, voucherNumber: "1", ledger: "Provider PF Payable A/c", amount });
  const ch = (fund: "PF" | "ESI", wageMonth: string, paidOn: string, amountPaid: number) =>
    ({ fund, wageMonth, paidOn, amountPaid, sheet: "Challans", row: 2 });

  it("makes one row per fund per wage month, ordered", () => {
    const { rows } = clause20b([ev("PF", "2025-05", 28195), ev("PF", "2025-04", 30575)] as never, { challans: [] });
    expect(rows.map((r) => r.wageMonth)).toEqual(["2025-04", "2025-05"]);
    expect(rows[0].dueDate).toBe("20250515");
    expect(rows[0].amountCollected).toBe(30575);
  });

  it("sums several credits in the same wage month", () => {
    const { rows } = clause20b([ev("PF", "2025-04", 30000), ev("PF", "2025-04", 575)] as never, { challans: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCollected).toBe(30575);
  });

  it("joins the operator challan and computes the delay", () => {
    const { rows } = clause20b([ev("PF", "2025-04", 30575)] as never, { challans: [ch("PF", "2025-04", "20250514", 30575)] });
    expect(rows[0].paidOn).toBe("20250514");
    expect(rows[0].delayDays).toBe(0);
    expect(rows[0].disallowed).toBe(false);
  });

  it("flags a late deposit as disallowed under s.36(1)(va)", () => {
    const { rows, findings } = clause20b([ev("PF", "2025-04", 30575)] as never, { challans: [ch("PF", "2025-04", "20250520", 30575)] });
    expect(rows[0].delayDays).toBe(5);
    expect(rows[0].disallowed).toBe(true);
    expect(findings.map((f) => f.check)).toContain("pf_esi_late_deposit");
    expect(findings[0].detail).toContain("15-May-2025");     // displayDate, never a bare YYYYMMDD
    expect(findings[0].detail).toContain("30,575.00");       // money, never a bare digit run
  });

  // Review Focus #3, both directions
  it("keeps a book month with no challan and reports it", () => {
    const { rows, findings } = clause20b([ev("PF", "2026-03", 28401)] as never, { challans: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].paidOn).toBeNull();
    expect(rows[0].amountPaid).toBeNull();
    expect(findings.map((f) => f.check)).toContain("pf_esi_challan_missing");
  });

  it("reports a challan for a month the books do not have, and does not invent a row", () => {
    const { rows, findings } = clause20b([] as never, { challans: [ch("ESI", "2025-11", "20251215", 1000)] });
    expect(rows).toHaveLength(0);
    expect(findings.map((f) => f.check)).toContain("pf_esi_challan_unmatched");
  });

  it("reports a challan that does not agree with the books", () => {
    const { findings } = clause20b([ev("PF", "2025-04", 30575)] as never, { challans: [ch("PF", "2025-04", "20250514", 25000)] });
    expect(findings.map((f) => f.check)).toContain("pf_esi_amount_mismatch");
  });

  // Review Focus #2
  it("returns nothing at all for a fund with no months", () => {
    const { rows, findings } = clause20b([ev("PF", "2025-04", 1)] as never, { challans: [] });
    expect(rows.filter((r) => r.fund === "ESI")).toHaveLength(0);
    expect(findings.every((f) => f.ledger === "Provider PF Payable A/c")).toBe(true);
  });

  it("raises the C1 advisory when the due date is a Sunday", () => {
    const { findings } = clause20b([ev("PF", "2026-02", 28537)] as never, { challans: [ch("PF", "2026-02", "20260316", 28537)] });
    expect(findings.map((f) => f.check)).toContain("pf_esi_due_date_not_working_day");
  });
});

describe("clause 20(b) — review focus", () => {
  const ev = (fund: "PF" | "ESI", wageMonth: string, amount: number) =>
    ({ fund, wageMonth, date: `${wageMonth.replace("-", "")}30`, voucherNumber: "1", ledger: "Provider PF Payable A/c", amount });
  const ch = (fund: "PF" | "ESI", wageMonth: string, paidOn: string, amountPaid: number) =>
    ({ fund, wageMonth, paidOn, amountPaid, sheet: "Challans", row: 2 });

  it("a fund present with no months at all yields zero rows and zero findings", () => {
    const { rows, findings } = clause20b([], { challans: [] });
    expect(rows).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });

  it("single-month fund with a zero-amount month agrees with a zero challan", () => {
    const { rows, findings } = clause20b([ev("ESI", "2025-07", 0)] as never, { challans: [ch("ESI", "2025-07", "20250814", 0)] });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCollected).toBe(0);
    expect(rows[0].disallowed).toBe(false);
    expect(findings).toHaveLength(0);
  });

  it("a single fund month is one row, joined once (C8: no double rows)", () => {
    const { rows } = clause20b([ev("PF", "2025-06", 30000), ev("PF", "2025-06", 500)] as never, { challans: [ch("PF", "2025-06", "20250715", 30500)] });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCollected).toBe(30500);
  });
});

// Task 10: the review workbook. Synthetic figures and names only (captain
// ruling 2026-09-23): the working paper de-masks on disk through
// writeWorkbook, so the de-mask test needs a vault-pseudonymed fund ledger.
describe("pfEsi workbook", () => {
  const rows: Clause20bRow[] = [
    { fund: "PF", wageMonth: "2025-07", amountCollected: 24000, dueDate: "20250815", amountPaid: 24000, paidOn: "20250812", delayDays: null, disallowed: false },
    { fund: "ESI", wageMonth: "2025-08", amountCollected: 8100, dueDate: "20250915", amountPaid: 8100, paidOn: "20250924", delayDays: 9, disallowed: true },
  ];

  const sampleResult = (findings: PfEsiMaskedFinding[] = []): PfEsiReportResult => ({
    company: "Sample Co",
    fromDate: "20250401",
    toDate: "20260331",
    findings,
    rows,
  });

  it("builds a Findings sheet and a Clause 20(b) working paper with the named columns", () => {
    const sheets = pfEsiSheets(sampleResult());
    expect(sheets.map((s) => s.name)).toEqual(["Findings", "Clause 20(b)"]);
    const clause = sheets[1];
    expect(clause.columns.map((c) => c.header)).toEqual([
      "Fund", "Wage Month", "Amount Collected", "Due Date", "Amount Paid", "Paid On", "Delay (days)", "Disallowed",
    ]);
    expect(clause.rows).toEqual([
      ["PF", "2025-07", 24000, "20250815", 24000, "20250812", null, "no"],
      ["ESI", "2025-08", 8100, "20250915", 8100, "20250924", 9, "yes"],
    ]);
  });

  it("formats the two date columns as dates and the amounts as money", () => {
    const clause = pfEsiSheets(sampleResult())[1];
    expect(clause.columns[3].format).toBe("date");
    expect(clause.columns[5].format).toBe("date");
    expect(clause.columns[2].format).toBe("money");
    expect(clause.columns[4].format).toBe("money");
  });

  it("writePfEsiReport de-masks the fund ledger names on disk", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sample Staff PF Payable", "other");
    const dir = await mkdtemp(join(tmpdir(), "pfesi-wb-"));
    const result = sampleResult([{
      id: "PF-001-1",
      check: "pf_esi_paid_late",
      severity: "critical",
      ledger: alias,
      group: "Current Liabilities",
      amount: 8100,
      side: null,
      expected: null,
      detail: `${alias}: the employees' contribution for ESI was paid late`,
    }]);
    const { workbookPath: path } = await writePfEsiReport({ reportDir: dir, result, vault });
    const xml = entry(await readFile(path), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("Sample Staff PF Payable");
    expect(xml).not.toContain(alias);
  });
});

// The pfEsiLedgers key of the session's own config/overrides.json is the
// promised default for tb_pf_esi_review: a per-call overridesPath is optional,
// so absent, the key parsed at session creation must still drive
// findFundLedgers. Synthetic ledgers and figures only.
describe("pfEsiLedgers default channel", () => {
  const pfLedger = "Staff PF Payable";
  const alternate = "Alternate PF Payable";
  const esiLedger = "Staff ESI Payable";
  const salaryLedger = "Staff Wages";
  const stub = Object.assign(fakeDownstream(), {
    groups: async () => [
      { name: "Current Liabilities", parent: "\u0004 Primary" },
      { name: "Indirect Expenses", parent: "\u0004 Primary" },
    ],
    ledgers: async () => [
      { name: pfLedger, parent: "Current Liabilities", openingBalance: 0, closingBalance: -1000 },
      { name: alternate, parent: "Current Liabilities", openingBalance: 0, closingBalance: -1000 },
      { name: esiLedger, parent: "Current Liabilities", openingBalance: 0, closingBalance: -1000 },
      { name: salaryLedger, parent: "Indirect Expenses", openingBalance: 0, closingBalance: 1000 },
    ],
    vouchers: async () => [
      {
        date: "20250430", voucherType: "Jrnl", voucherNumber: "J-1", partyLedgerName: "", cancelled: false,
        entries: [{ ledger: salaryLedger, amount: 2000 }, { ledger: pfLedger, amount: -2000 }],
      },
    ],
  } as never);

  it("delivers the overrides file's pfEsiLedgers when no per-call overridesPath is passed", async () => {
    const session = createSession(stub, {
      ...EMPTY_OVERRIDES,
      pfEsiLedgers: { pf: [alternate], esi: [] },
    });
    const result = await session.pfEsiReview({
      fromDate: "20250401",
      toDate: "20250630",
      operator: EMPTY_PF_ESI,
    });
    // The override replaced the heuristic wholesale for both funds (Q4).
    const reals = session.vault.entries().map((e) => e.real);
    expect(result.funds.esi).toEqual([]);
    expect(reals).toContain(alternate);
    expect(reals).not.toContain(pfLedger);
    expect(reals).not.toContain(esiLedger);
  });
});
