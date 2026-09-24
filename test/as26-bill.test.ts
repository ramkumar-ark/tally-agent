import { describe, it, expect } from "vitest";
import { deductionEvents, reconcileParty, type BooksFacts } from "../src/as26.js";
import type { As26File } from "../src/as26-file.js";
import { canonicalKey } from "../src/key.js";

const file = (txs: As26File["transactions"]): As26File =>
  ({ summaries: [], transactions: txs, skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 } });

describe("deductionEvents keeps the voucher number", () => {
  it("pushes voucherNumber through", () => {
    const ev = deductionEvents([{ date: "20250415", voucherType: "Journal", voucherNumber: "JV 8",
      counterparty: "Alpha Traders", amount: 5000, reference: "", matchStatus: "unknown" }], "tds");
    expect(ev.events[0].voucherNumber).toBe("JV 8");
    expect(ev.events[0].ledgerKey).toBe(canonicalKey("Alpha Traders"));
  });
  it("nulls an empty voucher number", () => {
    const ev = deductionEvents([{ date: "20250415", voucherType: "Journal", voucherNumber: "",
      counterparty: "Alpha Traders", amount: 5000, reference: "", matchStatus: "unknown" }], "tds");
    expect(ev.events[0].voucherNumber).toBeNull();
  });
  it("carries a bill reference through", () => {
    const ev = deductionEvents([{ date: "20250415", voucherType: "Purchase", voucherNumber: "PUR/0012",
      counterparty: "Alpha Traders", amount: 5000, reference: "ZL/77", matchStatus: "matched" }], "tds");
    expect(ev.events[0].reference).toBe("ZL/77");
  });
  it("nulls an empty reference", () => {
    const ev = deductionEvents([{ date: "20250415", voucherType: "Purchase", voucherNumber: "PUR/0012",
      counterparty: "Alpha Traders", amount: 5000, reference: "", matchStatus: "matched" }], "tds");
    expect(ev.events[0].reference).toBeNull();
  });
});

describe("reconcileParty items carry their source indexes", () => {
  const facts = ((): BooksFacts => {
    const d = {
      ledgerKey: canonicalKey("Alpha Traders"), kind: "tds" as const, date: "20250415",
      tax: 5000, voucherType: "Journal", voucherNumber: "JV 8",
    };
    return { deductions: [d], sales: [] };
  })();
  const tx: As26File["transactions"][number] = { kind: "tds", nameKey: canonicalKey("Alpha Traders"),
    date: "20250420", amount: 100500, tax: 5000, status: "F", bookingDate: "20250501", section: "194C" };
  const match = { ledgerKeys: [canonicalKey("Alpha Traders")], ledgerNames: ["Alpha Traders"],
    ledgerName: "Alpha Traders", as26NameKey: canonicalKey("Alpha Traders"), as26Name: "Alpha Traders",
    kind: "tds" as const, source: "operator" as const };

  it("unmatched books item keeps dedIdx and voucherNumber access via facts", () => {
    const r = reconcileParty(file([{ ...tx, tax: 6000 }]), facts, match, "20260331");
    expect(r.unmatchedAs26).toHaveLength(1);
    expect(r.unmatchedBooks[0]?.dedIdx).toBe(0);
    expect(r.unmatchedAs26[0]?.txIdx).toBe(0);
    expect(r.unmatchedAs26[0]?.gross).toBe(100500);
    expect(r.unmatchedAs26[0]?.status).toBe("F");
  });
  it("a paired item still carries the indexes", () => {
    const pair: As26File["transactions"][number] = { ...tx, date: "20250418", bookingDate: "20250418" };
    const r = reconcileParty(file([pair]), facts, match, "20260331");
    expect(r.paired).toHaveLength(1);
    expect(r.paired[0].books.dedIdx).toBe(0);
    expect(r.paired[0].as26.txIdx).toBe(0);
  });
  it("combination parts keep their indexes", () => {
    // two 26AS rows splitting one books deduction; taxes 2000+3000 fit the 5000 target
    const a: As26File["transactions"][number] = { ...tx, tax: 2000 },
      b: As26File["transactions"][number] = { ...tx, tax: 3000 };
    const r = reconcileParty(file([a, b]), facts, match, "20260331");
    expect(r.combinations).toHaveLength(1);
    const [c] = r.combinations;
    expect(c.side).toBe("books");
    expect(c.parts.map((p) => p.txIdx).sort()).toEqual([0, 1]);
  });
});
