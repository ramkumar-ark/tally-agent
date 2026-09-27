import { describe, expect, it } from "vitest";
import { CHECK_ORDINAL, findingId } from "../src/types.js";

describe("gst44 check ids", () => {
  it("occupy ordinals 15-18 without disturbing the existing space", () => {
    expect(CHECK_ORDINAL.gst44_composition_unknown).toBe(15);
    expect(CHECK_ORDINAL.gst44_unattributed_expenditure).toBe(16);
    expect(CHECK_ORDINAL.gst44_party_not_in_masters).toBe(17);
    expect(CHECK_ORDINAL.gst44_status_override_unknown_ledger).toBe(18);
    expect(CHECK_ORDINAL.pf_esi_due_date_not_working_day).toBe(14);
    expect(findingId("gst44_composition_unknown", 1)).toBe("TB-015-1");
  });
});

import { EMPTY_GST44, gst44, partySpend, statusOf, type OperatorGst44 } from "../src/gst44.js";
import type { GstCtx } from "../src/gst.js";
import type { VoucherRow } from "../src/downstream.js";

const ctxOf = (gstins: Record<string, string>): GstCtx => ({
  groupOf: (ledger) => groupOf[ledger] ?? "",
  rootOf: (group) => roots[group] ?? null,
  roleOf: (group) => (group === "Sundry Creditors" ? "creditor" : "other"),
  inDutiesAndTaxes: (group) => group === "Duties & Taxes" || roots[group] === "Duties & Taxes",
  gstinOf: (ledger) => gstins[ledger] ?? null,
});
const groupOf: Record<string, string> = {
  "Rental A/c": "Indirect Expenses", "Site Materials": "Purchase Accounts",
  "JCB Purchased": "JCB", "Input IGST A/c": "Input GST",
  "Nova Traders": "Sundry Creditors", "Orchid Suppliers": "Sundry Creditors",
  "Prime Haulage": "Sundry Creditors", "Bank A/c": "Bank Accounts",
};
const roots: Record<string, string> = {
  "Indirect Expenses": "Indirect Expenses", "Purchase Accounts": "Purchase Accounts",
  JCB: "Fixed Assets", "Input GST": "Duties & Taxes",
  "Sundry Creditors": "Sundry Creditors", "Bank Accounts": "Bank Accounts",
};
const GSTIN_REG = "27AAAAA0000A1Z5";
const v = (party: string | null, entries: Array<[string, number]>): VoucherRow => ({
  date: "20250401", voucherType: "PURCHASE", voucherNumber: "P1",
  partyLedgerName: party ?? "", cancelled: false,
  entries: entries.map(([ledger, amount]) => ({ ledger, amount })),
});

describe("statusOf precedence", () => {
  it("override wins over everything", () => {
    const r = statusOf("Nova Traders", true, ctxOf({ "Nova Traders": GSTIN_REG }), new Map([["nova traders", "composition"]]));
    expect(r).toEqual({ status: "composition", ambiguous: false, override: true });
  });
  it("gstin + tax charged -> others; no ambiguity", () => {
    expect(statusOf("Nova Traders", true, ctxOf({ "Nova Traders": GSTIN_REG }), new Map())).toEqual({ status: "others", ambiguous: false, override: false });
  });
  it("gstin + no tax -> exempt, flagged ambiguous", () => {
    expect(statusOf("Nova Traders", false, ctxOf({ "Nova Traders": GSTIN_REG }), new Map())).toEqual({ status: "exempt", ambiguous: true, override: false });
  });
  it("no gstin -> unregistered", () => {
    expect(statusOf("Nova Traders", false, ctxOf({}), new Map())).toEqual({ status: "unregistered", ambiguous: false, override: false });
  });
});

