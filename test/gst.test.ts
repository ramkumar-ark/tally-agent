import { describe, expect, it } from "vitest";
import type { VoucherEntry, VoucherRow } from "../src/downstream.js";
import { gstBooks, gstHeadOf, gstMismatch, GstCtx } from "../src/gst.js";
import type { ReturnRow } from "../src/returns.js";
import { GST_TOLERANCE } from "../src/types.js";

/**
 * A tiny deterministic world: parties P1 (GSTIN G1, Sundry Debtors) and
 * P2 (no GSTIN, Sundry Creditors). Amounts follow the parser's convention:
 * VoucherEntry.amount is positive = debit.
 */
const G1 = "27AAAAA0000A1Z5";
const ctx: GstCtx = {
  groupOf: (l) =>
    l === "P1" ? "Sundry Debtors" : l === "P2" ? "Sundry Creditors" : l === "Sales" ? "Sales Accounts" : l === "Purchase" ? "Purchase Accounts" : "Duties & Taxes",
  rootOf: (g) =>
    g === "Sales Accounts" ? "Sales Accounts" : g === "Purchase Accounts" ? "Purchase Accounts" : null,
  roleOf: (g) => (g === "Sundry Debtors" ? "debtor" : g === "Sundry Creditors" ? "creditor" : "duties"),
  inDutiesAndTaxes: (g) => g.includes("Duties"),
  gstinOf: (l) => (l === "P1" ? G1 : null),
};

const v = (entries: VoucherEntry[], party = "", extra: Partial<VoucherRow> = {}): VoucherRow => ({
  date: "20260115",
  voucherType: "Sales",
  voucherNumber: "S/1",
  partyLedgerName: party,
  cancelled: false,
  entries,
  ...extra,
});

describe("gstHeadOf", () => {
  it("buckets by keyword, specific heads first, SGST/UTGST merged, non-GST names null", () => {
    expect(gstHeadOf("Input CGST")).toBe("CGST");
    expect(gstHeadOf("Output IGST")).toBe("IGST");
    expect(gstHeadOf("Output SGST")).toBe("SGST/UTGST");
    expect(gstHeadOf("UTGST payable")).toBe("SGST/UTGST");
    expect(gstHeadOf("Cess on lux goods")).toBe("CESS");
    expect(gstHeadOf("GST Rounding")).toBe("GST-OTHER");
    expect(gstHeadOf("TDS Receivable")).toBeNull();
    expect(gstHeadOf("Rent")).toBeNull();
  });
});

