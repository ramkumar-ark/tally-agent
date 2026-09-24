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

import { linkInvoice, buildBillRows, partyTxsOf, type BillRow } from "../src/as26-bill.js";
import { analyzeAs26, round2 } from "../src/as26.js";
import type { As26File } from "../src/as26-file.js";

describe("linkInvoice (A2 four-step linkage)", () => {
  const ALPHA = canonicalKey("Alpha Traders");
  const sale = (date: string, ref: string | null, taxable: number, gross: number) =>
    ({ ledgerKey: ALPHA, date, ref, taxable, gross });
  // s1: taxable 100000 (2% = 2000), gross 118000 (2% = 2360)
  const s1 = sale("20250415", "CUST-REF-1", 100000, 118000);
  // s2: taxable 350000 (2% = 7000), gross 413000 (2% = 8260)
  const s2 = sale("20250601", "REFX", 350000, 413000);

  it("(a) a reference hit beats a rate match on another sale", () => {
    // tax 2000 would match s1 by taxable-rate, but the reference names s2
    const link = linkInvoice([s1, s2], { date: "20250701", tax: 2000, reference: " reFx ", section: "194C" });
    expect(link?.sale.ref).toBe("REFX");
    expect(link?.basis).toBe("reference");
  });
  it("(b) a taxable-rate hit when no reference matches", () => {
    const link = linkInvoice([s1], { date: "20250701", tax: 2000, reference: null, section: "194C" });
    expect(link?.basis).toBe("taxable-rate");
    expect(link?.sale.ref).toBe("CUST-REF-1");
  });
  it("(c) an invoice-rate hit when taxable x rate does not match the tax", () => {
    // taxable 90000 -> 1800 (no), gross 100000 -> 2000 (yes)
    const s3 = sale("20250501", null, 90000, 100000);
    const link = linkInvoice([s3], { date: "20250701", tax: 2000, reference: null, section: "194C" });
    expect(link?.basis).toBe("invoice-rate");
    expect(link?.sale).toBe(s3);
  });
  it("(d) an approximate link when neither reference nor rate matches", () => {
    const link = linkInvoice([s1, s2], { date: "20250701", tax: 9999, reference: null, section: "194C" });
    expect(link?.sale.ref).toBe("REFX"); // latest sale on or before the item date
    expect(link?.basis).toBe("approximate");
  });
  it("(e) null when no sale precedes the item date", () => {
    expect(linkInvoice([s1, s2], { date: "20250401", tax: 2000, reference: null, section: "194C" })).toBeNull();
  });
  it("rate steps are date-gated; same-date ties pick earliest order", () => {
    // after the date gate only s1 remains, so the 7000 tax cannot rate-match s2
    const link = linkInvoice([s1, s2], { date: "20250501", tax: 2000, reference: null, section: "194C" });
    expect(link?.basis).toBe("taxable-rate");
    expect(link?.sale.ref).toBe("CUST-REF-1");
    const tie = linkInvoice([sale("20250601", "SAME-1", 350000, 413000), sale("20250601", "SAME-2", 350000, 413000)],
      { date: "20250701", tax: 7000, reference: null, section: "194C" });
    expect(tie?.sale.ref).toBe("SAME-1"); // first in array order wins on same date
  });
});