describe("gst44 walk", () => {
  it("buckets a taxed purchase from a registered party into others (revenue row)", () => {
    const books = gst44([
      v("Nova Traders", [["Site Materials", 100000], ["Input IGST A/c", 18000], ["Nova Traders", -118000]]),
    ], ctxOf({ "Nova Traders": GSTIN_REG }), EMPTY_GST44);
    expect(books.rows[1]).toMatchObject({ label: "Revenue Expenditure", others: 100000, exempt: 0, composition: 0, unregistered: 0, total: 100000 });
    expect(books.rows[0].total).toBe(0);
  });
  it("fixed-asset debits land in the capital row and ignore party", () => {
    const books = gst44([
      v("Nova Traders", [["JCB Purchased", 500000], ["Input IGST A/c", 90000], ["Nova Traders", -590000]]),
    ], ctxOf({ "Nova Traders": GSTIN_REG }), EMPTY_GST44);
    expect(books.rows[0]).toMatchObject({ label: "Capital Expenditure", others: 500000, total: 500000 });
    expect(books.rows[1].total).toBe(0);
  });
  it("registered party, no tax charged -> exempt bucket + one ambiguity finding", () => {
    const books = gst44([
      v("Orchid Suppliers", [["Site Materials", 60000], ["Orchid Suppliers", -60000]]),
      v("Orchid Suppliers", [["Rental A/c", 5000], ["Orchid Suppliers", -5000]]),
    ], ctxOf({ "Orchid Suppliers": GSTIN_REG }), EMPTY_GST44);
    expect(books.rows[1].exempt).toBe(65000);
    const amb = books.findings.filter((f) => f.check === "gst44_composition_unknown");
    expect(amb).toHaveLength(1);
    expect(amb[0].ledger).toBe("Orchid Suppliers");
    expect(amb[0].amount).toBe(65000);
  });
  it("no gstin -> unregistered bucket, no ambiguity finding", () => {
    const books = gst44([v("Prime Haulage", [["Rental A/c", 30000], ["Prime Haulage", -30000]])], ctxOf({}), EMPTY_GST44);
    expect(books.rows[1].unregistered).toBe(30000);
    expect(books.findings.filter((f) => f.check === "gst44_composition_unknown")).toHaveLength(0);
  });
  it("operator composition override fills the composition bucket and silences ambiguity", () => {
    const operator: OperatorGst44 = { statuses: [{ ledger: "Orchid Suppliers", status: "composition" }] };
    const books = gst44([v("Orchid Suppliers", [["Site Materials", 60000], ["Orchid Suppliers", -60000]])], ctxOf({ "Orchid Suppliers": GSTIN_REG }), operator);
    expect(books.rows[1].composition).toBe(60000);
    expect(books.findings.filter((f) => f.check === "gst44_composition_unknown")).toHaveLength(0);
  });
  it("expenditure without any party is unattributed and raises a finding, not a bucket", () => {
    const books = gst44([v(null, [["Rental A/c", 12000], ["Bank A/c", -12000]])], ctxOf({}), EMPTY_GST44);
    // The books total still carries it (C5); only the split columns are empty.
    expect(books.rows[1].total).toBe(12000);
    expect(books.rows[1].exempt + books.rows[1].composition + books.rows[1].others + books.rows[1].unregistered).toBe(0);
    expect(books.unattributed).toEqual({ capital: 0, revenue: 12000, events: 1 });
    expect(books.findings.filter((f) => f.check === "gst44_unattributed_expenditure")).toHaveLength(1);
  });
  it("cancelled vouchers are skipped; gst-ledger lines are never expenditure", () => {
    const books = gst44([
      { ...v("Nova Traders", [["Rental A/c", 100]]), cancelled: true },
      v("Nova Traders", [["Input IGST A/c", 5000], ["Nova Traders", -5000]]),
    ], ctxOf({ "Nova Traders": GSTIN_REG }), EMPTY_GST44);
    expect(books.cancelledSkipped).toBe(1);
    expect(books.vouchersScanned).toBe(1);
    expect(books.rows.reduce((s, r) => s + r.total, 0)).toBe(0);
  });
  it("mixed evidence splits a party across buckets per voucher", () => {
    const books = gst44([
      v("Nova Traders", [["Site Materials", 100000], ["Input IGST A/c", 18000], ["Nova Traders", -118000]]),
      v("Nova Traders", [["Rental A/c", 4000], ["Nova Traders", -4000]]),
    ], ctxOf({ "Nova Traders": GSTIN_REG }), EMPTY_GST44);
    expect(books.rows[1].others).toBe(100000);
    expect(books.rows[1].exempt).toBe(4000);
    const p = books.parties.find((x) => x.party === "Nova Traders")!;
    expect(partySpend(p)).toBe(104000);
    expect(p.ambiguous).toBe(true);
    expect(p.gstinKnown).toBe(true);
    expect(p.group).toBe("Sundry Creditors");
  });
  it("party missing from the masters raises gst44_party_not_in_masters", () => {
    const books = gst44([v("Ghost Vendor", [["Rental A/c", 7000], ["Ghost Vendor", -7000]])], ctxOf({}), EMPTY_GST44);
    // "Ghost Vendor" has no groupOf entry -> group "" -> not in masters.
    expect(books.findings.some((f) => f.check === "gst44_party_not_in_masters" && f.ledger === "Ghost Vendor")).toBe(true);
  });
});
