import { describe, expect, it } from "vitest";
import { analyzeTcs } from "../src/tcs.js";
import type { TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";

function row(date: string, voucherNumber: string | number, counterparty: string, amount: number, voucherType = "Sales"): LedgerVoucherRow {
  return { date, voucherType, voucherNumber: voucherNumber as string, reference: "", counterparty, amount, matchStatus: "matched", tax: null };
}

describe("analyzeTcs", () => {
  const duty: TdsLedgerRows[] = [{ ledger: "TCS Receivable", rows: [
    row("20250710", "S-1", "Buyer A", -2000),          // collected
    row("20250807", "PY-1", "TCS Payable", 2000),       // deposited
  ]}];
  const receipts: TdsLedgerRows[] = [{ ledger: "Scrap Sales", rows: [
    row("20250710", "S-1", "Buyer A", 200000),          // receipt of specified nature
  ]}];
  const natureOf = (ledger: string) => (ledger === "Scrap Sales" || ledger === "TCS Receivable" ? "scrap" : null);

  it("reads collections as duty credits and deposits as duty debits", () => {
    const a = analyzeTcs(duty, receipts, natureOf);
    expect(a.collections).toHaveLength(1);
    expect(a.collections[0]).toMatchObject({ date: "20250710", party: "Buyer A", nature: "scrap", tax: 2000, gross: 200000 });
    expect(a.deposits).toHaveLength(1);
    expect(a.totals.byNature).toEqual([{ nature: "scrap", gross: 200000, tax: 2000 }]);
    expect(a.totals.notDeposited).toBe(0);
  });

  it("undeposited tax floors at zero per nature", () => {
    const a = analyzeTcs([{ ledger: "TCS Receivable", rows: [row("20250710", "S-1", "Buyer A", -500)] }], [], natureOf);
    expect(a.totals.notDeposited).toBe(500);
  });

  it("ignores cancelled vouchers", () => {
    const a = analyzeTcs([{ ledger: "TCS Receivable", rows: [row("20250710", "S-1", "Buyer A", -500, "Credit Note")] }], [], natureOf);
    expect(a.collections).toHaveLength(0);
  });

  it("joins collections when the day book returns voucherNumber as a JSON number", () => {
    const dutyJoin: TdsLedgerRows[] = [{ ledger: "TCS Receivable", rows: [
      row("20250710", "2025", "Buyer A", -2000), // duty side: string voucher number
    ]}];
    const receiptsJoin: TdsLedgerRows[] = [{ ledger: "Scrap Sales", rows: [
      row("20250710", 2025, "Buyer A", 200000),  // receipt side: day book JSON number
    ]}];
    const a = analyzeTcs(dutyJoin, receiptsJoin, natureOf);
    expect(a.collections).toHaveLength(1);
    expect(a.collections[0]).toMatchObject({ voucherNumber: "2025", gross: 200000, tax: 2000 });
    expect(a.totals.byNature).toEqual([{ nature: "scrap", gross: 200000, tax: 2000 }]);
  });
});
