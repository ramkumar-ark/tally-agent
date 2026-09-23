import { readFileSync } from "node:fs";
import { canonicalKey } from "./key.js";
import type { As26File, As26Kind } from "./as26-file.js";

export interface BooksDeduction { ledgerKey: string; kind: As26Kind; date: string; tax: number; voucherType: string; }
export interface BooksSale { ledgerKey: string; date: string; ref: string | null; taxable: number; gross: number; }
export interface BooksFacts { deductions: BooksDeduction[]; sales: BooksSale[]; }

export interface PartyMatch {
  ledgerKey: string; ledgerName: string;
  as26NameKey: string; as26Name: string;
  kind: As26Kind; source: "operator";
}
export interface As26Gap { kind: As26Kind; nameKey: string; name: string; tax: number; ledger?: string; reason: "unmapped" | "ambiguous" | "ledger-absent" | "name-absent"; }

export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Stage-1 party matching — mapping-only policy (captain deviation): operator
 * entries join exactly; unmapped names and ledgers surface as gaps, never
 * auto-matched. Canonical collisions cannot arise where there is no fallback. */
export function matchParties(
  file: As26File, facts: BooksFacts, map: As26Map, ledgerNames: string[],
): { matches: PartyMatch[]; gaps: As26Gap[] } {
  const matches: PartyMatch[] = [];
  const gaps: As26Gap[] = [];
  const ledgerByKey = new Map(ledgerNames.map((n) => [canonicalKey(n), n]));
  const matchedLedgerKeys = new Set<string>();
  const matchedNameKeys = new Set<string>();

  const deductors = new Map<string, { kind: As26Kind; nameKey: string; name: string; tax: number }>();
  for (const s of file.summaries) {
    const k = `${s.kind}|${s.nameKey}`;
    const d = deductors.get(k);
    if (d) d.tax = round2(d.tax + s.taxTotal);
    else deductors.set(k, { kind: s.kind, nameKey: s.nameKey, name: s.name, tax: s.taxTotal });
  }

  for (const m of map.mappings) {
    const lk = canonicalKey(m.ledger), nk = canonicalKey(m.as26Name);
    const ledger = ledgerByKey.get(lk);
    const summary = file.summaries.find((s) => s.nameKey === nk);
    const kind: As26Kind = summary?.kind ?? "tds";
    if (!ledger) {
      gaps.push({ kind, nameKey: nk, name: m.as26Name, tax: summary?.taxTotal ?? 0, ledger: m.ledger, reason: "ledger-absent" });
      continue;
    }
    if (!summary) {
      gaps.push({ kind, nameKey: nk, name: m.as26Name, tax: 0, ledger: m.ledger, reason: "name-absent" });
      continue;
    }
    matchedLedgerKeys.add(lk);
    matchedNameKeys.add(`${summary.kind}|${nk}`);
    matches.push({ ledgerKey: lk, ledgerName: m.ledger, as26NameKey: nk, as26Name: m.as26Name, kind: summary.kind, source: "operator" });
  }

  for (const d of deductors.values()) {
    if (matchedNameKeys.has(`${d.kind}|${d.nameKey}`)) continue;
    gaps.push({ kind: d.kind, nameKey: d.nameKey, name: d.name, tax: d.tax, reason: "unmapped" });
  }
  const dedTax = new Map<string, { tax: number; kind: As26Kind }>();
  for (const e of facts.deductions) {
    if (matchedLedgerKeys.has(e.ledgerKey)) continue;
    const acc = dedTax.get(e.ledgerKey);
    if (acc) acc.tax = round2(acc.tax + e.tax);
    else dedTax.set(e.ledgerKey, { tax: e.tax, kind: e.kind });
  }
  for (const [ledgerKey, acc] of dedTax) {
    const name = ledgerByKey.get(ledgerKey) ?? ledgerKey;
    gaps.push({ kind: acc.kind, nameKey: ledgerKey, name, tax: acc.tax, ledger: name, reason: "unmapped" });
  }
  return { matches, gaps };
}

