import type { LedgerVoucherRow } from "./downstream.js";
import { dayBefore, displayDate, displayMonth, money } from "./format.js";
import { canonicalKey } from "./key.js";
import {
  ledgerFindingId,
  sideOf,
  TOTALS_TOLERANCE,
  ZERO_TOLERANCE,
  type GroupRole,
  type LedgerCheckId,
  type Severity,
  type Side,
} from "./types.js";

/** An entry is "large" above this multiple of the ledger's median entry. */
export const LARGE_ENTRY_FACTOR = 5;
/** Median-based checks need at least this many rows to mean anything. */
export const MIN_ROWS_FOR_STATS = 6;
/** Round-sum journals: at least this amount, and an exact multiple of the unit. */
export const ROUND_SUM_FLOOR = 10_000;
export const ROUND_SUM_UNIT = 1_000;
/** A month "spikes" above this multiple of the median active month's gross movement. */
export const MONTH_SPIKE_FACTOR = 3;
/** Month-based checks need at least this many active months. */
export const MIN_ACTIVE_MONTHS = 3;
/** Effective GST rates (%) a tax-bearing entry can legitimately show, incl. composite/cess-free slabs. */
export const GST_RATE_SLABS: readonly number[] = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
/** Effective rate is computed from rounded tax amounts; allow this much drift (percentage points). */
export const GST_RATE_TOLERANCE = 0.1;

/** Same role -> side map as M1's wrong_side_balance, plus cash (never credit). Bank is omitted: OD is legitimate. */
const EXPECTED_SIDE: Partial<Record<GroupRole, Side>> = {
  debtor: "Dr",
  creditor: "Cr",
  cash: "Dr",
  expense: "Dr",
  income: "Cr",
  stock: "Dr",
};

/** Everything one scrutiny needs, all UNMASKED. Pure function input. */
export interface ScrutinyInput {
  /** Real ledger name. */
  ledger: string;
  group: string;
  role: GroupRole;
  /** The ledger master's GSTIN (M2 tax-ID channel), or null. Never output raw. */
  gstin: string | null;
  /** Session-stable per-ledger sequence used in finding ids. */
  ledgerSeq: number;
  fromDate: string;
  toDate: string;
  /** Balance at the close of the day before fromDate; positive = debit. */
  opening: number;
  /** Balance at the close of toDate; positive = debit. */
  closing: number;
  rows: LedgerVoucherRow[];
}

export interface ScrutinyFinding {
  id: string;
  check: LedgerCheckId;
  severity: Severity;
  /** Real ledger name; the session masks it. */
  ledger: string;
  group: string;
  amount: number;
  side: Side | null;
  expected: Side | null;
  /** Real names and the raw GSTIN may appear here; the session masks before output. */
  detail: string;
  /** Real counterparty names the detail mentions, for the session to vault before its sweep. */
  counterparties: string[];
}

export interface MonthMovement {
  /** "YYYY-MM" */
  month: string;
  debit: number;
  credit: number;
  /** debit - credit */
  net: number;
  entries: number;
}

export interface ScrutinyView {
  opening: number;
  closing: number;
  totalDebit: number;
  totalCredit: number;
  netMovement: number;
  rowsScanned: number;
  /** Every calendar month from fromDate to toDate, zero months included. */
  months: MonthMovement[];
}

type Add = (
  check: LedgerCheckId,
  f: Omit<ScrutinyFinding, "id" | "check" | "ledger" | "group">,
) => void;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "82,500.00 Dr", or "nil" inside the rounding tolerance. */
function bal(n: number): string {
  const side = sideOf(n);
  return side ? `${money(Math.abs(n))} ${side}` : "nil";
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const vch = (r: LedgerVoucherRow): string =>
  `${r.voucherType || "Voucher"} ${r.voucherNumber || "(no number)"}`;

const party = (r: LedgerVoucherRow): string => r.counterparty || "no counterparty";

const monthOf = (date: string): string => `${date.slice(0, 4)}-${date.slice(4, 6)}`;

function monthsBetween(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  let y = Number(fromDate.slice(0, 4));
  let m = Number(fromDate.slice(4, 6));
  const endY = Number(toDate.slice(0, 4));
  const endM = Number(toDate.slice(4, 6));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n || seen.has(canonicalKey(n))) continue;
    seen.add(canonicalKey(n));
    out.push(n);
  }
  return out;
}

/**
 * Single-ledger scrutiny (M3). Pure: unmasked data in, unmasked findings out,
 * in LEDGER_CHECK_ORDINAL order. Severity is fixed by the rule, never by the model.
 */
