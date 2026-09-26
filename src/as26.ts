import { readFileSync } from "node:fs";
import { canonicalKey } from "./key.js";
import { lawOf } from "./tds-law.js";
import type { As26File, As26Kind } from "./as26-file.js";

export type LinkBasis = "reference" | "taxable-rate" | "invoice-rate" | "approximate" | "none";

export interface BooksDeduction { ledgerKey: string; kind: As26Kind; date: string; tax: number; voucherType: string; voucherNumber: string | null; reference: string | null; }
export interface BooksSale { ledgerKey: string; date: string; ref: string | null; taxable: number; gross: number; }
/** One books voucher of an operator-mapped bank (design §12.2): interest
 * credited on the bank's interest ledgers, TDS credited on a receivable
 * ledger in the same voucher, FD principal debited (carried, not compared). */
export interface BankBooksEvent { nameKey: string; date: string; interest: number; tax: number; fdDebit: number; }
export interface BankBooks { nameKey: string; events: BankBooksEvent[]; }
export interface BooksFacts { deductions: BooksDeduction[]; sales: BooksSale[]; bankEvents?: BankBooks[]; /** Addendum 3: FD auto-detection outcome computed by the caller (owner of the group tree): auto-assigned rows for the workbook audit, and the unassigned remainder with its interest-side credit total. */ fdAuto?: { rows: FdAssignment[]; unassigned: string[]; interest: number }; }

/** The Bank Interest sheet's parsed rows (design §12.5): presence marks the
 * 26AS name a bank; its interest income and FD ledgers feed the bank-194A
 * books side. */
export interface BankInterestMapping { as26Name: string; interestLedgers: string[]; fdLedgers: string[]; }

export interface PartyMatch {
  /** Every Tally ledger mapped to this deductor/collector, canonical keys. */
  ledgerKeys: string[];
  /** The same ledgers in original case, in mapping order. */
  ledgerNames: string[];
  /** Display label for the group: `ledgerNames` joined with " + ". */
  ledgerName: string;
  as26NameKey: string; as26Name: string;
  kind: As26Kind; source: "operator";
}
export interface As26Gap { kind: As26Kind; nameKey: string; name: string; tax: number; ledger?: string; reason: "unmapped" | "ambiguous" | "ledger-absent" | "name-absent"; }

export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Stage-1 party matching — mapping-only policy (captain deviation): operator
 * entries join exactly; unmapped names and ledgers surface as gaps, never
 * auto-matched. One 26AS name may carry several ledgers and they group into a
 * single party; one ledger may carry only one 26AS name (loader-enforced).
 * Canonical collisions cannot arise where there is no fallback. */
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

  // Group operator mappings by (kind, 26AS name key): a single deductor or
  // collector may be represented by several Tally ledgers (a customer split
  // across a site ledger and a head-office ledger) and reconciles as one
  // party. The reverse — one ledger standing for two deductors — is refused
  // by the loader, so it never reaches here.
  const groupsByKey = new Map<string, PartyMatch>();
  const addLedgerToGroup = (group: PartyMatch, lk: string, ledgerName: string): void => {
    // A bank's ledgers may also appear on the Mapping sheet; union, never
    // duplicate (canonical keys cross-refuse elsewhere by policy).
    if (!group.ledgerKeys.includes(lk)) {
      group.ledgerKeys.push(lk);
      group.ledgerNames.push(ledgerName);
      group.ledgerName = group.ledgerNames.join(" + ");
    }
    matchedLedgerKeys.add(lk);
    matchedNameKeys.add(`${group.kind}|${group.as26NameKey}`);
  };
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
    const groupKey = `${summary.kind}|${nk}`;
    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = {
        ledgerKeys: [], ledgerNames: [], ledgerName: "",
        as26NameKey: nk, as26Name: m.as26Name, kind: summary.kind, source: "operator",
      };
      groupsByKey.set(groupKey, group);
    }
    addLedgerToGroup(group, lk, m.ledger);
  }
  // Bank Interest rows: the operator marks 26AS names banks and names their
  // interest income and FD ledgers (design §12.5). The bank party joins the
  // reconciliation even if its ledgers are absent from the master list —
  // the totals comparison runs on the books' own voucher evidence.
  for (const b of map.banks ?? []) {
    const nk = canonicalKey(b.as26Name);
    const summary = file.summaries.find((s) => s.nameKey === nk);
    const kind: As26Kind = summary?.kind ?? "tds";
    const groupKey = `${kind}|${nk}`;
    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = {
        ledgerKeys: [], ledgerNames: [], ledgerName: "",
        as26NameKey: nk, as26Name: b.as26Name, kind, source: "operator",
      };
      groupsByKey.set(groupKey, group);
    }
    for (const l of [...b.interestLedgers, ...b.fdLedgers]) {
      addLedgerToGroup(group, canonicalKey(l), l);
    }
  }
  matches.push(...groupsByKey.values());

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
export interface As26Map { mappings: As26MapEntry[]; banks?: BankInterestMapping[]; }
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
  (raw.mappings ?? []).forEach((m, i) => {
    const ledger = typeof m.ledger === "string" ? m.ledger.trim() : "";
    const as26Name = typeof m.as26Name === "string" ? m.as26Name.trim() : "";
    if (!ledger || !as26Name) {
      throw new Error(`as26-map entry ${i + 1}: "ledger" and "as26Name" must both be non-empty strings`);
    }
    const lk = canonicalKey(ledger);
    if (seenLedger.has(lk)) {
      throw new Error(`as26-map entry ${i + 1}: maps a ledger already mapped earlier in the file`);
    }
    seenLedger.add(lk);
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
        voucherNumber: r.voucherNumber ? String(r.voucherNumber) : null,
        reference: r.reference ? String(r.reference) : null,
      });
    } else if (r.amount < 0) {
      credits += 1;
    }
  }
  return { events, credits };
}

/** Addendum 9: the deductor behind one receivable-ledger debit.
 *
 * Deduction events are keyed by the row's display counterparty, which is the
 * deductor on a normal two-line TDS-vs-party voucher — but on a gross-up
 * journal (Dr TDS + Dr party, Cr income) the largest opposite-sign row is the
 * income ledger, so the event keys to income and can never join the
 * deductor's party. The voucher's own party line is the fallback evidence:
 * it wins only when the counterparty is not itself a party ledger and the
 * party line is one — otherwise the event keeps its counterparty key and
 * surfaces as an unmapped gap, never silently dropped. */
export function deductorKey(
  counterparty: string,
  voucherParty: string | null,
  isPartyLedger: (name: string) => boolean,
): string {
  if (isPartyLedger(counterparty)) return canonicalKey(counterparty);
  if (voucherParty && isPartyLedger(voucherParty)) return canonicalKey(voucherParty);
  return canonicalKey(counterparty);
}

/** Addendum 9: re-key day-book deduction events to their deductor. The
 * projector keeps the display counterparty (the sheets stay faithful); the
 * join key moves to the voucher party wherever the counterparty is not a
 * party ledger. Events whose voucher cannot be found, or whose voucher party
 * is no party ledger either, keep their key. Returns a new array. */