export interface As26MapEntry { ledger: string; as26Name: string; }
export interface As26Map { mappings: As26MapEntry[]; }
export const EMPTY_AS26_MAP: As26Map = { mappings: [] };

/**
 * The persistent operator party mapping — the overrides.json precedent: a
 * missing file is legitimate (matching proceeds mapping-only), malformed JSON
 * or a malformed entry throws, and every error cites the entry index because
 * a mapping the operator believes is in force must never be skipped quietly.
 * Values are never echoed: they are company names.
 */
export function loadAs26Map(path: string, warn?: (why: string) => void): As26Map {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: unknown) {
    warn?.((e as NodeJS.ErrnoException)?.code ?? "unreadable");
    return EMPTY_AS26_MAP;
  }
  let raw: { mappings?: Array<{ ledger?: unknown; as26Name?: unknown }> };
  try {
    raw = JSON.parse(text) as { mappings?: Array<{ ledger?: unknown; as26Name?: unknown }> };
  } catch {
    throw new Error("as26-map: malformed JSON");
  }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.mappings)) {
    throw new Error("as26-map: malformed JSON — expected an object with a mappings array");
  }
  const mappings: As26MapEntry[] = [];
  const seenLedger = new Set<string>();
  const seenName = new Set<string>();
  (raw.mappings ?? []).forEach((m, i) => {
    const ledger = typeof m.ledger === "string" ? m.ledger.trim() : "";
    const as26Name = typeof m.as26Name === "string" ? m.as26Name.trim() : "";
    if (!ledger || !as26Name) {
      throw new Error(`as26-map entry ${i + 1}: "ledger" and "as26Name" must both be non-empty strings`);
    }
    const lk = canonicalKey(ledger), nk = canonicalKey(as26Name);
    if (seenLedger.has(lk) || seenName.has(nk)) {
      throw new Error(`as26-map entry ${i + 1}: maps a ledger or 26AS name already mapped earlier in the file`);
    }
    seenLedger.add(lk); seenName.add(nk);
    mappings.push({ ledger, as26Name });
  });
  return { mappings };
}

// --- Task 6: books facts helpers ---

import type { LedgerVoucherRow, VoucherRow } from "./downstream.js";
import { kindOf, partyOf, gstHeadOf } from "./gst.js";
import type { GstCtx } from "./gst.js";

/** Deduction events from month-chunked Ledger Vouchers of the TDS/TCS
 * receivable ledger(s). Debits only — a credit row is a refund entry, which
 * is counted (visible) but never silently netted. */
export function deductionEvents(rows: LedgerVoucherRow[], kind: As26Kind): { events: BooksDeduction[]; credits: number } {
  const events: BooksDeduction[] = [];
  let credits = 0;
  for (const r of rows) {
    if (r.amount > 0) {
      events.push({
        ledgerKey: canonicalKey(r.counterparty),
        kind,
        date: r.date,
        tax: round2(r.amount),
        voucherType: r.voucherType,
      });
    } else if (r.amount < 0) {
      credits += 1;
    }
  }
  return { events, credits };
}

/** Per-party sales + invoice refs from the period's day book (sale and
 * deduction are separate vouchers — the join is party+period). One
 * BooksSale per outward voucher; that is per-invoice evidence, which
 * check 001's schedule needs. */
export function booksSales(vouchers: VoucherRow[], ctx: GstCtx): BooksSale[] {
  const sales: BooksSale[] = [];
  for (const v of vouchers) {
    if (v.cancelled) continue;
    const kind = kindOf(v, ctx);
    if (kind !== "outward") continue;
    const party = partyOf(v, kind, ctx);
    if (!party) continue;
    let taxable = 0;
    let gross = 0;
    for (const e of v.entries) {
      const group = ctx.groupOf(e.ledger);
      if (ctx.rootOf(group) === "Sales Accounts") {
        // positive=debit: an outward sale sits as a credit line
        taxable += -e.amount;
      } else if (ctx.inDutiesAndTaxes(group) && gstHeadOf(e.ledger) && e.amount < 0) {
        gross += -e.amount;
      }
    }
    sales.push({
      ledgerKey: canonicalKey(party),
      date: v.date,
      ref: v.voucherNumber || null,
      taxable: round2(taxable),
      gross: round2(gross + taxable),
    });
  }
  return sales;
}

