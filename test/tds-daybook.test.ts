import { describe, expect, it } from "vitest";
import type { VoucherRow } from "../src/downstream.js";
import { counterpartyOf, projectLedgerRows } from "../src/tds-daybook.js";

const purchase: VoucherRow = {
  date: "20250510",
  voucherType: "Purchase",
  voucherNumber: "PU/0012",
  partyLedgerName: "Acme Contracting",
  cancelled: false,
  entries: [
    { ledger: "Site Expenses", amount: 25000 },
    { ledger: "Acme Contracting", amount: -25000 },
  ],
};

const split: VoucherRow = {
  date: "20250612",
  voucherType: "Journal",
  voucherNumber: "JV/0007",
  partyLedgerName: "Acme Contracting",
  cancelled: false,
  entries: [
    { ledger: "Site Expenses", amount: 90000 },
    { ledger: "Acme Contracting", amount: -88000 },
    { ledger: "TDS on Contracts", amount: -2000 },
  ],
};

describe("counterpartyOf", () => {
  it("faces a two-line voucher's other side", () => {
    expect(counterpartyOf(purchase, 0)).toBe("Acme Contracting");
    expect(counterpartyOf(purchase, 1)).toBe("Site Expenses");
  });

  it("picks the largest opposite-signed line on a split voucher", () => {
    expect(counterpartyOf(split, 0)).toBe("Acme Contracting");
  });

  it("makes a duty line face the expense line", () => {
    expect(counterpartyOf(split, 2)).toBe("Site Expenses");
  });

  it("falls back to the voucher's party ledger when no opposite side exists", () => {
    const single: VoucherRow = {
      ...purchase,
      entries: [{ ledger: "Site Expenses", amount: 25000 }],
    };
    expect(counterpartyOf(single, 0)).toBe("Acme Contracting");
  });
});

describe("projectLedgerRows", () => {
  it("emits one row per requested ledger line, signed for that ledger", () => {
    const out = projectLedgerRows([purchase, split], [
      "Site Expenses",
      "Acme Contracting",
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].ledger).toBe("Site Expenses");
    expect(out[0].rows.map((r) => r.amount)).toEqual([25000, 90000]);
    expect(out[1].ledger).toBe("Acme Contracting");
    expect(out[1].rows.map((r) => r.amount)).toEqual([-25000, -88000]);
  });

  it("matches ledgers case-insensitively but reports the requested spelling", () => {
    const out = projectLedgerRows([purchase], ["site expenses"]);
    expect(out).toHaveLength(1);
    expect(out[0].ledger).toBe("site expenses");
    expect(out[0].rows).toHaveLength(1);
  });

  it("returns an empty rows list for a ledger the vouchers never touch", () => {
    const out = projectLedgerRows([purchase], ["Unused Ledger"]);
    expect(out).toEqual([{ ledger: "Unused Ledger", rows: [] }]);
  });

  it("skips cancelled vouchers", () => {
    const out = projectLedgerRows([{ ...purchase, cancelled: true }], [
      "Site Expenses",
    ]);
    expect(out[0].rows).toEqual([]);
  });

  it("whitelists exactly the day-book row shape", () => {
    const out = projectLedgerRows([purchase], ["Site Expenses"]);
    expect(out[0].rows[0]).toEqual({
      date: "20250510",
      voucherType: "Purchase",
      voucherNumber: "PU/0012",
      reference: "",
      counterparty: "Acme Contracting",
      amount: 25000,
      matchStatus: "unknown",
      tax: null,
    });
  });

  it("coerces numeric dates and voucher numbers to strings", () => {
    const numeric: VoucherRow = {
      ...purchase,
      date: 20250510 as unknown as string,
      voucherNumber: 12 as unknown as string,
    };
    const out = projectLedgerRows([numeric], ["Site Expenses"]);
    expect(out[0].rows[0].date).toBe("20250510");
    expect(out[0].rows[0].voucherNumber).toBe("12");
  });
});