describe("gstBooks", () => {
  it("buckets a sale: positive=debit convention makes output tax a credit line", () => {
    const books = gstBooks(
      [
        // Normal Tally sale layout, after the parser flip: the party is
        // debited (positive), revenue and output tax are credited (negative).
        v(
          [
            { ledger: "P1", amount: 1180 },
            { ledger: "Sales", amount: -1000 },
            { ledger: "Output CGST", amount: -90 },
            { ledger: "Output SGST", amount: -90 },
          ],
          "P1",
        ),
      ],
      ctx,
    );
    expect(books.vouchersScanned).toBe(1);
    expect(books.heads.CGST.output).toBe(90);
    expect(books.heads.CGST.input).toBe(0);
    const outward = books.byKind.outward.withGstin;
    expect(outward).toHaveLength(1);
    expect(outward[0]).toMatchObject({ party: "P1", gstin: G1, taxableValue: 1000 });
    expect(outward[0].heads.CGST).toBe(90); // outward contribution is signed credit
  });

  it("buckets a purchase as inward with input tax credits and the purchase party", () => {
    const books = gstBooks(
      [
        v(
          [
            { ledger: "Purchase", amount: 1000 },
            { ledger: "Input CGST", amount: 90 },
            { ledger: "Input SGST", amount: 90 },
            { ledger: "P1", amount: -1180 },
          ],
          "P1",
        ),
      ],
      ctx,
    );
    expect(books.heads.CGST.input).toBe(90);
    expect(books.byKind.inward.withGstin[0].taxableValue).toBe(1000);
    expect(books.byKind.inward.withGstin[0].heads.CGST).toBe(90);
  });

  it("skips cancelled vouchers and date-less re-filtered rows contributed nothing", () => {
    const books = gstBooks(
      [
        v(
          [
            { ledger: "Sales", amount: -1000 },
            { ledger: "Output CGST", amount: -90 },
          ],
          "P1",
          { cancelled: true },
        ),
      ],
      ctx,
    );
    expect(books.vouchersScanned).toBe(0);
    expect(books.cancelledSkipped).toBe(1);
    expect(books.heads.CGST.output).toBe(0);
  });

  it("a party line carries no taxable value; a rate markup test drives GST-OTHER to the other head", () => {
    const books = gstBooks(
      [
        v(
          [
            { ledger: "Sales", amount: -2000 },
            { ledger: "GST Rounding", amount: -5 },
          ],
          "P1",
        ),
      ],
      ctx,
    );
    expect(books.heads["GST-OTHER"].output).toBe(5);
    expect(books.taxLedgers).toHaveLength(1);
    expect(books.taxLedgers[0]).toMatchObject({
      ledger: "GST Rounding",
      group: "Duties & Taxes",
      output: 5,
    });
  });

  it("attributes tax and taxable value to party P2 even without a GSTIN, and shares a GSTIN across ledgers", () => {
    const books = gstBooks(
      [
        v(
          [
            { ledger: "Sales", amount: -500 },
            { ledger: "Output CGST", amount: -45 },
            { ledger: "P2", amount: 545 },
          ],
          "P2",
        ),
        // Second ledger of the same GSTIN: merges into one party row.
        {
          ...v(
            [
              { ledger: "Sales", amount: -100 },
              { ledger: "Output CGST", amount: -9 },
              { ledger: "P1", amount: 109 },
            ],
            "P1",
          ),
        },
      ],
      ctx,
    );
    expect(books.byKind.outward.withoutGstin).toHaveLength(1);
    expect(books.byKind.outward.withGstin).toHaveLength(1);
    expect(books.byKind.outward.withGstin[0].party).toBe("P1");
    expect(books.byKind.outward.withGstin[0].heads.CGST).toBe(9);
    expect(books.byKind.outward.withGstin[0].taxableValue).toBe(100);
    expect(books.byKind.outward.withoutGstin[0].party).toBe("P2");
    expect(books.byKind.outward.withoutGstin[0].taxableValue).toBe(500);
  });

  it("a mixed-voucher or partyless GST entry lands in unattributed, never inventing a party row", () => {
    const books = gstBooks(
      [
        // No party header, no debtor/creditor role on entries: unattributed.
        v([
          { ledger: "Sales", amount: -50 },
          { ledger: "Output CGST", amount: -5 },
        ]),
        // Touches both roots: kindless.
        v(
          [
            { ledger: "Sales", amount: -50 },
            { ledger: "Purchase", amount: 50 },
            { ledger: "Output CGST", amount: -5 },
          ],
          "P1",
        ),
      ],
      ctx,
    );
    expect(books.byKind.outward.withGstin).toHaveLength(0);
    expect(books.unattributed.CGST.output).toBe(10);
  });

  it("the party fallback anchors a partyless header to the role ledger", () => {
    const books = gstBooks(
      [
        v([
          { ledger: "Sales", amount: -100 },
          { ledger: "P1", amount: 118 },
          { ledger: "Output CGST", amount: -9 },
        ]),
      ],
      ctx,
    );
    expect(books.byKind.outward.withGstin).toHaveLength(1);
    expect(books.byKind.outward.withGstin[0].party).toBe("P1");
    expect(books.byKind.outward.withGstin[0].taxableValue).toBe(100);
  });
});

describe("gstBooks tolerance discipline", () => {
  it("GST_TOLERANCE is the half-rupee-portal rounding band", () => {
    expect(GST_TOLERANCE).toBe(1.0);
  });
});