/** Receivable ledgers by name heuristic under an asset root; kind by name.
 * None ⇒ empty array — the wiring turns that into a hard operator-facing
 * error rather than a silent zero. */
export function receivableLedgers(
  ledgers: Array<{ name: string; parent: string }>,
  isAssetRoot: (group: string) => boolean,
): Array<{ name: string; kind: As26Kind }> {
  const parentOf = new Map(ledgers.map((l) => [canonicalKey(l.name), l.parent]));
  const underAssetRoot = (name: string): boolean => {
    let seen = new Set<string>();
    let p: string | undefined = parentOf.get(canonicalKey(name));
    while (p && !seen.has(p)) {
      seen.add(p);
      if (isAssetRoot(p)) return true;
      p = parentOf.get(canonicalKey(p));
    }
    return false;
  };
  const out: Array<{ name: string; kind: As26Kind }> = [];
  for (const l of ledgers) {
    const n = canonicalKey(l.name);
    if (!/(tds|tcs)/.test(n)) continue;
    if (!/receivable/i.test(n)) continue;
    if (!underAssetRoot(l.name)) continue;
    out.push({ name: l.name, kind: n.includes("tcs") ? "tcs" : "tds" });
  }
  return out;
}

// --- Task 7: stage-2 reconciliation core ---

export const AS26_TAX_TOLERANCE = 1.0;
export const AS26_VALUE_TOLERANCE = 1000.0;
export const COMBINATION_MAX_SIZE = 4;
export const COMBINATION_MAX_ITEMS = 40;

export interface ReconItem { date: string; tax: number; }

export interface PartyRecon {
  match: PartyMatch;
  booksTax: number; as26Tax: number;
  paired: Array<{ books: ReconItem; as26: ReconItem }>;
  combinations: Array<{ target: ReconItem; parts: ReconItem[]; side: "books" | "as26" }>;
  ambiguous: number;
  unmatchedBooks: ReconItem[]; unmatchedAs26: ReconItem[];
  combinationSearchSkipped: boolean;
  lateBookedTax: number;
  /** Value interpretation carried for the report's Deductors sheet
   * (books GST-exclusive / GST-inclusive totals vs 26AS gross). */
  booksTaxableValue?: number;
  booksGrossValue?: number;
  as26GrossValue?: number;
}

/** Index-combination subsets of `items` with size 2..maxSize, in index order. */
function* subsets(items: ReconItem[], maxSize: number): Generator<ReconItem[]> {
  const n = items.length;
  for (let size = 2; size <= Math.min(maxSize, n); size += 1) {
    const idx: number[] = Array.from({ length: size }, (_, i) => i);
    while (true) {
      yield idx.map((i) => items[i]);
      let k = size - 1;
      while (k >= 0 && idx[k] === n - size + k) k -= 1;
      if (k < 0) break;
      idx[k] += 1;
      for (let j = k + 1; j < size; j += 1) idx[j] = idx[j - 1] + 1;
    }
  }
}

const sumTax = (items: ReconItem[]): number => round2(items.reduce((s, i) => s + i.tax, 0));

const fits = (sum: number, target: number): boolean =>
  Math.abs(sum - target) <= AS26_TAX_TOLERANCE;

/** Stage-2 reconciliation: totals first, then unique 1:1 pairing within
 * tolerance, then a bounded combination explanation. The search never
 * mutates the totals — it only explains leftovers, honestly: more than one
 * fitting subset means the item stays unmatched and is counted ambiguous. */