export function rekeyDeductionsToDeductor(
  deductions: BooksDeduction[],
  vouchers: VoucherRow[],
  isPartyLedger: (name: string) => boolean,
): BooksDeduction[] {
  const partyOf = new Map<string, string>();
  for (const v of vouchers) {
    if (v.cancelled) continue;
    partyOf.set(`${v.date}|${v.voucherType}|${v.voucherNumber}`, v.partyLedgerName);
  }
  return deductions.map((d) => {
    const party = partyOf.get(`${d.date}|${d.voucherType}|${d.voucherNumber ?? ""}`);
    if (party === undefined) return d;
    const key = deductorKey(d.ledgerKey, party || null, isPartyLedger);
    return key === d.ledgerKey ? d : { ...d, ledgerKey: key };
  });
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
    // A tcs-only ledger name carries no "receivable" word (real books name
    // them "TCS FY 25-26"), so the receivable requirement applies only to
    // tds or mixed names. A liability-side TCS ledger never qualifies.
    const isTcsOnly = n.includes("tcs") && !n.includes("tds");
    if (!isTcsOnly && !/receivable/i.test(n)) continue;
    if (!underAssetRoot(l.name)) continue;
    out.push({ name: l.name, kind: isTcsOnly ? "tcs" : "tds" });
  }
  return out;
}

// --- Task 7: stage-2 reconciliation core ---

export const AS26_TAX_TOLERANCE = 1.0;
export const AS26_VALUE_TOLERANCE = 1000.0;
export const COMBINATION_MAX_SIZE = 4;
/** Node budget for the exact-capacity subset walk (honest give-up, never a guess). */
export const COMBINATION_EXACT_NODES = 500000;
/** Targets at or under this many paise go through the dense subset-sum DP. */
export const COMBINATION_DP_MAX_PAISE = 30_000_000;
export const COMBINATION_MAX_ITEMS = 40;
/** Addendum 5: a deductor can split one bill's TDS across many small
 * journal entries — a government deductor took 11 journals against ONE 26AS
 * row, which the size-4 cap can never reassemble. When the leftover books
 * pool is small enough to enumerate exhaustively, allow a bigger group.
 * 2^14 enumerations max, so the search stays bounded. */
export const COMBINATION_GROUP_MAX_SIZE = 12;
export const COMBINATION_GROUP_POOL_MAX = 14;
/** The higher 20% TDS some banks deduct on FD interest (no PAN on file);
 * such books entries are excluded from the 26AS totals comparison (design
 * §12.4; never expected to appear in 26AS). Tolerance: 1% of the interest,
 * with a ₹1 floor so sub-₹100 entries still match. */
export const FD20_TAX_RATE = 0.2;
export const FD20_RELTOL = 0.01;
export const isFd20 = (interest: number, tax: number): boolean =>
  interest > 0 && tax > 0 &&
  Math.abs(tax - FD20_TAX_RATE * interest) <= Math.max(1, FD20_RELTOL * interest);
/** Punctuation/case-insensitive section token (`194I(a)` -> `194ia`). */
export const sectionToken = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// --- FD ledger auto-detection and bank assignment (addendum 3/3a, 2026-09-26) ---

/** FD ledger name tokens: whole-token, case-insensitive, punctuation-normalised.
 * A ledger like "FD - 123456" or "F.D 789" qualifies; "EMD - 5" does not.
 * (The Deposits (Asset) ancestry check is the caller's, which owns the group tree.) */
export const isFdLedgerName = (name: string): boolean => {
  const t = tokensOf(name);
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === "FD") return true;
    if (t[i] === "F" && t[i + 1] === "D") return true;
    if (t[i] === "FIXED" && t[i + 1] === "DEPOSIT") return true;
  }
  return false;
};

/** Whole tokens of a name, punctuation-normalised: "U.B.I / FD 123" -> ["U","B","I","FD","123"]. */
export const tokensOf = (name: string): string[] =>
  name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

/** Generic bank-name words, NOT counted as distinctive tokens. Extend this
 * list (e.g. more city names) when a real bank misfires. */
export const BANK_GENERIC_WORDS = new Set([
  "BANK", "OF", "INDIA", "LTD", "LIMITED", "BRANCH", "THE", "RO", "CO",
  "CHENNAI", "MUMBAI", "DELHI", "KOLKATA", "BANGALORE", "BENGALURU", "HYDERABAD",
  "MADURAI", "SALEM", "COIMBATORE", "TRICHY", "TIRUCHIRAPPALLI", "ERODE",
]);

/** Curated short forms of Indian banks (whole 26AS names; extend by adding a
 * row — the derived-initial rules below cover unlisted names). */
const BANK_CURATED_SHORTFORMS: Array<{ name: string; forms: string[] }> = [
  { name: "Union Bank of India", forms: ["UBI", "UB"] },
  { name: "State Bank of India", forms: ["SBI"] },
  { name: "Indian Overseas Bank", forms: ["IOB"] },
  { name: "Bank of Baroda", forms: ["BOB"] },
  { name: "Punjab National Bank", forms: ["PNB"] },
  { name: "Bank of India", forms: ["BOI"] },
  { name: "City Union Bank", forms: ["CUB"] },
  { name: "Karur Vysya Bank", forms: ["KVB"] },
  { name: "Tamilnad Mercantile Bank", forms: ["TMB"] },
  // Indian Bank: "IB" is left out of the table deliberately — a two-letter
  // form that could name several banks matches only when unambiguous (the
  // multi-bank rejection below), and only as a standalone token.
];

/** Short forms of one bank's 26AS name: curated rows first, then derived
 * initialisms — initial of every word (UBI/BOB), of every word but the
 * "of"s, and of only the words before the "of". Branch/city suffixes
 * (generic words) are stripped from the trailing end first so
 * "Union Bank of India (Ro Chennai)" still yields UBI and UB. */
export function bankShortForms(as26Name: string): string[] {
  const out = new Set<string>();
  for (const c of BANK_CURATED_SHORTFORMS) {
    if (canonicalKey(c.name) === canonicalKey(as26Name)) for (const f of c.forms) out.add(f);
  }
  const raw = tokensOf(as26Name);
  const ofIdx = raw.lastIndexOf("OF");
  // Drop branch/city suffix words that FOLLOW the last "of" — "Union Bank
  // of India (Ro Chennai)" keeps its India/Union initials, loses Ro/Chennai.
  const tail = raw.slice(ofIdx + 1);
  while (tail.length > 1 && BANK_GENERIC_WORDS.has(tail[tail.length - 1])) tail.pop();
  const ws = ofIdx === -1 ? [...tail.length > 0 ? tail : raw] : [...raw.slice(0, ofIdx + 1), ...tail];
  const initials = (list: string[]): string | null => {
    const s = list.map((w) => w[0]).join("");
    return list.length === 0 || s.length < 2 ? null : s;
  };
  for (const f of [
    initials(ws),
    initials(ws.filter((w) => w !== "OF")),
    initials(raw.slice(0, ofIdx === -1 ? raw.length : ofIdx)),
  ]) {
    if (f) out.add(f);
  }
  return [...out];
}

/** Distinctive whole-name tokens of one bank (generic words dropped). */
const bankDistinctiveTokens = (as26Name: string): string[] =>
  tokensOf(as26Name).filter((w) => !BANK_GENERIC_WORDS.has(w));

/** Does an FD ledger name match this bank via a distinctive token or a short
 * form? Two-letter forms and all short forms match only as a standalone
 * token (whole token, never inside a word or account number). A run of
 * single-letter tokens is additionally joined — "U.B.I" tokenises as
 * U/B/I, the way initials are punctuated. */