const ret = (over: Partial<ReturnRow> = {}): ReturnRow => ({
  gstin: G1,
  partyName: "Acme Traders",
  kind: "outward",
  taxableValue: 1000,
  cgst: 45.5,
  sgst: 0,
  igst: 0,
  cess: 0,
  ...over,
});

describe("gstMismatch", () => {
  const booksOf = (cgst: number): GstBooks =>
    gstBooks(
      [
        v(
          [
            { ledger: "Sales", amount: -1000 },
            { ledger: "Output CGST", amount: -cgst },
            { ledger: "P1", amount: 100 },
          ],
          "P1",
        ),
      ],
      ctx,
    );

  it("fires gst_amount_mismatch beyond tolerance and names the party and tax id in the finding", () => {
    const { findings } = gstMismatch(booksOf(90), [ret({ cgst: 45.5 })]);
    const f = findings.find((x) => x.check === "gst_amount_mismatch")!;
    expect(f.id).toMatch(/^GST-001-\d+$/);
    expect(f.severity).toBe("warning");
    expect(f.party).toBe("P1");
    expect(f.gstin).toBe(G1);
    expect(f.detail).toContain("P1 (27AAAAA0000A1Z5)");
  });

  it("stays silent at and inside the tolerance band: book 46.99 vs return 46 at 0.99 over", () => {
    const { findings } = gstMismatch(booksOf(46.99), [ret({ cgst: GST_TOLERANCE + 44.99 })]);
    expect(findings).toHaveLength(0);
  });

  it("fires when the difference crosses by a paisa: 0.01 beyond the band", () => {
    const { findings } = gstMismatch(booksOf(47.01), [ret({ cgst: 45 })]);
    expect(findings.some((f) => f.check === "gst_amount_mismatch")).toBe(true);
  });

  it("skips rows whose tax total is within tolerance (nothing to file, nothing to dispute)", () => {
    // Book P2 has no GSTIN; its tax 45.5 <= no, give it tax under tolerance.
    const books = gstBooks(
      [
        v(
          [
            { ledger: "Sales", amount: -100 },
            { ledger: "Output CGST", amount: -0.5 },
            { ledger: "P1", amount: -100.5 },
          ],
          "P1",
        ),
      ],
      ctx,
    );
    const { findings } = gstMismatch(books, []);
    expect(findings.some((f) => f.check === "gst_books_not_in_return")).toBe(false);
  });

  it("deterministic generation order: outward kind first, checks in ordinal order within a kind", () => {
    const books = gstBooks(
      [
        v(
          [
            { ledger: "Sales", amount: -1000 },
            { ledger: "Output CGST", amount: -90 },
            { ledger: "P2", amount: 1090 },
          ],
          "P2",
        ),
        v(
          [
            { ledger: "Sales", amount: -500 },
            { ledger: "Output CGST", amount: -45 },
            { ledger: "P1", amount: 545 },
          ],
          "P1",
        ),
      ],
      ctx,
    );
    const { findings } = gstMismatch(books, [
      ret({ gstin: "22PPPPP7777P1Z8", kind: "outward", cgst: 20, sgst: 0, taxableValue: 100 }),
      ret({ cgst: 10, sgst: 10, taxableValue: 300 }),
    ]);
    // P2 (no gstin) → gst_party_without_gstin; G2 in return not in books ...
    // The check ids must be strictly ordered by kind (outward before inward)
    // and, within a kind, GST_CHECK_ORDINAL order.
    expect(
      findings.filter((f) => f.kind === "outward").map((f) => Number(f.id.split("-")[1])),
    ).toEqual([...findings.filter((f) => f.kind === "outward").map((f) => Number(f.id.split("-")[1]))].sort());
    expect(findings.some((f) => f.check === "gst_return_not_in_books" && f.kind === "outward")).toBe(true);
    expect(findings.some((f) => f.check === "gst_party_without_gstin")).toBe(true);
  });
});