export function scrutinize(input: ScrutinyInput): { view: ScrutinyView; findings: ScrutinyFinding[] } {
  const rows = [...input.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const view = movementView(input, rows);
  const findings: ScrutinyFinding[] = [];
  const counters = new Map<LedgerCheckId, number>();
  const add: Add = (check, f) => {
    const n = (counters.get(check) ?? 0) + 1;
    counters.set(check, n);
    findings.push({
      id: ledgerFindingId(check, input.ledgerSeq, n),
      check,
      ledger: input.ledger,
      group: input.group,
      ...f,
    });
  };

  openingClosingMismatch(input, view, add);
  wrongSideDuringPeriod(input, rows, add);
  duplicateEntries(rows, add);
  duplicateReferences(rows, add);
  largeEntries(rows, add);
  roundSumJournals(rows, add);
  movementSpikes(input, view, add);
  activityGaps(input, view, add);
  unjoinedRows(rows, add);
  gstRateNonstandard(input, rows, add);
  gstUntaxedSupply(input, rows, add);

  return { view, findings };
}

function movementView(input: ScrutinyInput, rows: LedgerVoucherRow[]): ScrutinyView {
  const months = new Map<string, MonthMovement>();
  for (const month of monthsBetween(input.fromDate, input.toDate)) {
    months.set(month, { month, debit: 0, credit: 0, net: 0, entries: 0 });
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const r of rows) {
    const key = monthOf(r.date);
    let m = months.get(key);
    if (!m) {
      m = { month: key, debit: 0, credit: 0, net: 0, entries: 0 };
      months.set(key, m);
    }
    if (r.amount > 0) {
      m.debit += r.amount;
      totalDebit += r.amount;
    } else {
      m.credit -= r.amount;
      totalCredit -= r.amount;
    }
    m.net += r.amount;
    m.entries += 1;
  }
  return {
    opening: round2(input.opening),
    closing: round2(input.closing),
    totalDebit: round2(totalDebit),
    totalCredit: round2(totalCredit),
    netMovement: round2(totalDebit - totalCredit),
    rowsScanned: rows.length,
    months: [...months.values()].map((m) => ({
      ...m,
      debit: round2(m.debit),
      credit: round2(m.credit),
      net: round2(m.net),
    })),
  };
}

/** 1. Balance anomaly: opening + movement must reach closing. */
function openingClosingMismatch(input: ScrutinyInput, view: ScrutinyView, add: Add): void {
  const reached = round2(view.opening + view.netMovement);
  const diff = round2(view.closing - reached);
  if (Math.abs(diff) <= TOTALS_TOLERANCE) return;
  add("ls_opening_closing_mismatch", {
    severity: "warning",
    amount: Math.abs(diff),
    side: null,
    expected: null,
    detail:
      `${input.ledger}: the balance brought forward on ${displayDate(dayBefore(input.fromDate))} ` +
      `(${bal(view.opening)}) plus the period movement (${bal(view.netMovement)}) reaches ` +
      `${bal(reached)}, but the balance on ${displayDate(input.toDate)} is ${bal(view.closing)} — ` +
      `a difference of ${money(Math.abs(diff))}. The voucher listing may be incomplete: an ` +
      `optional or post-dated voucher, or a month the ledger report did not return.`,
    counterparties: [],
  });
}

/** 2. Balance anomaly: running balance on the wrong side at the close of any posting day. */
function wrongSideDuringPeriod(input: ScrutinyInput, rows: LedgerVoucherRow[], add: Add): void {
  const expected = EXPECTED_SIDE[input.role];
  if (!expected || rows.length === 0) return;
  // End-of-day balances: a receipt and a payment on the same day must not
  // read as an intra-day flip.
  const dayNet = new Map<string, number>();
  for (const r of rows) dayNet.set(r.date, (dayNet.get(r.date) ?? 0) + r.amount);
  let running = input.opening;
  let first = "";
  let count = 0;
  let peak = 0;
  for (const [date, net] of dayNet) {
    running = round2(running + net);
    const side = sideOf(running);
    if (!side || side === expected) continue;
    count += 1;
    if (!first) first = date;
    peak = Math.max(peak, Math.abs(running));
  }
  if (count === 0) return;
  const wrong: Side = expected === "Dr" ? "Cr" : "Dr";
  const word = (s: Side) => (s === "Dr" ? "debit" : "credit");
  add("ls_wrong_side_during_period", {
    severity: input.role === "cash" ? "critical" : "warning",
    amount: peak,
    side: wrong,
    expected,
    detail:
      `${input.ledger} in ${input.group} stood on the ${word(wrong)} side at the close of ` +
      `${count} of ${dayNet.size} posting days in the period, first on ${displayDate(first)}, ` +
      `peaking at ${money(peak)}; a ${word(expected)} balance is expected`,
    counterparties: [],
  });
}

/** 3. Voucher level: same date, type, counterparty and signed amount on two or more entries. */
function duplicateEntries(rows: LedgerVoucherRow[], add: Add): void {
  const groups = new Map<string, LedgerVoucherRow[]>();
  for (const r of rows) {
    if (Math.abs(r.amount) < ZERO_TOLERANCE) continue;
    const key = [r.date, canonicalKey(r.voucherType), canonicalKey(r.counterparty), r.amount.toFixed(2)].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const r = g[0];
    add("ls_duplicate_entry", {
      severity: "warning",
      amount: Math.abs(r.amount),
      side: sideOf(r.amount),
      expected: null,
      detail:
        `${g.length} ${r.voucherType || "voucher"} entries on ${displayDate(r.date)} against ` +
        `${party(r)} for ${bal(r.amount)} each ` +
        `(${g.map((x) => x.voucherNumber || "(no number)").join(", ")}) — a possible double booking`,
      counterparties: uniqueNames([r.counterparty]),
    });
  }
}

/** 4. Voucher level: one reference (bill number) on two or more distinct vouchers of a type. */
function duplicateReferences(rows: LedgerVoucherRow[], add: Add): void {
  const groups = new Map<string, LedgerVoucherRow[]>();
  for (const r of rows) {
    if (!r.reference.trim()) continue;
    const key = `${canonicalKey(r.voucherType)}|${canonicalKey(r.reference)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const g of groups.values()) {
    const numbers = new Set(g.map((r) => r.voucherNumber).filter(Boolean));
    if (numbers.size < 2) continue;
    const shapes = new Set(g.map((r) => `${r.date}|${r.amount.toFixed(2)}|${canonicalKey(r.counterparty)}`));
    // Identical rows are ls_duplicate_entry's finding; do not report them twice.
    if (shapes.size === 1) continue;
    add("ls_duplicate_reference", {
      severity: "warning",
      amount: round2(g.reduce((s, r) => s + Math.abs(r.amount), 0)),
      side: null,
      expected: null,
      detail:
        `${g.length} ${g[0].voucherType || "voucher"} vouchers carry the same reference: ` +
        g.map((r) => `${r.voucherNumber || "(no number)"} (${displayDate(r.date)}, ${bal(r.amount)}, ${party(r)})`).join("; ") +
        ` — the same bill may be booked twice`,
      counterparties: uniqueNames(g.map((r) => r.counterparty)),
    });
  }
}

/** 5. Voucher level: an entry far above the ledger's median entry. */
function largeEntries(rows: LedgerVoucherRow[], add: Add): void {
  if (rows.length < MIN_ROWS_FOR_STATS) return;
  const med = median(rows.map((r) => Math.abs(r.amount)));
  if (med < ZERO_TOLERANCE) return;
  for (const r of rows) {
    const ratio = Math.abs(r.amount) / med;
    if (ratio <= LARGE_ENTRY_FACTOR) continue;
    add("ls_large_entry", {
      severity: "review",
      amount: Math.abs(r.amount),
      side: sideOf(r.amount),
      expected: null,
      detail:
        `${vch(r)} on ${displayDate(r.date)} against ${party(r)} posts ${bal(r.amount)}, ` +
        `${ratio.toFixed(1)} times the ledger's median entry of ${money(med)}`,
      counterparties: uniqueNames([r.counterparty]),
    });
  }
}