describe("buildBillRows (A2)", () => {
  const ALPHA = canonicalKey("Alpha Traders");
  const facts: BooksFacts = {
    deductions: [{
      ledgerKey: canonicalKey("Alpha Traders"), kind: "tds", date: "20250415",
      tax: 5000, voucherType: "Purchase", voucherNumber: "PUR/0012", reference: "BILL-7",
    }],
    sales: [
      { ledgerKey: canonicalKey("Alpha Traders"), date: "20250410", ref: "BILL-7", taxable: 100000, gross: 118000 },
      { ledgerKey: canonicalKey("Alpha Traders"), date: "20250201", ref: "BILL-2", taxable: 350000, gross: 413000 },
    ],
  };
  const file = (txs: As26File["transactions"]): As26File =>
    ({ summaries: [{
      kind: "tds", name: "Alpha Traders", nameKey: ALPHA,
      section: "194C", taxTotal: 20000, taxClaimed: 0, balanceCf: 0, gross: 1080000,
    }], transactions: txs, skipped: { noDate: 0, blankTax: 0, form16BCDE: 0 } });
  const tx = (o: Partial<As26File["transactions"][number]>): As26File["transactions"][number] => ({
    kind: "tds", nameKey: ALPHA, date: "20250418",
    amount: 350000, tax: 7000, status: "F", bookingDate: "20250418", section: "194C", ...o,
  });
  const map = { mappings: [{ ledger: "Alpha Traders", as26Name: "Alpha Traders" }] };

  // Books tax 5000; 26AS txns 7000/4000/9000 — nothing pairs and no subset fits.
  const opts = { fromDate: "20250401", toDate: "20260331" };
  const f = file([
    tx({ tax: 7000, amount: 150000, date: "20250418", bookingDate: "20250418" }), // rate-links BILL-2, value beyond tolerance
    tx({ tax: 4000, amount: 30000, date: "20250901", bookingDate: "20250901" }),  // approximate link only
    tx({ tax: 9000, amount: 10000, date: "20260501", bookingDate: "20260501" }),  // out of window
  ]);
  const res = analyzeAs26(f, facts, map, ["Alpha Traders"], opts);

  it("books rows carry voucher identity, the whole-token rate link and linkBasis", () => {
    const rows: BillRow[] = buildBillRows(res, facts, f, opts);
    const d = rows.filter((r) => r.kind === "booksded");
    expect(d).toHaveLength(1);
    const r = d[0]!;
    expect(r.ref).toBe("PUR/0012");
    expect(r.voucherType).toBe("Purchase");
    expect(r.nameKey).toBe(ALPHA);
    expect(r.linkBasis).toBe("reference"); // reference "BILL-7" beats any rate
    expect(r.linked?.ref).toBe("BILL-7");
    expect(r.linked?.taxable).toBe(100000);
    expect(r.linked?.date).toBe("20250410");
    expect(r.delta).toBeNull();
    expect(r.inWindow).toBe(true);
  });
  it("as26 rows carry their own gross and the transaction-section link", () => {
    const rows = buildBillRows(res, facts, f, opts);
    const a = rows.filter((r) => r.kind === "as26");
    expect(a).toHaveLength(3);
    const t1 = a.find((r) => r.tax === 7000);
    expect(t1?.gross).toBe(150000);
    expect(t1?.status).toBe("F");
    expect(t1?.linkBasis).toBe("taxable-rate"); // 350000 x 2% = 7000
    expect(t1?.linked?.ref).toBe("BILL-2");
    expect(t1?.delta).toBeNull();
    const t3 = a.find((r) => r.date === "20260501");
    expect(t3?.inWindow).toBe(false); // outside window stays on the list
  });
  it("value rows fire only on non-approximate links beyond tolerance", () => {
    const rows = buildBillRows(res, facts, f, opts);
    const v = rows.filter((r) => r.kind === "value");
    expect(v).toHaveLength(1); // t1 only: t1 = 150000 - 350000
    expect(v[0]!.delta).toBe(round2(150000 - 350000));
    expect(v[0]!.linkBasis).toBe("taxable-rate");
    expect(v[0]!.gross).toBe(150000);
    // the 4000 tax matches no rate and no reference -> approximate -> no value row
    expect(v.some((r) => r.tax === 4000)).toBe(false);
  });
  it("booksded rows are exactly the unmatched books deductions", () => {
    const rows = buildBillRows(res, facts, f, opts);
    expect(rows.filter((r) => r.kind === "booksded")).toHaveLength(1);
  });
  it("partyTxsOf filters by (kind, nameKey)", () => {
    expect(partyTxsOf(file([
      tx({}), { ...tx({}), kind: "tcs" as const, nameKey: canonicalKey("Beta Ltd") }, tx({ tax: 1000 }),
    ]), "tds", ALPHA)).toHaveLength(2);
  });
});