export function reconcileParty(file: As26File, facts: BooksFacts, match: PartyMatch, toDate: string): PartyRecon {
  const booksItems: ReconItem[] = facts.deductions
    .filter((d) => d.ledgerKey === match.ledgerKey && d.kind === match.kind)
    .map((d) => ({ date: d.date, tax: d.tax }));
  const rows = file.transactions.filter((t) => t.kind === match.kind && t.nameKey === match.as26NameKey);
  const lateBookedTax = round2(rows
    .filter((t) => t.bookingDate && t.bookingDate > toDate)
    .reduce((s, t) => s + t.tax, 0));
  const as26Items: ReconItem[] = rows.map((t) => ({ date: t.bookingDate || t.date, tax: t.tax }));

  const booksTax = sumTax(booksItems);
  const as26Tax = sumTax(rows.map((t) => ({ date: t.date, tax: t.tax })));

  // 1:1 pairing: pair only when the candidate is unique in both directions.
  const paired: PartyRecon["paired"] = [];
  const usedBooks = new Set<number>();
  const usedAs26 = new Set<number>();
  const candCols = booksItems.map((b) =>
    as26Items.map((a, j) => (Math.abs(round2(a.tax - b.tax)) <= AS26_TAX_TOLERANCE ? j : -1)).filter((j) => j >= 0));
  const candRows = as26Items.map((a) =>
    booksItems.map((b, i) => (Math.abs(round2(a.tax - b.tax)) <= AS26_TAX_TOLERANCE ? i : -1)).filter((i) => i >= 0));
  booksItems.forEach((b, i) => {
    if (usedBooks.has(i)) return;
    const cs = candCols[i];
    if (cs.length !== 1) return;
    const j = cs[0];
    if (usedAs26.has(j) || candRows[j].length !== 1) return;
    paired.push({ books: b, as26: as26Items[j] });
    usedBooks.add(i);
    usedAs26.add(j);
  });

  let unmatchedBooks = booksItems.filter((_, i) => !usedBooks.has(i));
  let unmatchedAs26 = as26Items.filter((_, i) => !usedAs26.has(i));

  const combinations: PartyRecon["combinations"] = [];
  let ambiguous = 0;
  const searchSkipped =
    unmatchedBooks.length > COMBINATION_MAX_ITEMS || unmatchedAs26.length > COMBINATION_MAX_ITEMS;

  if (!searchSkipped) {
    const takenBooks = new Set<number>();
    const takenAs26 = new Set<number>();
    // combinations targeting a books item, parts from 26AS
    const bookTargets = unmatchedBooks.filter((_, i) => !takenBooks.has(i));
    for (const target of bookTargets) {
      const pool = unmatchedAs26.filter((_, i) => !takenAs26.has(i));
      const fitAs26: ReconItem[][] = [];
      for (const s of subsets(pool, COMBINATION_MAX_SIZE)) {
        if (fits(sumTax(s), target.tax)) fitAs26.push(s);
      }
      if (fitAs26.length === 1) {
        const parts = fitAs26[0];
        combinations.push({ target, parts, side: "books" });
        for (const p of parts) {
          const k = unmatchedAs26.findIndex((x) => x === p);
          if (k >= 0) takenAs26.add(k);
        }
        takenBooks.add(unmatchedBooks.findIndex((x) => x === target));
      } else if (fitAs26.length > 1) {
        ambiguous += 1;
      }
    }
    // combinations targeting an as26 item, parts from books
    const as26Targets = unmatchedAs26.filter((_, i) => !takenAs26.has(i));
    for (const target of as26Targets) {
      const pool = unmatchedBooks.filter((_, i) => !takenBooks.has(i));
      const fitBooks: ReconItem[][] = [];
      for (const s of subsets(pool, COMBINATION_MAX_SIZE)) {
        if (fits(sumTax(s), target.tax)) fitBooks.push(s);
      }
      if (fitBooks.length === 1) {
        const parts = fitBooks[0];
        combinations.push({ target, parts, side: "as26" });
        for (const p of parts) {
          const k = unmatchedBooks.findIndex((x) => x === p);
          if (k >= 0) takenBooks.add(k);
        }
        const t = unmatchedAs26.findIndex((x) => x === target);
        if (t >= 0) takenAs26.add(t);
      } else if (fitBooks.length > 1) {
        ambiguous += 1;
      }
    }
    unmatchedBooks = unmatchedBooks.filter((_, i) => !takenBooks.has(i));
    unmatchedAs26 = unmatchedAs26.filter((_, i) => !takenAs26.has(i));
  }

  return {
    match, booksTax, as26Tax, paired, combinations, ambiguous,
    unmatchedBooks, unmatchedAs26, combinationSearchSkipped: searchSkipped, lateBookedTax,
  };
}