const bankMatchesFdName = (as26Name: string, fdTokens: string[]): boolean => {
  const candidates = new Set(fdTokens);
  let run = "";
  for (const t of fdTokens) {
    if (t.length === 1) {
      run += t;
    } else {
      if (run.length >= 2) candidates.add(run);
      run = "";
    }
  }
  if (run.length >= 2) candidates.add(run);
  for (const tok of bankDistinctiveTokens(as26Name)) {
    if (candidates.has(tok)) return true;
  }
  for (const f of bankShortForms(as26Name)) {
    if (f.length >= 2 && candidates.has(f)) return true;
  }
  return false;
};

export type FdRule = "name-match" | "only-bank";
export interface FdAssignment { ledger: string; bank?: string; rule?: FdRule; }

/** Addendum-3 rules, applied in order (pure): a) a whole distinctive token or
 * short form of exactly ONE listed bank appearing in the FD ledger name;
 * b) else exactly one listed bank overall; c) else unassigned (caller emits
 * the review finding). A form that fits more than one listed bank never
 * matches, and explicit operator mappings win (input already excludes them). */
export function assignFdLedgers(fdLedgerNames: string[], banks: string[]): FdAssignment[] {
  return fdLedgerNames.map((ledger) => {
    const t = tokensOf(ledger);
    const fitting = banks.filter((b) => bankMatchesFdName(b, t));
    if (fitting.length === 1) return { ledger, bank: fitting[0], rule: "name-match" as const };
    if (banks.length === 1) return { ledger, bank: banks[0], rule: "only-bank" as const };
    return { ledger };
  });
}

export interface ReconItem { date: string; tax: number; dedIdx?: number; txIdx?: number; gross?: number; status?: string | null; ref?: string | null; }

export interface PartyRecon {
  match: PartyMatch;
  booksTax: number; as26Tax: number;
  paired: Array<{ books: ReconItem; as26: ReconItem }>;
  combinations: Array<{
    target: ReconItem; parts: ReconItem[]; side: "books" | "as26";
    /** The invoice evidence the group was matched on, when a single
     * predicate exists (tier anchor or rate-exact fallback). */
    basis?: LinkBasis;
    invoiceRef?: string | null;
    invoiceDate?: string | null;
    invoiceTaxable?: number | null;
    /** Drill-down row ids (B/D) of the matched rows, filled by the session
     * after numbering; the report shows them so a combination's consumed
     * rows stay traceable even though they left the unmatched sheets. */
    targetId?: string;
    partIds?: string[];
  }>;
  ambiguous: number;
  unmatchedBooks: ReconItem[]; unmatchedAs26: ReconItem[];
  combinationSearchSkipped: boolean;
  lateBookedTax: number;
  /** Value interpretation carried for the report's Deductors sheet
   * (books GST-exclusive / GST-inclusive totals vs 26AS gross). */
  booksTaxableValue?: number;
  booksGrossValue?: number;
  as26GrossValue?: number;
  /** Addendum 5a: books interest credited (bank parties) and the value-basis
   * interpretation the Deductors sheet's value delta is measured on. */
  booksInterestValue?: number;
  valueBasis?: string;
  valueDelta?: number;
  /** Totals-only party (design §12.1): every 26AS section is 194R, or 194A
   * with the operator-marked bank — no bill-level findings or rows. */
  totalsOnly?: boolean;
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

/** Index-combination subsets of `items` with size 1..n, in index order. */
function* subsetsAll(items: ReconItem[]): Generator<ReconItem[]> {
  const n = items.length;
  for (let size = 1; size <= n; size += 1) {
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

/** Day-granular gap between two YYYYMMDD dates; +Infinity when either is
 * malformed so such items never outrank a real date. */
const gapDays = (a: string, b: string): number => {
  if (!/^\d{8}$/.test(a) || !/^\d{8}$/.test(b)) return Number.POSITIVE_INFINITY;
  const at = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(4, 6)) - 1, Number(a.slice(6, 8)));
  const bt = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(4, 6)) - 1, Number(b.slice(6, 8)));
  return Math.abs(at - bt) / 86400000;
};

const byDateAsc = (items: ReconItem[]) => (x: number, y: number): number =>
  items[x].date === items[y].date ? x - y : items[x].date < items[y].date ? -1 : 1;

/** Leftovers grouped by tax amount, tolerance-merged on the sorted union of
 * both sides (the first item's amount anchors each group, so no group spans
 * more than AS26_TAX_TOLERANCE from its anchor). */
function leftoverAmountGroups(
  booksItems: ReconItem[], usedBooks: Set<number>,
  as26Items: ReconItem[], usedAs26: Set<number>,
): Array<{ books: number[]; as26: number[] }> {
  const entries: Array<{ side: 0 | 1; idx: number; tax: number }> = [];
  booksItems.forEach((b, i) => { if (!usedBooks.has(i)) entries.push({ side: 0, idx: i, tax: round2(b.tax) }); });
  as26Items.forEach((a, j) => { if (!usedAs26.has(j)) entries.push({ side: 1, idx: j, tax: round2(a.tax) }); });
  entries.sort((x, y) => x.tax - y.tax || x.side - y.side || x.idx - y.idx);
  const groups: Array<{ books: number[]; as26: number[] }> = [];
  let anchor = Number.NaN;
  for (const e of entries) {
    if (groups.length === 0 || e.tax - anchor > AS26_TAX_TOLERANCE) {
      anchor = e.tax;
      groups.push({ books: [], as26: [] });
    }
    (e.side === 0 ? groups[groups.length - 1].books : groups[groups.length - 1].as26).push(e.idx);
  }
  return groups;
}

/** Equal-amount leftovers pair many-to-many. The unique-both-directions test
 * leaves N identical-amount items on each side unpaired (a government
 * deductor splitting one bill's tax across several identical entries is the
 * live case) and the size-2..4 combination search cannot reproduce a single
 * item. Equal counts pair earliest-books with earliest-26AS; unequal counts
 * pair by nearest date and leave the surplus unmatched. */
function pairEqualLeftovers(
  booksItems: ReconItem[], usedBooks: Set<number>,
  as26Items: ReconItem[], usedAs26: Set<number>,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (const g of leftoverAmountGroups(booksItems, usedBooks, as26Items, usedAs26)) {
    if (g.books.length === 0 || g.as26.length === 0) continue;
    const b = [...g.books].sort(byDateAsc(booksItems));
    const a = [...g.as26].sort(byDateAsc(as26Items));
    if (b.length === a.length) {
      for (let k = 0; k < b.length; k += 1) pairs.push([b[k], a[k]]);
      continue;
    }
    const smallerIsBooks = b.length < a.length;
    const from = smallerIsBooks ? b : a;
    const into = smallerIsBooks ? a : b;
    const fromItems = smallerIsBooks ? booksItems : as26Items;
    const intoItems = smallerIsBooks ? as26Items : booksItems;
    const usedInto = new Set<number>();
    for (const fi of from) {
      let best = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const ti of into) {
        if (usedInto.has(ti)) continue;
        const dist = gapDays(fromItems[fi].date, intoItems[ti].date);
        if (dist < bestDist || (dist === bestDist && (best < 0 || intoItems[ti].date < intoItems[best].date))) {
          best = ti;
          bestDist = dist;
        }
      }
      if (best < 0) continue;
      usedInto.add(best);
      pairs.push(smallerIsBooks ? [fi, best] : [best, fi]);
    }
  }
  return pairs;
}

/** Stage-2 reconciliation: totals first, then unique 1:1 pairing within
 * tolerance, then equal-amount leftovers in date order, then a bounded
 * combination explanation. The search never
 * mutates the totals — it only explains leftovers, honestly: more than one
 * fitting subset means the item stays unmatched and is counted ambiguous. */