/** 6. Voucher level: a round-figure journal (estimates and provisions without a working). */
function roundSumJournals(rows: LedgerVoucherRow[], add: Add): void {
  for (const r of rows) {
    const abs = Math.abs(r.amount);
    if (!canonicalKey(r.voucherType).includes("journal") || abs < ROUND_SUM_FLOOR) continue;
    const rem = abs % ROUND_SUM_UNIT;
    if (rem > ZERO_TOLERANCE && ROUND_SUM_UNIT - rem > ZERO_TOLERANCE) continue;
    add("ls_round_sum_journal", {
      severity: "review",
      amount: abs,
      side: sideOf(r.amount),
      expected: null,
      detail:
        `${vch(r)} on ${displayDate(r.date)} against ${party(r)} posts a round ${bal(r.amount)}; ` +
        `round-figure journals are often estimates or provisions — confirm the working behind it`,
      counterparties: uniqueNames([r.counterparty]),
    });
  }
}

/** 7. Period movement: a month whose gross movement dwarfs the median active month. */
function movementSpikes(input: ScrutinyInput, view: ScrutinyView, add: Add): void {
  const active = view.months.filter((m) => m.entries > 0);
  if (active.length < MIN_ACTIVE_MONTHS) return;
  const gross = (m: MonthMovement) => round2(m.debit + m.credit);
  const med = median(active.map(gross));
  if (med < ZERO_TOLERANCE) return;
  for (const m of active) {
    const ratio = gross(m) / med;
    if (ratio <= MONTH_SPIKE_FACTOR) continue;
    add("ls_movement_spike", {
      severity: "review",
      amount: gross(m),
      side: null,
      expected: null,
      detail:
        `${input.ledger} moved ${money(gross(m))} in ${displayMonth(m.month)} across ${m.entries} ` +
        `entries, ${ratio.toFixed(1)} times its median active month of ${money(med)}`,
      counterparties: [],
    });
  }
}

