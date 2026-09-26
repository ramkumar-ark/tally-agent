// src/as26-bill.ts — bill-level drill-down rows for the 26AS reconciliation.
// PURE: no masking here; the session masks parties/refs before anything leaves
// the gateway. Dates are raw YYYYMMDD — displayDate runs at the session
// boundary, never inside the builder.
import {
  round2, AS26_TAX_TOLERANCE, AS26_VALUE_TOLERANCE,
  type BooksFacts, type BooksSale, type BooksDeduction, type As26Result,
} from "./as26.js";
import { lawOf } from "./tds-law.js";
import type { As26File, As26Kind, As26Transaction } from "./as26-file.js";

export type BillKind = "booksded" | "as26" | "value";
export type LinkBasis = "reference" | "taxable-rate" | "invoice-rate" | "approximate" | "none";

export interface BillRow {
  kind: BillKind; ledgerKey: string; nameKey: string;
  date: string; tax: number;
  voucherType: string | null; ref: string | null;
  gross: number | null; status: string | null;
  /** booksded: the party's unique summary section, else null; as26/value:
   * the transaction's own section. Never re-derived downstream. */
  section: string | null;
  inWindow: boolean; linkBasis: LinkBasis;
  linked: { date: string; ref: string | null; taxable: number } | null;
  delta: number | null;
}

/** All detailed-sheet transactions of one (kind, nameKey) party. */
export function partyTxsOf(file: As26File, kind: As26Kind, nameKey: string): As26Transaction[] {
  return file.transactions.filter((t) => t.kind === kind && t.nameKey === nameKey);
}

import { claimedTdsCapacity, linkInvoice, linkInvoiceWithCapacity, normalizeAs26Section } from "./as26.js";
export { linkInvoice, linkInvoiceWithCapacity, normalizeAs26Section };

const inWindow = (d: string, o: { fromDate: string; toDate: string }): boolean =>
  d >= o.fromDate && d <= o.toDate;

/**
 * Drill-down rows from an analyzed 26AS run: one books row per unmatched books
 * deduction, one as26 row per unmatched 26AS transaction, and a value row for
 * every 26AS transaction of a matched party whose link is non-approximate and
 * whose value misses the books invoice beyond AS26_VALUE_TOLERANCE. Only
 * value rows carry delta; every row carries linkBasis, and `linked` is null
 * iff linkBasis is "none". The party's sale pool is the WHOLE mapped group.
 */
export function buildBillRows(
  result: As26Result, facts: BooksFacts, file: As26File,
  opts: { fromDate: string; toDate: string },
): BillRow[] {
  const salesByLedger = new Map<string, BooksSale[]>();
  for (const s of facts.sales) {
    const arr = salesByLedger.get(s.ledgerKey);
    if (arr) arr.push(s); else salesByLedger.set(s.ledgerKey, [s]);
  }

  const poolOf = (ledgerKeys: string[]): BooksSale[] =>
    ledgerKeys.flatMap((k) => salesByLedger.get(k) ?? []);

  const rows: BillRow[] = [];

  for (const r of result.recon) {
    // Totals-only parties (design §12.1) get no drill-down rows: their
    // entries stay off "Books not in 26AS" / "26AS unmatched" / value rows.
    if (r.totalsOnly) continue;
    const pool = poolOf(r.match.ledgerKeys);
    const keySet = new Set(r.match.ledgerKeys);
    const secs = new Set(
      file.summaries
        .filter((s) => s.kind === r.match.kind && s.nameKey === r.match.as26NameKey)
        .map((s) => s.section),
    );
    const section = secs.size === 1 ? [...secs][0] : null;
    // Capacity claimed by strong links (addendum 7), from ALL party entries.
    const claimed = claimedTdsCapacity(
      pool,
      facts.deductions
        .filter((d) => keySet.has(d.ledgerKey) && d.kind === r.match.kind)
        .map((d) => ({ date: d.date, tax: d.tax, reference: d.reference, ledgerKey: d.ledgerKey })),
      section,
    );
    const linkOf = (tax: number, date: string, reference: string | null, ledgerKey?: string) =>
      linkInvoiceWithCapacity(pool, { date, tax, reference, section, ledgerKey }, claimed);

    for (const i of r.unmatchedBooks) {
      const d: BooksDeduction | undefined = i.dedIdx !== undefined ? facts.deductions[i.dedIdx] : undefined;
      if (!d) continue;
      const link = linkOf(d.tax, d.date, d.reference, d.ledgerKey);
      rows.push({
        kind: "booksded", ledgerKey: d.ledgerKey, nameKey: r.match.as26NameKey,
        date: d.date, tax: d.tax, voucherType: d.voucherType || null, ref: d.voucherNumber,
        gross: null, status: null, section, inWindow: inWindow(d.date, opts),
        linkBasis: link ? link.basis : "none",
        linked: link ? { date: link.sale.date, ref: link.sale.ref, taxable: link.sale.taxable } : null,
        delta: null,
      });
    }

    for (const i of r.unmatchedAs26) {
      const led = r.match.ledgerKeys[0] ?? "";
      const date = i.date;
      // Section for the rate steps is the transaction's own section (A2);
      // txIdx indexes the party's filtered transaction list.
      const tx = i.txIdx !== undefined
        ? partyTxsOf(file, r.match.kind, r.match.as26NameKey)[i.txIdx]
        : undefined;
      const link = linkOf(i.tax, date, null);
      rows.push({
        kind: "as26", ledgerKey: led, nameKey: r.match.as26NameKey,
        date, tax: i.tax, voucherType: null, ref: null,
        gross: i.gross ?? null, status: i.status ?? null, section: tx?.section ?? null,
        inWindow: inWindow(date, opts),
        linkBasis: link ? link.basis : "none",
        linked: link ? { date: link.sale.date, ref: link.sale.ref, taxable: link.sale.taxable } : null,
        delta: null,
      });
    }
  }

  for (const r of result.recon) {
    if (r.totalsOnly) continue;
    const pool = poolOf(r.match.ledgerKeys);
    const keySet = new Set(r.match.ledgerKeys);
    const claimed = claimedTdsCapacity(
      pool,
      facts.deductions
        .filter((d) => keySet.has(d.ledgerKey) && d.kind === r.match.kind)
        .map((d) => ({ date: d.date, tax: d.tax, reference: d.reference, ledgerKey: d.ledgerKey })),
      (() => {
        const secs = new Set(
          file.summaries
            .filter((s) => s.kind === r.match.kind && s.nameKey === r.match.as26NameKey)
            .map((s) => s.section),
        );
        return secs.size === 1 ? [...secs][0] : null;
      })(),
    );
    for (const t of partyTxsOf(file, r.match.kind, r.match.as26NameKey)) {
      const date = t.bookingDate || t.date;
      const link = linkInvoiceWithCapacity(pool, { date, tax: t.tax, reference: null, section: t.section }, claimed);
      if (!link || link.basis === "approximate") continue;
      const delta = round2(t.amount - link.sale.taxable);
      if (Math.abs(delta) <= AS26_VALUE_TOLERANCE) continue;
      rows.push({
        kind: "value", ledgerKey: r.match.ledgerKeys[0] ?? "", nameKey: r.match.as26NameKey,
        date, tax: t.tax, voucherType: null, ref: null,
        gross: t.amount, status: t.status || null, section: t.section,
        inWindow: inWindow(date, opts),
        linkBasis: link.basis,
        linked: { date: link.sale.date, ref: link.sale.ref, taxable: link.sale.taxable },
        delta,
      });
    }
  }

  return rows;
}