const normRef = (x: unknown): string => String(x ?? "").trim().toLowerCase();

const RENT_SECTION = /^194\s*-?\s*i\s*\(\s*([ab])\s*\)$/i;
export function normalizeAs26Section(section: string): string {
  const m = RENT_SECTION.exec(section.trim());
  return m ? `194-I(${m[1].toLowerCase()})` : section;
}

const latestUpdate = (best: BooksSale | null, s: BooksSale): BooksSale =>
  !best || s.date > best.date ? s : best;

export function linkInvoice(
  sales: BooksSale[],
  item: { date: string; tax: number; reference: string | null; section: string | null; ledgerKey?: string },
  claimed?: Map<string, number>,
): { sale: BooksSale; basis: LinkBasis } | null {
  const candsByDate = sales.filter((s) => s.date <= item.date);
  const sameLedger = item.ledgerKey ? candsByDate.filter((s) => s.ledgerKey === item.ledgerKey) : [];
  const cands = sameLedger.length > 0 ? sameLedger : candsByDate;
  const ref = item.reference ? normRef(item.reference) : "";
  if (ref) {
    const hit = sales.find((s) => s.ref != null && normRef(s.ref) === ref);
    if (hit) return { sale: hit, basis: "reference" };
  }
  const law = item.section ? lawOf(normalizeAs26Section(item.section)) : null;
  if (law) {
    const rate = law.rates.standard;
    let hit: BooksSale | null = null;
    for (const s of cands) {
      if (Math.abs(round2(s.taxable * rate) - item.tax) <= AS26_TAX_TOLERANCE) hit = latestUpdate(hit, s);
    }
    if (hit) return { sale: hit, basis: "taxable-rate" };
    for (const s of cands) {
      if (Math.abs(round2(s.gross * rate) - item.tax) <= AS26_TAX_TOLERANCE) hit = latestUpdate(hit, s);
    }
    if (hit) return { sale: hit, basis: "invoice-rate" };
  }
  // Approximate is the weakest claim — "this entry could be a part of that
  // invoice's TDS" — so a candidate must at least carry a full section-rate
  // TDS not smaller than the entry (addendum 6: an entry bigger than the
  // invoice's whole TDS used to land on an unrelated invoice and pollute its
  // pool). Without a law rate there is nothing to compare and the gate is off.
  const plausible = (s: BooksSale): boolean =>
    !law || item.tax <= round2(law.rates.standard * s.taxable) + AS26_TAX_TOLERANCE;
  // Capacity rule (addendum 7): among the LATEST-DATE plausible candidates,
  // an invoice whose whole section-rate TDS is already claimed by stronger
  // links has no residual capacity and is passed over for a same-date
  // sibling with room. The rule never reaches an earlier date and never
  // re-routes the entry to a different day — no capacity anywhere at the
  // latest date means UNLINKED, not a guess.
  let latest = "";
  for (const s of cands) {
    if (plausible(s) && s.date > latest) latest = s.date;
  }
  let ap: BooksSale | null = null;
  for (const s of cands) {
    if (!plausible(s) || (claimed && law && s.date !== latest)) continue;
    if (claimed && law) {
      const residual = round2(round2(law.rates.standard * s.taxable) - (claimed.get(capacityKey(s)) ?? 0));
      if (item.tax > residual + AS26_TAX_TOLERANCE) continue;
    }
    ap = latestUpdate(ap, s);
  }
  return ap ? { sale: ap, basis: "approximate" } : null;
}

/** Identity of a sale for capacity accounting: ledger plus normalized ref. */
function capacityKey(s: BooksSale): string {
  return `${canonicalKey(s.ledgerKey)}|${s.ref ? normRef(s.ref) : ""}`;
}

/**
 * TDS capacity already claimed per sale (addendum 7): the sum of taxes of
 * `items` whose link to a sale is a STRONG basis (reference, taxable-rate,
 * invoice-rate). Approximate claims never count — they are exactly the
 * guesses this map polices. Empty when the section has no law rate.
 */
export function claimedTdsCapacity(
  sales: BooksSale[],
  items: Array<{ date: string; tax: number; reference: string | null; ledgerKey?: string }>,
  section: string | null,
): Map<string, number> {
  const claimed = new Map<string, number>();
  const law = section ? lawOf(normalizeAs26Section(section)) : null;
  if (!law) return claimed;
  for (const it of items) {
    const link = linkInvoice(sales, { ...it, section });
    if (!link || link.basis === "approximate") continue;
    const key = capacityKey(link.sale);
    claimed.set(key, round2((claimed.get(key) ?? 0) + it.tax));
  }
  return claimed;
}

/**
 * linkInvoice plus the capacity rule (addendum 7): an invoice whose whole
 * section-rate TDS is already claimed by stronger links has no residual
 * capacity, so an APPROXIMATE link to it is refused and the entry stays
 * unlinked rather than guessed. Strong links are never refused.
 */
export function linkInvoiceWithCapacity(
  sales: BooksSale[],
  item: { date: string; tax: number; reference: string | null; section: string | null; ledgerKey?: string },
  claimed: Map<string, number>,
): { sale: BooksSale; basis: LinkBasis } | null {
  return linkInvoice(sales, item, claimed);
}


