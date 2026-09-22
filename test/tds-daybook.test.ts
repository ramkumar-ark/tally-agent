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

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDayBookText, readDayBook } from "../src/tds-daybook.js";

const raw = (date: number, num: string) => ({
  date: String(date),
  voucherType: "Purchase",
  voucherNumber: num,
  partyLedgerName: "Acme Contracting",
  entries: [
    { LEDGERNAME: "Site Expenses", AMOUNT: -25000 },
    { LEDGERNAME: "Acme Contracting", AMOUNT: 25000 },
  ],
});

const year = [raw(20250510, "PU/1"), raw(20250612, "PU/2"), raw(20260115, "PU/3")];
const opts = { fromDate: "20250401", toDate: "20260331" };

describe("readDayBook", () => {
  it("accepts a bare array and reports its shape", () => {
    const out = readDayBook(JSON.stringify(year), opts);
    expect(out.shape).toBe("array");
    expect(out.vouchers).toHaveLength(3);
    expect(out.company).toBeNull();
  });

  it("accepts a { vouchers } envelope", () => {
    const out = readDayBook(JSON.stringify({ vouchers: year }), opts);
    expect(out.shape).toBe("envelope");
    expect(out.vouchers).toHaveLength(3);
  });

  it("accepts a bundle and carries its masters through", () => {
    const bundle = {
      tallyAgentExport: 1,
      company: "Example Infra",
      fromDate: "20250401",
      toDate: "20260331",
      groups: [{ name: "Indirect Expenses", parent: "" }],
      ledgers: [{ name: "Site Expenses", parent: "Indirect Expenses" }],
      vouchers: year,
    };
    const out = readDayBook(JSON.stringify(bundle), { ...opts, company: "example infra" });
    expect(out.shape).toBe("bundle");
    expect(out.ledgers).toEqual([{ name: "Site Expenses", parent: "Indirect Expenses" }]);
  });

  it("refuses a truncated file without mentioning its contents", () => {
    const truncated = JSON.stringify(year).slice(0, 120);
    expect(() => readDayBook(truncated, opts)).toThrow(/not valid JSON.*truncated/i);
  });

  it("refuses a file that is not an array, an envelope or a bundle", () => {
    expect(() => readDayBook(JSON.stringify({ rows: year }), opts)).toThrow(/day-book file/i);
  });

  it("refuses a bundle naming a different company, without echoing either name", () => {
    const bundle = { tallyAgentExport: 1, company: "Other Entity", vouchers: year };
    try {
      readDayBook(JSON.stringify(bundle), { ...opts, company: "Example Infra" });
      throw new Error("expected a refusal");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/different company/i);
      expect(m).not.toMatch(/Other Entity|Example Infra/);
    }
  });

  it("refuses a bundle whose declared period does not cover the review", () => {
    const bundle = { tallyAgentExport: 1, fromDate: "20250401", toDate: "20250930", vouchers: year };
    expect(() => readDayBook(JSON.stringify(bundle), opts)).toThrow(/does not cover/i);
  });

  it("refuses a bundle holding vouchers outside its own declared period", () => {
    const bundle = { tallyAgentExport: 1, fromDate: "20250401", toDate: "20260331", vouchers: [raw(20240510, "PU/9")] };
    expect(() => readDayBook(JSON.stringify(bundle), opts)).toThrow(/misdescribes itself/i);
  });

  it("refuses a file with no voucher in any month of the review period", () => {
    const wrongYear = [raw(20240510, "PU/1")];
    expect(() => readDayBook(JSON.stringify(wrongYear), opts)).toThrow(/no voucher in any month/i);
  });

  it("reports interior empty months rather than refusing", () => {
    const out = readDayBook(JSON.stringify(year), opts);
    expect(out.emptyMonths).toContain("2025-07");
    expect(out.emptyMonths).not.toContain("2025-05");
  });

  it("counts rows it could not turn into a voucher", () => {
    const out = readDayBook(JSON.stringify([...year, { nonsense: true }]), opts);
    expect(out.rejected).toBe(1);
    expect(out.vouchers).toHaveLength(3);
  });

  it("records the observed span", () => {
    const out = readDayBook(JSON.stringify(year), opts);
    expect(out.observedFrom).toBe("20250510");
    expect(out.observedTo).toBe("20260115");
  });
});

describe("loadDayBookText", () => {
  it("refuses a file over the ceiling and says what to do instead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daybook-"));
    const path = join(dir, "big.json");
    await writeFile(path, "x".repeat(2048), "utf8");
    await expect(loadDayBookText(path, 1024)).rejects.toThrow(/too large.*quarter/i);
  });

  it("reads a file inside the ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daybook-"));
    const path = join(dir, "ok.json");
    await writeFile(path, "[]", "utf8");
    await expect(loadDayBookText(path, 1024)).resolves.toBe("[]");
  });
});