// --- Task 8: stage-3 findings ---

import type { As26SummaryRow, As26Transaction } from "./as26-file.js";

export interface As26Result {
  findings: As26Finding[];
  recon: PartyRecon[];
  gaps: As26Gap[];
  totals: { booksTax: number; as26Tax: number; partiesMatched: number; combinationExplained: number; ambiguous: number };
  skipped: As26File["skipped"];
}

import { as26FindingId, type As26CheckId, type As26Finding, type As26ScheduleRow } from "./types.js";
import { money, displayDate, count } from "./format.js";

const as26KeyOf = (t: { kind: As26Kind; nameKey: string; section: string } | As26SummaryRow | As26Transaction): string =>
  `${t.kind}|${t.nameKey}|${t.section}`;

export function analyzeAs26(
  file: As26File, facts: BooksFacts, map: As26Map, ledgerNames: string[],
  opts: { fromDate: string; toDate: string },
): As26Result {
  const { matches, gaps } = matchParties(file, facts, map, ledgerNames);
  const findings: As26Finding[] = [];
  const ordinals = new Map<As26CheckId, number>();
  const nextOrd = (check: As26CheckId): number => {
    const n = (ordinals.get(check) ?? 0) + 1;
    ordinals.set(check, n);
    return n;
  };
  const push = (
    check: As26CheckId, severity: As26Finding["severity"], party: string, kind: As26Kind,
    section: string | null, amount: number, detail: string, schedule?: As26ScheduleRow[],
  ): void => {
    const f: As26Finding = { id: as26FindingId(check, nextOrd(check)), check, severity, party, kind, section, amount: round2(amount), detail };
    if (schedule && schedule.length > 0) f.schedule = schedule;
    findings.push(f);
  };
  const capSchedule = (rows: As26ScheduleRow[]): As26ScheduleRow[] => rows.slice(0, 20);

  const salesByKey = new Map<string, BooksSale[]>();
  for (const s of facts.sales) {
    if (s.gross === 0 && s.taxable === 0) continue;
    const arr = salesByKey.get(s.ledgerKey);
    if (arr) arr.push(s);
    else salesByKey.set(s.ledgerKey, [s]);
  }
  const sumSales = (rows: BooksSale[], pick: (s: BooksSale) => number): number => round2(rows.reduce((s, x) => s + pick(x), 0));

  const recons: PartyRecon[] = [];
  for (const match of matches) {
    const r = reconcileParty(file, facts, match, opts.toDate);
    recons.push(r);
    const partySales = salesByKey.get(match.ledgerKey) ?? [];
    const booksTaxable = sumSales(partySales, (s) => s.taxable);
    const booksGross = sumSales(partySales, (s) => s.gross);
    const summary = file.summaries.find((s) => s.kind === match.kind && s.nameKey === match.as26NameKey);
    const as26Gross = summary?.gross ?? 0;
    r.booksTaxableValue = booksTaxable;
    r.booksGrossValue = booksGross;
    r.as26GrossValue = as26Gross;

    // 001 — books tax beyond what 26AS declares
    const excessBooks = round2(r.booksTax - r.as26Tax);
    if (excessBooks > AS26_TAX_TOLERANCE) {
      const lateNote = r.lateBookedTax > 0
        ? `; part of this deductor's credit was booked after ${displayDate(opts.toDate)} (timing possible)`
        : "";
      const detail =
        `Books ${match.kind.toUpperCase()} tax of ${money(r.booksTax)} against 26AS tax of ${money(r.as26Tax)}` +
        (partySales.length > 0 ? `; sale invoices for the period total ${money(booksGross)}` : "") +
        lateNote;
      const schedule = capSchedule(partySales.map((s) => ({
        label: s.ref ?? displayDate(s.date), amount: s.gross, date: s.date,
      })));
      push("books_tax_not_in_26as", "critical", match.ledgerName, match.kind, summary?.section ?? null, excessBooks, detail, schedule);
    }

    // 002 — 26AS tax with no books counterpart
    const excessAs26 = round2(r.as26Tax - r.booksTax);
    if (excessAs26 > AS26_TAX_TOLERANCE) {
      const rows = file.transactions.filter((t) => t.kind === match.kind && t.nameKey === match.as26NameKey);
      const latest = rows.reduce((m, t) => (t.bookingDate && t.bookingDate > m ? t.bookingDate : m), "00000000");
      const statuses = [...new Set(rows.map((t) => t.status))].filter(Boolean).join(", ");
      const detail =
        `26AS ${match.kind.toUpperCase()} tax of ${money(r.as26Tax)} against books tax of ${money(r.booksTax)}` +
        (latest !== "00000000" ? `; latest booking date ${displayDate(latest)}` : "") +
        (statuses ? `; booking statuses seen: ${statuses}` : "");
      push("as26_tax_not_in_books", "critical", match.ledgerName, match.kind, summary?.section ?? null, excessAs26, detail);
    }

    // 003 — 26AS gross vs books value: GST-exclusive (taxable) and GST-inclusive both tried
    if (as26Gross > 0 && partySales.length > 0) {
      const dTok = Math.abs(round2(as26Gross - booksTaxable));
      const dGross = Math.abs(round2(as26Gross - booksGross));
      if (dTok > AS26_VALUE_TOLERANCE || dGross > AS26_VALUE_TOLERANCE) {
        let basis: string;
        if (dTok <= AS26_VALUE_TOLERANCE) {
          basis = `the GST-exclusive (taxable) valuation matched; the GST-inclusive books gross is out by ${money(dGross)}`;
        } else if (dGross <= AS26_VALUE_TOLERANCE) {
          basis = `matched on the GST-inclusive value; the GST-exclusive books taxable is out by ${money(dTok)}`;
        } else {
          basis = dTok <= dGross
            ? `the GST-exclusive (taxable) valuation comes closer; the GST-inclusive books gross is out by ${money(dGross)}`
            : `the GST-inclusive valuation comes closer; the GST-exclusive books taxable is out by ${money(dTok)}`;
        }
        push(
          "assessable_value_mismatch", "warning", match.ledgerName, match.kind, summary?.section ?? null,
          round2(Math.min(...[dTok, dGross].filter((d) => d > AS26_VALUE_TOLERANCE))),
          `26AS gross receipts of ${money(as26Gross)} against books taxable of ${money(booksTaxable)} and books GST-inclusive gross of ${money(booksGross)}: ${basis}.`,
        );
      }
    }

    // 007 — totals reconcile but the item-level picture is left over
    const deltaTotals = Math.abs(round2(r.booksTax - r.as26Tax));
    if (deltaTotals <= AS26_TAX_TOLERANCE &&
        (r.unmatchedBooks.length > 0 || r.unmatchedAs26.length > 0 || r.ambiguous > 0)) {
      const sumB = sumTax(r.unmatchedBooks);
      const sumA = sumTax(r.unmatchedAs26);
      const leftovers: As26ScheduleRow[] = capSchedule([
        ...r.unmatchedBooks.map((i) => ({ label: displayDate(i.date), amount: i.tax, date: i.date })),
        ...r.unmatchedAs26.map((i) => ({ label: displayDate(i.date), amount: i.tax, date: i.date })),
      ]);
      push(
        "unresolved_combination", "review", match.ledgerName, match.kind, summary?.section ?? null,
        Math.max(sumB, sumA),
        `Totals reconcile within tolerance (${money(r.booksTax)} books against ${money(r.as26Tax)} 26AS) but ` +
        `${r.unmatchedBooks.length} books item(s) and ${r.unmatchedAs26.length} 26AS item(s) stay unexplained` +
        (r.ambiguous > 0 ? ` with ${count(r.ambiguous)} ambiguous combination(s)` : "") +
        "; likely offsetting entries.",
        leftovers,
      );
    }

    // 005 — 26AS credits landed outside the reviewed window
    if (r.lateBookedTax > 0) {
      push(
        "late_booking", "review", match.ledgerName, match.kind, summary?.section ?? null, r.lateBookedTax,
        `${money(r.lateBookedTax)} of 26AS tax was booked after ${displayDate(opts.toDate)} — outside the reviewed window, so books and export totals may reconcile once the window is extended (timing possible).`,
      );
    }

    // 008 — deductions without any sale entry for the customer
    if (r.booksTax > 0 && partySales.length === 0) {
      push(
        "deduction_without_sale", "review", match.ledgerName, match.kind, summary?.section ?? null, r.booksTax,
        "Books carry the deduction but no sale entry exists for this customer in the period — the deduction may sit against a prior-period sale or a receipt (not asserted).",
      );
    }
  }

  // 004 — mapping gaps: no money checks ran for these parties
  for (const g of gaps) {
    const where = g.reason === "ledger-absent"
      ? `the mapped ledger does not exist in Tally`
      : g.reason === "name-absent"
        ? `the mapped deductor does not appear in 26AS for the period`
        : g.reason === "ambiguous"
          ? `the name matches several ledgers and was left unresolved`
          : g.ledger
            ? `bookside ${g.kind.toUpperCase()} deductions sit on a ledger the persistent party map does not cover`
            : `the 26AS deductor is not mapped to a Tally ledger in the persistent party map`;
    push("mapping_gap", "review", g.ledger ?? g.name, g.kind, null, g.tax,
      `${where} — tax at stake ${money(g.tax)}; no tax reconciliation ran for this party.`);
  }

  // 006 — export-internal consistency per summary row (kind, name, section)
  const sumByKey = new Map<string, As26SummaryRow>();
  for (const s of file.summaries) sumByKey.set(as26KeyOf(s), s);
  const txByKey = new Map<string, { tax: number; gross: number }>();
  for (const t of file.transactions) {
    const k = as26KeyOf(t);
    const acc = txByKey.get(k);
    if (acc) { acc.tax = round2(acc.tax + t.tax); acc.gross = round2(acc.gross + t.amount); }
    else txByKey.set(k, { tax: t.tax, gross: t.amount });
  }
  for (const [k, s] of sumByKey) {
    const t = txByKey.get(k);
    if (!t) {
      push("export_inconsistent", "review", s.name, s.kind, s.section, s.taxTotal,
        `Summary row reports ${money(s.taxTotal)} tax with no transactions in the detailed sheet for this section.`);
      continue;
    }
    const dTax = Math.abs(round2(s.taxTotal - t.tax));
    const dGross = Math.abs(round2(s.gross - t.gross));
    if (dTax > 0.005 || dGross > 0.005) {
      push("export_inconsistent", "review", s.name, s.kind, s.section, dTax,
        `Summary reports ${money(s.taxTotal)} tax against ${money(t.tax)} from the detailed sheet` +
        `, gross ${money(s.gross)} against ${money(t.gross)} — the export disagrees with itself.`);
    }
  }
  for (const [k, t] of txByKey) {
    if (sumByKey.has(k)) continue;
    const first = file.transactions.find((x) => as26KeyOf(x) === k);
    const name = file.summaries.find((x) => `${x.kind}|${x.nameKey}` === k.split("|").slice(0, 2).join("|"))?.name
      ?? first?.nameKey ?? k;
    push("export_inconsistent", "review", name, k.split("|")[0] as As26Kind, k.split("|")[2] || null, t.tax,
      `Detailed-sheet transactions totalling ${money(t.tax)} tax (${money(t.gross)} gross) have no matching summary row.`);
  }

  const totals = {
    booksTax: round2(recons.reduce((s, r) => s + r.booksTax, 0)),
    as26Tax: round2(recons.reduce((s, r) => s + r.as26Tax, 0)),
    partiesMatched: matches.length,
    combinationExplained: recons.reduce((s, r) => s + r.combinations.length, 0),
    ambiguous: recons.reduce((s, r) => s + r.ambiguous, 0),
  };
  return { findings, recon: recons, gaps, totals, skipped: file.skipped };
}