export function reconcileParty(file: As26File, facts: BooksFacts, match: PartyMatch, toDate: string): PartyRecon {
  const keySet = new Set(match.ledgerKeys);
  const booksItems: ReconItem[] = [];
  facts.deductions.forEach((d, dedIdx) => {
    if (keySet.has(d.ledgerKey) && d.kind === match.kind) {
      booksItems.push({ date: d.date, tax: d.tax, dedIdx, ref: d.reference });
    }
  });
  const rows = file.transactions.filter((t) => t.kind === match.kind && t.nameKey === match.as26NameKey);
  const lateBookedTax = round2(rows
    .filter((t) => t.bookingDate && t.bookingDate > toDate)
    .reduce((s, t) => s + t.tax, 0));
  const as26Items: ReconItem[] = rows.map((t, txIdx) => ({
    date: t.bookingDate || t.date, tax: t.tax, txIdx, gross: t.amount, status: t.status || null,
  }));

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

  // Equal-amount leftovers: identical amounts on both sides never pass the
  // unique-both-directions test above, so pair them directly (earliest to
  // earliest) before the combination search runs on what remains.
  for (const [i, j] of pairEqualLeftovers(booksItems, usedBooks, as26Items, usedAs26)) {
    paired.push({ books: booksItems[i], as26: as26Items[j] });
    usedBooks.add(i);
    usedAs26.add(j);
  }

  let unmatchedBooks = booksItems.filter((_, i) => !usedBooks.has(i));
  let unmatchedAs26 = as26Items.filter((_, i) => !usedAs26.has(i));

  const combinations: PartyRecon["combinations"] = [];
  let ambiguous = 0;

  // Invoice-anchored group matching (addendum 5, reworked addendum 6): one
  // 26AS row is the TDS of one invoice — or of a small set of invoices the
  // deductor split its deposit across — while the books side may book that
  // TDS as many journals (split, dated before the invoice, or polluted by an
  // unrelated entry). The tie is recomputed with the same linkInvoice the
  // bill drill-down uses, so workbook and engine agree by construction.
  // Per 26AS target, candidate pools of anchored book entries are built in
  // two tiers: (1) a single invoice whose taxable ≈ the row's amount paid/
  // credited or whose taxable × section rate ≈ the row's tax; (2) a PAIR of
  // invoices whose taxable sums ≈ the row's amount. A pool fits when the
  // whole pool sums to the target tax, or — only when the pool is small
  // enough to enumerate — one subset does. Only a UNIQUE fit, wanted by only
  // that target, is consumed; anything else stays unmatched and counts
  // ambiguous. Dates never block a fit; the bounded subset search below
  // still runs afterwards on whatever remains.
  {
    const secsOfParty = new Set(
      file.summaries
        .filter((s) => s.kind === match.kind && s.nameKey === match.as26NameKey)
        .map((s) => s.section),
    );
    const section = secsOfParty.size === 1 ? [...secsOfParty][0] : null;
    const law = section ? lawOf(normalizeAs26Section(section)) : null;
    const rate = law?.rates.standard ?? null;
    const salesPool = facts.sales.filter((s) => keySet.has(s.ledgerKey) && s.ref != null);
    const saleByRef = new Map(salesPool.map((s) => [normRef(s.ref), s]));
    // Capacity claimed by strong links (addendum 7), from ALL party entries —
    // not just the unmatched ones: an invoice's TDS is claimed whether or not
    // the claiming journal was itself consumed by an earlier stage.
    const partyInputs = booksItems.flatMap((b) => {
      const d: BooksDeduction | undefined = b.dedIdx !== undefined ? facts.deductions[b.dedIdx] : undefined;
      return d ? [{ date: d.date, tax: d.tax, reference: d.reference, ledgerKey: d.ledgerKey }] : [];
    });
    const claimed = claimedTdsCapacity(salesPool, partyInputs, section);
    // ref -> unmatched book entries anchored to that invoice, with the
    // anchor link's basis so consumed groups can show their evidence.
    const anchored = new Map<string, { pool: ReconItem[]; basis: LinkBasis; sale: BooksSale }>();
    for (const b of unmatchedBooks) {
      const d: BooksDeduction | undefined = b.dedIdx !== undefined ? facts.deductions[b.dedIdx] : undefined;
      if (!d) continue;
      const link = linkInvoiceWithCapacity(salesPool, { date: d.date, tax: d.tax, reference: d.reference, section, ledgerKey: d.ledgerKey }, claimed);
      if (!link || !link.sale.ref) continue;
      const key = normRef(link.sale.ref);
      if (!saleByRef.has(key)) continue;
      const entry = anchored.get(key);
      if (entry) entry.pool.push(b);
      else anchored.set(key, { pool: [b], basis: link.basis, sale: link.sale });
    }
    /** Exact-capacity subset search (addendum 7 follow-up): the unique
     * subset of pool summing to the target within tolerance, or null.
     * Journals can pre-date their invoice (TDS booked on accounting, bill
     * raised later), so the pool is the party's whole unmatched tail and
     * needs a real algorithm, not enumeration: a dense subset-sum DP over
     * paise for targets up to COMBINATION_DP_MAX_PAISE (count capped at 2 —
     * uniqueness is all the honesty rule needs), a budgeted DFS beyond. */
    const fitExactPool = (pool: ReconItem[], target: ReconItem): ReconItem[] | null => {
      if (pool.length === 0) return null;
      const paise = (x: number): number => Math.round(x * 100);
      const lo = paise(target.tax) - paise(AS26_TAX_TOLERANCE);
      const hi = paise(target.tax) + paise(AS26_TAX_TOLERANCE);
      const items = [...pool];
      if (hi <= COMBINATION_DP_MAX_PAISE) {
        const fromSum = new Int32Array(hi + 1).fill(-1);
        const fromIdx = new Int32Array(hi + 1).fill(-1);
        const count = new Int32Array(hi + 1);
        count[0] = 1;
        for (let i = 0; i < items.length; i += 1) {
          const w = paise(items[i].tax);
          if (w <= 0 || w > hi) continue;
          for (let sum = hi - w; sum >= 0; sum -= 1) {
            if (count[sum] === 0) continue;
            const ns = sum + w;
            if (count[ns] === 0) {
              count[ns] = Math.min(2, count[sum]);
              fromSum[ns] = sum;
              fromIdx[ns] = i;
            } else if (count[ns] < 2) {
              count[ns] = Math.min(2, count[ns] + count[sum]);
            }
          }
        }
        let winners = 0;
        let winSum = -1;
        for (let sum = Math.max(0, lo); sum <= hi; sum += 1) {
          if (count[sum] > 0) winSum = sum;
          winners += count[sum];
        }
        if (winners !== 1) return null;
        const picks: number[] = [];
        let sum = winSum;
        while (sum !== 0) {
          picks.push(fromIdx[sum]);
          sum = fromSum[sum];
        }
        return picks.map((i) => items[i]);
      }
      // Huge targets: budgeted DFS, honest give-up.
      const sorted = [...items].sort((x, y) => y.tax - x.tax);
      const suffix = new Array<number>(sorted.length + 1).fill(0);
      for (let i = sorted.length - 1; i >= 0; i -= 1) suffix[i] = round2(suffix[i + 1] + sorted[i].tax);
      const floor = target.tax - AS26_TAX_TOLERANCE;
      const ceiling = target.tax + AS26_TAX_TOLERANCE;
      const foundFits: ReconItem[][] = [];
      let nodes = 0;
      let stop = false;
      let overflow = false;
      const walk = (i: number, sum: number, acc: ReconItem[]): void => {
        if (stop || overflow) return;
        if (nodes > COMBINATION_EXACT_NODES) {
          overflow = true;
          return;
        }
        if (i >= sorted.length) return;
        nodes += 1;
        const withSum = round2(sum + sorted[i].tax);
        if (Math.abs(withSum - target.tax) <= AS26_TAX_TOLERANCE) {
          foundFits.push([...acc, sorted[i]]);
          if (foundFits.length > 1) {
            stop = true;
            return;
          }
        }
        if (withSum <= ceiling) walk(i + 1, withSum, [...acc, sorted[i]]);
        if (round2(sum + suffix[i + 1]) >= floor) walk(i + 1, sum, acc);
      };
      walk(0, 0, []);
      if (overflow || foundFits.length !== 1) return null;
      return foundFits[0];
    };
    /** Whole pool first (no size limit), then subsets only if enumerable. */
    const fitInPool = (pool: ReconItem[], target: ReconItem): ReconItem[] | null => {
      if (pool.length === 0) return null;
      if (fits(sumTax(pool), target.tax)) return pool;
      if (pool.length > COMBINATION_GROUP_POOL_MAX) return null;
      let hit: ReconItem[] | null = null;
      for (const s of subsetsAll(pool)) {
        if (fits(sumTax(s), target.tax)) {
          if (hit) return null;
          hit = s;
        }
      }
      return hit;
    };
    /** Tier-1/2 candidate pools for one 26AS target, deduplicated by ref set. */
    const poolsFor = (a: ReconItem): string[][] => {
      const gross = a.gross ?? 0;
      const rateFits = (t: number): boolean => rate !== null && Math.abs(round2(t * rate) - a.tax) <= AS26_TAX_TOLERANCE;
      const refSets: string[][] = [];
      const seen = new Set<string>();
      const push = (refs: string[]): void => {
        if (refs.some((r) => (anchored.get(r)?.pool.length ?? 0) === 0)) return;
        const key = [...refs].sort().join("+");
        if (seen.has(key)) return;
        seen.add(key);
        refSets.push(refs);
      };
      for (const [ref, s] of saleByRef) {
        if (Math.abs(s.taxable - gross) <= AS26_VALUE_TOLERANCE || rateFits(s.taxable)) push([ref]);
      }
      const refs = [...saleByRef.keys()];
      for (let i = 0; i < refs.length; i += 1) {
        for (let k = i + 1; k < refs.length; k += 1) {
          const s1 = saleByRef.get(refs[i]);
          const s2 = saleByRef.get(refs[k]);
          if (!s1 || !s2) continue;
          const sum = round2(s1.taxable + s2.taxable);
          if (Math.abs(sum - gross) <= AS26_VALUE_TOLERANCE || rateFits(sum)) push([refs[i], refs[k]]);
        }
      }
      return refSets;
    };
    /** A candidate fit with the invoice evidence it rests on. */
    type TierFit = {
      parts: ReconItem[];
      basis: LinkBasis;
      invoiceRef: string;
      invoiceDate: string;
      invoiceTaxable: number;
    };
    const tierFit = (parts: ReconItem[], refKeys: string[]): TierFit => {
      const meta = anchored.get(refKeys[0])!;
      const sales = refKeys.map((r) => saleByRef.get(r)!);
      return {
        parts,
        basis: meta.basis,
        invoiceRef: refKeys.length === 1 ? meta.sale.ref! : sales.map((x) => x.ref).join(" + "),
        invoiceDate: meta.sale.date,
        invoiceTaxable: round2(sales.reduce((t, x) => t + x.taxable, 0)),
      };
    };
    const fitsByTarget = new Map<number, TierFit[]>();
    unmatchedAs26.forEach((a, j) => {
      const found: TierFit[] = [];
      const seenFit = new Set<string>();
      for (const rs of poolsFor(a)) {
        const pool: ReconItem[] = [];
        for (const r of rs) pool.push(...(anchored.get(r)?.pool ?? []));
        const fit = fitInPool(pool, a);
        if (!fit) continue;
        const key = fit.map((x) => x.dedIdx).sort().join("|");
        if (seenFit.has(key)) continue;
        seenFit.add(key);
        found.push(tierFit(fit, rs));
      }
      if (found.length > 0) fitsByTarget.set(j, found);
    });
    // Whole-pool fallback for targets no invoice predicate named: a deductor
    // can span several Tally ledgers (e.g. a corporation's zone offices), so
    // its deposit row may be explained exactly by the anchored pool of an
    // invoice the row's own amount never points at. Only the WHOLE pool of
    // one invoice qualifies — never subsets — and only when exactly one such
    // pool fits; that is the addendum-5 behaviour, narrowed by the gated
    // anchors and demoted below the invoice-predicate tiers.
    unmatchedAs26.forEach((a, j) => {
      if (fitsByTarget.has(j)) return;
      const whole: TierFit[] = [];
      const seenFit = new Set<string>();
      for (const [ref, meta] of anchored) {
        if (meta.pool.length === 0) continue;
        if (!fits(sumTax(meta.pool), a.tax)) continue;
        const key = meta.pool.map((x) => x.dedIdx).sort().join("|");
        if (seenFit.has(key)) continue;
        seenFit.add(key);
        whole.push(tierFit(meta.pool, [ref]));
      }
      if (whole.length > 0) fitsByTarget.set(j, whole);
    });
    // Rate-exact capacity fallback (addendum 7): a 26AS row whose tax is the
    // exact section-rate TDS of one invoice may be explained by a unique
    // subset of the party's journals within that invoice's capacity dated
    // before the deposit — journals can legitimately pre-date their invoice
    // (TDS booked on accounting, bill raised later), and the approximate
    // anchor correctly refuses to guess them onto an earlier invoice.
    //
    // The pool is the UNEXPLAINED journals only (no link at all under the
    // same linkInvoice the sheets use): an approximately-anchored journal
    // already has an invoice explanation, however weak, and letting those
    // guesses into the pool manufactures competing subsets that bury the
    // true one (live: four unanchored journals summing exactly to their
    // invoice's TDS lost among anchored decoys). Unprovable stays unlinked.
    const anchorOf = new Map<number, boolean>();
    for (const b of unmatchedBooks) {
      const d: BooksDeduction | undefined = b.dedIdx !== undefined ? facts.deductions[b.dedIdx] : undefined;
      if (d && b.dedIdx !== undefined) {
        const link = linkInvoiceWithCapacity(salesPool, { date: d.date, tax: d.tax, reference: d.reference, section, ledgerKey: d.ledgerKey }, claimed);
        anchorOf.set(b.dedIdx, link !== null);
      }
    }
    unmatchedAs26.forEach((a, j) => {
      if (fitsByTarget.has(j) || !rate) return;
      const found: TierFit[] = [];
      const seenFit = new Set<string>();
      for (const s of saleByRef.values()) {
        const capacity = round2(s.taxable * rate);
        if (Math.abs(capacity - a.tax) > AS26_TAX_TOLERANCE) continue;
        const cap = capacity + AS26_TAX_TOLERANCE;
        const pool: ReconItem[] = [];
        for (const b of unmatchedBooks) {
          const d: BooksDeduction | undefined = b.dedIdx !== undefined ? facts.deductions[b.dedIdx] : undefined;
          if (!d || d.date > a.date || d.tax > cap) continue;
          if (s.ledgerKey && d.ledgerKey && d.ledgerKey !== s.ledgerKey) continue;
          if (b.dedIdx === undefined || anchorOf.get(b.dedIdx)) continue;
          pool.push(b);
        }
        const fit = fitExactPool(pool, a);
        if (!fit) continue;
        const key = fit.map((x) => x.dedIdx).sort().join("|");
        if (seenFit.has(key)) continue;
        seenFit.add(key);
        found.push({ parts: fit, basis: "taxable-rate", invoiceRef: s.ref!, invoiceDate: s.date, invoiceTaxable: s.taxable });
      }
      if (found.length === 1) fitsByTarget.set(j, found);
      else if (found.length > 1) ambiguous += 1;
    });
    const contended = new Set<string>();
    for (const cands of fitsByTarget.values()) {
      if (cands.length > 1) {
        for (const g of cands) contended.add(g.parts.map((x) => x.dedIdx).sort().join("|"));
        continue;
      }
      const key = cands[0].parts.map((x) => x.dedIdx).sort().join("|");
      let wants = 0;
      for (const other of fitsByTarget.values()) {
        if (other.some((x) => x.parts.map((y) => y.dedIdx).sort().join("|") === key)) wants += 1;
      }
      if (wants > 1) contended.add(key);
    }
    const gTakenBooks = new Set<number>();
    const gTakenAs26 = new Set<number>();
    for (const [j, cands] of fitsByTarget) {
      if (gTakenAs26.has(j)) continue;
      const parts = cands[0].parts;
      const key = parts.map((x) => x.dedIdx).sort().join("|");
      if (cands.length > 1 || contended.has(key)) {
        ambiguous += 1;
        continue;
      }
      combinations.push({
        target: unmatchedAs26[j], parts, side: "as26",
        basis: cands[0].basis, invoiceRef: cands[0].invoiceRef,
        invoiceDate: cands[0].invoiceDate, invoiceTaxable: cands[0].invoiceTaxable,
      });
      for (const p of parts) {
        const k = unmatchedBooks.findIndex((x) => x === p);
        if (k >= 0) gTakenBooks.add(k);
      }
      gTakenAs26.add(j);
    }
    unmatchedBooks = unmatchedBooks.filter((_, i) => !gTakenBooks.has(i));
    unmatchedAs26 = unmatchedAs26.filter((_, i) => !gTakenAs26.has(i));
  }

  const searchSkipped =
    unmatchedBooks.length > COMBINATION_MAX_ITEMS || unmatchedAs26.length > COMBINATION_MAX_ITEMS;

  if (!searchSkipped) {
    const takenBooks = new Set<number>();
    const takenAs26 = new Set<number>();
    // combinations targeting a books item, parts from 26AS. Symmetric to the
    // as26-target direction below: when the 26AS tail is exhaustively
    // enumerable the cap is raised so one books entry equal to the SUM of a
    // deductor's whole 26AS tail is recognised as one aggregate match (a
    // deductor reporting a single payment across many 26AS detail rows).
    // Only a UNIQUE fit is taken; anything else stays ambiguous.
    const bookTargets = unmatchedBooks.filter((_, i) => !takenBooks.has(i));
    for (const target of bookTargets) {
      const pool = unmatchedAs26.filter((_, i) => !takenAs26.has(i));
      const maxSize = pool.length <= COMBINATION_GROUP_POOL_MAX
        ? COMBINATION_GROUP_MAX_SIZE
        : COMBINATION_MAX_SIZE;
      const fitAs26: ReconItem[][] = [];
      for (const s of subsets(pool, maxSize)) {
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
    // combinations targeting an as26 item, parts from books. When the
    // leftover books pool is exhaustively enumerable, the group cap is
    // raised so a many-journal split of one 26AS row reassembles; the
    // smallest fitting subset still wins (size-ascending), only a UNIQUE
    // fit is taken, dates never block the fit.
    const as26Targets = unmatchedAs26.filter((_, i) => !takenAs26.has(i));
    for (const target of as26Targets) {
      const pool = unmatchedBooks.filter((_, i) => !takenBooks.has(i));
      const maxSize = pool.length <= COMBINATION_GROUP_POOL_MAX
        ? COMBINATION_GROUP_MAX_SIZE
        : COMBINATION_MAX_SIZE;
      const fitBooks: ReconItem[][] = [];
      for (const s of subsets(pool, maxSize)) {
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
  /** Books FD-interest events the books show taxed at ~20% — the higher rate
   * some banks deduct (no PAN on file). Excluded from the totals comparison;
   * reported, never expected in 26AS (design §12.4). */
  fd20: BankBooksEvent[];
  /** Auto-assigned FD ledgers (addendum 3): audit rows for the workbook —
   * ledger, assigned bank, and which rule fired. Names on disk only. */
  fdAuto: { ledger: string; bank: string; rule: FdRule }[];
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
  /** Books FD-interest entries taxed at ~20% — excluded from totals, reported
   * separately (design §12.4). */
  const fd20All: BankBooksEvent[] = [];
  for (const match of matches) {
    const pushedFrom = findings.length;
    const r = reconcileParty(file, facts, match, opts.toDate);
    recons.push(r);
    const partySales = match.ledgerKeys.flatMap((k) => salesByKey.get(k) ?? []);
    const booksTaxable = sumSales(partySales, (s) => s.taxable);
    const booksGross = sumSales(partySales, (s) => s.gross);
    const summary = file.summaries.find((s) => s.kind === match.kind && s.nameKey === match.as26NameKey);
    const as26Gross = summary?.gross ?? 0;
    r.booksTaxableValue = booksTaxable;
    r.booksGrossValue = booksGross;
    r.as26GrossValue = as26Gross;

    // Totals-only parties (design §12.1): every 26AS section of the party is
    // 194R, or 194A with the operator-marked bank. Their entries are many
    // small amounts no bill-level matcher should chase; totals compare below.
    const sections = [...new Set(
      file.summaries.filter((s) => s.kind === match.kind && s.nameKey === match.as26NameKey).map((s) => s.section),
    )];
    const toks = sections.map(sectionToken);
    const bankKeyOf = new Set((map.banks ?? []).map((b) => canonicalKey(b.as26Name)));
    const isBank = toks.some((t) => t === "194a") && bankKeyOf.has(match.as26NameKey);
    const totalsOnly = toks.length > 0 &&
      toks.every((t) => t === "194r" || (t === "194a" && bankKeyOf.has(match.as26NameKey)));
    r.totalsOnly = totalsOnly;

    // 20% TDS split (design §12.4) runs whenever the operator mapped the
    // bank's interest/FD ledgers; a 20%-taxed event never reflects in 26AS
    // and is excluded from the books totals below.
    const bankMapEntry = (map.banks ?? []).find((b) => canonicalKey(b.as26Name) === match.as26NameKey);
    const bb = facts.bankEvents?.find((e) => e.nameKey === match.as26NameKey);
    let compTax = r.booksTax;
    let booksInterest = 0;
    if (isBank && bankMapEntry) {
      const events = bb?.events ?? [];
      const non20 = events.filter((e) => !isFd20(e.interest, e.tax));
      compTax = round2(non20.reduce((s, e) => s + e.tax, 0));
      booksInterest = round2(non20.reduce((s, e) => s + e.interest, 0));
      const fd20Entries = events.filter((e) => isFd20(e.interest, e.tax));
      if (fd20Entries.length > 0) {
        const fdInterest = round2(fd20Entries.reduce((s, e) => s + e.interest, 0));
        const fdTax = round2(fd20Entries.reduce((s, e) => s + e.tax, 0));
        fd20All.push(...fd20Entries);
        push("fd_20pct_tds", "review", match.as26Name, match.kind, summary?.section ?? null, fdTax,
          `${fd20Entries.length} FD interest entry/entries carry books TDS of approx 20% of the interest ` +
          `(interest ${money(fdInterest)}, tax ${money(fdTax)}): the bank deducted the higher rate, often for a ` +
          "missing PAN, and these entries are not expected to reflect in 26AS. Listed on the 'FD interest 20% TDS' sheet.");
      }
    }
    // Aggregate parties' Deductors cells must use one books-tax channel: a
    // bank's mapped-activity tax total is the operator-ledger channel the
    // totals check uses, so the per-party recon reports the same figure.
    if (isBank && bankMapEntry) r.booksTax = compTax;

    // Deductors value basis (addendum 5a): the value delta picks whichever
    // books interpretation is closest to the 26AS gross — sale taxable,
    // GST-inclusive gross, or (for interest parties) the books interest
    // credited — and the basis is reported next to the delta.
    r.booksInterestValue = booksInterest;
    const valueCands: Array<[string, number]> = [];
    if (partySales.length > 0) {
      valueCands.push(["taxable", booksTaxable], ["GST-inclusive", booksGross]);
    }
    if (booksInterest > 0) valueCands.push(["interest", booksInterest]);
    if (valueCands.length > 0) {
      const best = valueCands.reduce((b, x) =>
        Math.abs(x[1] - as26Gross) < Math.abs(b[1] - as26Gross) ? x : b);
      r.valueBasis = best[0];
      r.valueDelta = round2(best[1] - as26Gross);
    }

    // 001 — books tax beyond what 26AS declares
    if (!totalsOnly) {
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
      push("books_tax_not_in_26as", "critical", match.as26Name, match.kind, summary?.section ?? null, excessBooks, detail, schedule);
    }
    }

    // 002 — 26AS tax with no books counterpart
    if (!totalsOnly) {
    const excessAs26 = round2(r.as26Tax - r.booksTax);
    if (excessAs26 > AS26_TAX_TOLERANCE) {
      const rows = file.transactions.filter((t) => t.kind === match.kind && t.nameKey === match.as26NameKey);
      const latest = rows.reduce((m, t) => (t.bookingDate && t.bookingDate > m ? t.bookingDate : m), "00000000");
      const statuses = [...new Set(rows.map((t) => t.status))].filter(Boolean).join(", ");
      const detail =
        `26AS ${match.kind.toUpperCase()} tax of ${money(r.as26Tax)} against books tax of ${money(r.booksTax)}` +
        (latest !== "00000000" ? `; latest booking date ${displayDate(latest)}` : "") +
        (statuses ? `; booking statuses seen: ${statuses}` : "");
      push("as26_tax_not_in_books", "critical", match.as26Name, match.kind, summary?.section ?? null, excessAs26, detail);
    }
    }

    // 003 — 26AS gross vs books taxable: taxable-only (captain deviation; the
    // GST-inclusive alternative is dropped from this check and re-homesteaded on
    // the Deductors sheet, whose column totals are populated elsewhere).
    if (as26Gross > 0 && partySales.length > 0) {
      const dTok = Math.abs(round2(as26Gross - booksTaxable));
      if (dTok > AS26_VALUE_TOLERANCE) {
        push(
          "assessable_value_mismatch", "warning", match.as26Name, match.kind, summary?.section ?? null,
          dTok,
          `26AS gross receipts of ${money(as26Gross)} against books taxable of ${money(booksTaxable)}: the books taxable is out by ${money(dTok)} (tolerance ${money(AS26_VALUE_TOLERANCE)}). Bill-level value rows, where present, carry the per-invoice detail.`,
        );
      }
    }

    // 007 — totals reconcile but the item-level picture is left over
    if (!totalsOnly) {
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
        "unresolved_combination", "review", match.as26Name, match.kind, summary?.section ?? null,
        Math.max(sumB, sumA),
        `Totals reconcile within tolerance (${money(r.booksTax)} books against ${money(r.as26Tax)} 26AS) but ` +
        `${r.unmatchedBooks.length} books item(s) and ${r.unmatchedAs26.length} 26AS item(s) stay unexplained` +
        (r.ambiguous > 0 ? ` with ${count(r.ambiguous)} ambiguous combination(s)` : "") +
        "; likely offsetting entries.",
        leftovers,
      );
    }
    }

    // 005 — 26AS credits landed outside the reviewed window
    if (r.lateBookedTax > 0) {
      push(
        "late_booking", "review", match.as26Name, match.kind, summary?.section ?? null, r.lateBookedTax,
        `${money(r.lateBookedTax)} of 26AS tax was booked after ${displayDate(opts.toDate)} — outside the reviewed window, so books and export totals may reconcile once the window is extended (timing possible).`,
      );
    }

    // 008 — deductions without any sale entry for the customer. A tcs-kind
    // party never needs one: TCS rides purchases (the seller collects it),
    // so "no sale entry" is the normal shape, not an anomaly (addendum 8).
    if (!totalsOnly) {
    if (r.booksTax > 0 && partySales.length === 0 && match.kind === "tds") {
      push(
        "deduction_without_sale", "review", match.as26Name, match.kind, summary?.section ?? null, r.booksTax,
        "Books carry the deduction but no sale entry exists for this customer in the period — the deduction may sit against a prior-period sale or a receipt (not asserted).",
      );
    }
    }

    // 009 — totals-only reconciliation (design §12.3): 194R and bank-194A
    // parties compare aggregates, not items. Books side: 194R uses the
    // ordinary deduction events, a bank uses its operator-mapped interest/FD
    // ledgers (with the 20% events already split off). The books tax total
    // is compared against the 26AS tax total with AS26_TAX_TOLERANCE; a
    // bank's interest total additionally against the 26AS gross with
    // AS26_VALUE_TOLERANCE. A bank marked but mapped with no ledgers at all
    // cannot produce a books side, so it surfaces as review, not critical.
    if (totalsOnly) {
      const mappingEmpty = !!bankMapEntry &&
        bankMapEntry.interestLedgers.length === 0 && bankMapEntry.fdLedgers.length === 0;
      const taxDelta = round2(r.as26Tax - compTax);
      const taxMiss = !mappingEmpty && Math.abs(taxDelta) > AS26_TAX_TOLERANCE;
      const valMiss = isBank && !mappingEmpty && as26Gross > 0 &&
        Math.abs(round2(as26Gross - booksInterest)) > AS26_VALUE_TOLERANCE;
      if (taxMiss || valMiss || mappingEmpty) {
        const secLabel = sections.length > 0 ? sections.join(", ") : "no section";
        const head = `26AS ${match.kind.toUpperCase()} ${secLabel} totals: tax ${money(r.as26Tax)}` +
          (as26Gross > 0 ? `, amount paid/credited ${money(as26Gross)}` : "");
        if (mappingEmpty) {
          push("as26_totals_mismatch", "review", match.as26Name, match.kind, summary?.section ?? null, r.as26Tax,
            `${head}. The Bank Interest mapping names this bank but none of its interest income or FD ledgers, ` +
            "so no books totals could be compared; fill the ledger names and re-run.");
        } else {
          const bits = [`books tax total ${money(compTax)}`];
          if (valMiss) bits.unshift(`books interest total ${money(booksInterest)} against`);
          push("as26_totals_mismatch", taxMiss ? "critical" : "warning", match.as26Name, match.kind,
            summary?.section ?? null, taxMiss ? Math.abs(taxDelta) : Math.abs(round2(as26Gross - booksInterest)),
            taxMiss
              ? `${head}; ${bits.join(", ")}. These sections reconcile on totals, never bill by bill.`
              : `${head}; ${bits.join(", ")}. The tax totals tie but the interest does not.`,
          );
        }
      }
    }
    // Plain words on skip (addendum 5a): when the bounded item-combination
    // search was skipped for this party, every finding raised for the party
    // says so in plain words — the reader must know those items were not
    // tried. Invoice-linked group matching still ran; it is not bounded.
    if (r.combinationSearchSkipped && pushedFrom < findings.length) {
      const note = ` The bounded item-combination search was skipped for this party (${r.unmatchedBooks.length} books and ${r.unmatchedAs26.length} 26AS items were already too many to search — invoice-linked group matching still ran), so its leftover items were not tried one by one.`;
      for (let k = pushedFrom; k < findings.length; k += 1) findings[k].detail += note;
    }
  }

  // Addendum 3 — FD ledgers that could not be auto-assigned to any Bank
  // Interest bank: one review finding, counts and amounts only; the ledger
  // names appear on the workbook's auto-assignment sheet, never here.
  if (facts.fdAuto && facts.fdAuto.unassigned.length > 0) {
    push("fd_ledgers_unassigned", "review", "FD ledgers (unassigned)", "tds", null, facts.fdAuto.interest,
      `${facts.fdAuto.unassigned.length} fixed-deposit ledger(s) under Deposits (Asset) could not be assigned to any ` +
      `bank on the Bank Interest sheet (interest-side credit ${money(facts.fdAuto.interest)}): neither a distinctive ` +
      "name token nor a single listed bank resolved them. Listed on the 'FD ledger auto-assign' sheet with the rule " +
      "that fired for the assigned ones — map them explicitly there if they belong to a bank.");
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
  return { findings, recon: recons, gaps, totals, skipped: file.skipped, fd20: fd20All, fdAuto: (facts.fdAuto?.rows ?? []).filter((r) => r.bank && r.rule).map((r) => ({ ledger: r.ledger, bank: r.bank as string, rule: r.rule as FdRule })) };
}