/** 8. Period movement: silent months inside a recurring expense/income ledger's active span. */
function activityGaps(input: ScrutinyInput, view: ScrutinyView, add: Add): void {
  if (input.role !== "expense" && input.role !== "income") return;
  const activeIdx = view.months.flatMap((m, i) => (m.entries > 0 ? [i] : []));
  if (activeIdx.length < MIN_ACTIVE_MONTHS) return;
  const span = view.months.slice(activeIdx[0], activeIdx[activeIdx.length - 1] + 1);
  const gaps = span.filter((m) => m.entries === 0);
  if (gaps.length === 0) return;
  add("ls_activity_gap", {
    severity: "review",
    amount: 0,
    side: null,
    expected: null,
    detail:
      `${input.ledger}, ${input.role === "expense" ? "an expense" : "an income"} ledger active in ` +
      `${activeIdx.length} months of the period, has no entries in ` +
      `${gaps.map((m) => displayMonth(m.month)).join(", ")} between its first and last active ` +
      `month — check for a missed booking or provision`,
    counterparties: [],
  });
}

/** 9. Voucher level: rows the downstream could not join exactly to a voucher. */
function unjoinedRows(rows: LedgerVoucherRow[], add: Add): void {
  const bad = rows.filter((r) => r.matchStatus === "ambiguous" || r.matchStatus === "unmatched");
  if (bad.length === 0) return;
  const ambiguous = bad.filter((r) => r.matchStatus === "ambiguous").length;
  add("ls_unjoined_rows", {
    severity: "review",
    amount: round2(bad.reduce((s, r) => s + Math.abs(r.amount), 0)),
    side: null,
    expected: null,
    detail:
      `${bad.length} of ${rows.length} entries could not be joined exactly to their vouchers ` +
      `(${ambiguous} ambiguous, ${bad.length - ambiguous} unmatched); their voucher numbers, ` +
      `references and tax breakup are unreliable — confirm them in Tally before relying on the ` +
      `duplicate and GST checks`,
    counterparties: [],
  });
}

/** 10. GST: an exactly-joined tax breakup whose effective rate is no GST slab. */
function gstRateNonstandard(input: ScrutinyInput, rows: LedgerVoucherRow[], add: Add): void {
  for (const r of rows) {
    if (!r.tax || r.tax.taxStatus !== "matched" || r.tax.effectiveRatePct === null) continue;
    const pct = r.tax.effectiveRatePct;
    if (GST_RATE_SLABS.some((s) => Math.abs(s - pct) <= GST_RATE_TOLERANCE + 1e-9)) continue;
    add("ls_gst_rate_nonstandard", {
      severity: "review",
      amount: Math.abs(r.amount),
      side: sideOf(r.amount),
      expected: null,
      detail:
        `${vch(r)} on ${displayDate(r.date)} against ${party(r)}: tax is ${pct.toFixed(2)}% of the ` +
        `taxable value, which is not a standard GST rate` +
        (input.gstin ? `; the party is registered as ${input.gstin}` : ""),
      counterparties: uniqueNames([r.counterparty]),
    });
  }
}

/** 11. GST: a registered party's sales/purchase voucher with no tax lines at all. */
function gstUntaxedSupply(input: ScrutinyInput, rows: LedgerVoucherRow[], add: Add): void {
  if (!input.gstin) return;
  for (const r of rows) {
    const type = canonicalKey(r.voucherType);
    if (!type.includes("purchase") && !type.includes("sales")) continue;
    if (!r.tax || r.tax.taxStatus !== "no-tax-rows") continue;
    add("ls_gst_untaxed_supply", {
      severity: "review",
      amount: Math.abs(r.amount),
      side: sideOf(r.amount),
      expected: null,
      detail:
        `${vch(r)} on ${displayDate(r.date)} (${bal(r.amount)}) carries no GST lines although ` +
        `${input.ledger} is registered as ${input.gstin} — check for reverse charge, an exempt ` +
        `or nil-rated supply, or a missed tax entry`,
      counterparties: [],
    });
  }
}
