import type { LedgerVoucherRow } from "./downstream.js";
import { money, displayDate } from "./format.js";
import { calendarMonths, depositDue, interestOn, lateFeePerDay, lawOf, s139DueDate, statementDue, timingOnlySection } from "./tds-law.js";
import type { OperatorFile } from "./tds-file.js";
import { canonicalKey } from "./key.js";
import { tdsFindingId, type TdsCheckId, type TdsFinding, type TdsScheduleRow } from "./types.js";

/**
 * The TDS engine: pure functions of its inputs. Joins monthly
 * Ledger-Vouchers report rows (the one server-side date filter that works on
 * the large company; never the Day Book) into per-deductee, per-section
 * event streams, applies the `src/tds-law.ts` table, and emits findings in
 * the TDS- ordinal space with interest-schedule rows. Design of record:
 * docs/design/2026-09-14-tds-compliance-review-design.md §7.
 */

export const TDS_TOLERANCE = 1.0; // the per-row tolerance philosophy at a TDS-sized figure

/**
 * The per-deductee, per-year short-deduction floor (2026-09-26o item 3,
 * captain): a party's total short-deducted tax for the year below ₹100 is not
 * reported. Individual short rows are staged and emitted only for a party
 * whose FY total reaches the floor, so the floor is measured across every
 * section and every booking of that deductee, never per row.
 */
export const SHORT_DEDUCTION_MIN = 100;

export interface TdsLedgerRows {
  ledger: string;
  rows: LedgerVoucherRow[];
}

export interface TdsPeriod {
  fromDate: string; // YYYYMMDD
  toDate: string;   // YYYYMMDD
}

/**
 * One subsequent-year deposit allocation (2026-09-26i): the filed return's
 * challan-to-deductee link, with the Winman name already joined to the Tally
 * ledger by the caller. The engine matches it against a book deduction of
 * the same party, section, deduction month and tax.
 */
export interface SubsequentDeposit {
  /** The Tally ledger the Winman deductee name joined to. */
  party: string;
  section: string;
  tax: number;
  /** The return's deduction date (YYYYMMDD). */
  dedDate: string;
  /** The challan's deposit date (YYYYMMDD). */
  depositDate: string;
  /**
   * The challan's own interest (2026-09-26p): the interest actually paid on
   * the late deposit, read from the Winman challan's Interest column. 0 when
   * absent. Never hard-coded.
   */
  interestPaid?: number;
  /** The challan's `ID No.` (2026-09-26p) — its identity for interest dedupe. */
  challanId?: string;
}

export interface TdsCtx {
  tdsParties: string[];
  /**
   * A booking's section comes from the expense ledger it is booked to and
   * from nothing else (the captain's revision-2 ruling — the party argument
   * is deliberately absent so no future change can reintroduce a party→section
   * coupling without changing the type). Zero mapped sections → `{ null, [] }`;
   * two or more → `{ null, candidates }`, never a pick, never a guess.
   */
  resolveSection(expenseLedger: string): { section: string | null; candidates: string[] };
  dutySectionOf(dutyLedger: string): string | null;
  /**
   * Every section the operator mapping declares for the duty ledger (empty
   * when the ledger is unmapped or unambiguous). Present only when the caller
   * supports the per-row disambiguation of an ambiguous duty ledger
   * (2026-09-26c): without it, an ambiguous ledger's rows are skipped whole.
   */
  dutyCandidatesOf?(dutyLedger: string): string[];
  panKeyOf(party: string): string | null;
  /** True when `panKeyOf`'s PAN was derived from the ledger's GSTIN (no master PAN). */
  panDerivedFromGstinOf?(party: string): boolean;
  entityOf(party: string): "P" | "H" | "C" | "F" | "A" | "B" | "T" | "L" | "J" | "G" | null;
  certificateRateOf(party: string, section: string, date: string): number | null;
  transporterDeclared(party: string): boolean;
  deducteeFiledReturn(party: string): boolean;
  asOnDate: string;
  period: TdsPeriod;
  /**
   * Subsequent-year challan allocations (2026-09-26i). Absent (or empty)
   * reproduces the old behaviour exactly: only the books' deposit debits
   * count as deposit evidence.
   */
  subsequentDeposits?: SubsequentDeposit[];
  /**
   * Whether s.201(1A) 1%-per-month interest on a LATE DEDUCTION is computed
   * (2026-09-26r inbox 067). Absent means enabled; the only false case is the
   * operator template disabling the charge (the captain's option for companies
   * that treat it as not applicable). Late-DEPOSIT interest (1.5%) is never
   * affected.
   */
  lateDeductionInterest?: boolean;
}

export interface TdsBooking {
  date: string;
  voucherNumber: string;
  party: string;
  gross: number;
  ledger: string;
  section: string | null;
  /** The law-table sections a multi-mapped ledger declared (empty when unmapped). */
  candidates: string[];
  /** Stamps: the chargeable base and the rate actually applied by the engine. */
  liable?: number;
  rateApplied?: number;
  viaCertificate?: boolean;
}

export interface TdsPayment {
  date: string;
  voucherNumber: string;
  party: string;
  amount: number;
}

export interface TdsDeduction {
  date: string;
  voucherNumber: string;
  party: string;
  tax: number;
  section: string;
  joinedTo: string | null;
  booking?: TdsBooking;
  /** The duty ledger the credit was read from (set on ambiguous-ledger rows). */
  ledger?: string;
  /** How the credit's section was resolved (2026-09-26f): same-voucher, same-date bill, or nearest bill, N days. */
  resolvedBy?: string;
  /** The bill (date|voucherNumber) that resolved an ambiguous credit, when one was linked. */
  linkedBill?: string;
  /** Month-level deposit coverage (2026-09-26e): the month's lump deposits cover this credit; not a non-deposit. */
  depositCovered?: boolean;
  /**
   * Subsequent-year deposit coverage (2026-09-26i): the filed return's
   * challan (deposit date YYYYMMDD) covers this credit. Deposited, but after
   * the financial year-end — never a non-deposit, and never a s.40(a)(ia)
   * row while the challan date is on or before the s.139(1) due date.
   */
  subsequentDeposit?: string;
  /**
   * The interest actually paid on a subsequent-year challan (2026-09-26p),
   * read from the Winman challan's Interest column — reported against the
   * s.201(1A) interest the engine computes for that late deposit.
   */
  subsequentInterestPaid?: number;
  /** The subsequent challan's `ID No.` (2026-09-26p) for interest dedupe. */
  subsequentChallanId?: string;
  /** Stamps: the per-deduction s.201(1A) interest components. */
  interestI?: number;
  interestII?: number;
}

export interface TdsDeposit {
  date: string;
  party: string;
  tax: number;
  /**
   * Null only for a deposit read from an ambiguous duty ledger: the row
   * itself carries no section evidence, so it joins only a deduction of the
   * same duty ledger (see joinEvents).
   */
  section: string | null;
  /** The duty ledger the debit was read from (set on ambiguous-ledger rows). */
  ledger?: string;
  deduction?: TdsDeduction;
}

/**
 * A credit to an expense/purchase ledger whose counterparty is a TDS party —
 * a debit note, or any reversal of a charge (2026-09-26o items 4/5). It
 * reduces the base the section's liability is measured on. `amount` is the
 * magnitude (positive); the row it came from was a credit downstream of the
 * gateway.
 */
export interface TdsReduction {
  date: string;
  voucherNumber: string;
  party: string;
  amount: number;
  ledger: string;
  section: string;
}

export interface TdsEvents {
  bookings: TdsBooking[];
  payments: TdsPayment[];
  deductions: TdsDeduction[];
  deposits: TdsDeposit[];
  reductions?: TdsReduction[];
}

export interface TdsLiability {
  booking: TdsBooking;
  section: string;          // law key, e.g. "194-I(a)"
  liableBase: number;       // the engine's per-booking base (194Q: cumulative excess rule)
  liability: number;        // round2(rate * liableBase) as the engine computed it
  rate: number;             // rate applied (certificate/206AA-adjusted)
  deduction: TdsDeduction | null;  // joined by the engine (d.booking === booking)
}

export interface TdsSectionTotals {
  section: string;
  gross: number;
  tax: number;
}

export interface TdsTotals {
  bySection: TdsSectionTotals[];
  notDeducted: number;
  shortDeducted: number;
  interestI: number;
  interestIi: number;
}

const ZERO = 0.005;
const S206AA_RATE = 0.2;
/** Nearest-bill fallback window (2026-09-26f): measured gaps are 2–4 days; the cap stays bounded. */
const NEAREST_BILL_CAP_DAYS = 15;
const isDebit = (r: LedgerVoucherRow): boolean => r.amount > ZERO;
const byDate = (rows: readonly LedgerVoucherRow[]): LedgerVoucherRow[] =>
  [...rows].sort((a, b) => a.date.localeCompare(b.date));
/** Sorted, deduplicated list — used for the candidate enums named in a finding. */
const uniqueList = (xs: string[]): string[] => [...new Set(xs)].sort();

function dateDiffDays(a: string, b: string): number {
  const ta = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(4, 6)) - 1, Number(a.slice(6, 8)));
  const tb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(4, 6)) - 1, Number(b.slice(6, 8)));
  return Math.round((ta - tb) / 86_400_000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The deductee key (2026-09-26o item 2): one deductee (one PAN) may own
 * several Tally ledgers — a customer split across a site ledger and a
 * head-office ledger, with the balance journaled between them. Every
 * per-party grouping (aggregates, month liability/credit maps, joins, the
 * subsequent-year challan match) keys on the PAN when one is known, else the
 * canonical ledger name, so the site ledger's bills and the head-office
 * ledger's duty credits meet in one aggregate. Without a PAN this is exactly
 * the old grouping, only canonicalized.
 */
export function deducteeKeyOf(ctx: Pick<TdsCtx, "panKeyOf">, party: string): string {
  return ctx.panKeyOf(party) ?? `ledger:${canonicalKey(party)}`;
}

/**
 * The section rate for a booking: an s.197 certificate overrides within its
 * window (the ctx resolves it); the PAN's 4th character picks the
 * individual/HUF vs others rate; a deductee without a PAN books the s.206AA
 * figure — the higher of the section rate or 20%.
 */
export function rateFor(
  ctx: Pick<TdsCtx, "certificateRateOf" | "entityOf" | "panKeyOf">,
  party: string,
  section: string,
  date: string,
): { rate: number; via206AA: boolean } {
  const law = lawOf(section)!;
  const certified = ctx.certificateRateOf(party, section, date);
  if (certified !== null) return { rate: certified, via206AA: false };
  const entity = ctx.entityOf(party);
  const base =
    (entity && law.rates.pan4thChar?.[entity]) ?? law.rates.standard;
  if (!ctx.panKeyOf(party)) {
    return { rate: Math.max(base, S206AA_RATE), via206AA: true };
  }
  return { rate: base, via206AA: false };
}

/**
 * Extract the raw event streams. Duty-ledger sections come from the operator
 * map (`dutySectionOf`); a duty ledger with no mapped section is skipped —
 * never guessed. A booking is a **debit** row on an expense/purchase ledger
 * whose counterparty is a TDS party (a normal `Dr Expense / Cr Party`
 * voucher; downstream of the gateway positive = debit, R-MCP-5);
 * a payment or advance is a debit row on the TDS party's own ledger; a duty
 * credit names the deduction, a duty debit the deposit.
 */
export function extractEvents(
  dutyLedgers: TdsLedgerRows[],
  expenseLedgers: TdsLedgerRows[],
  partyLedgers: TdsLedgerRows[],
  ctx: Pick<TdsCtx, "tdsParties" | "resolveSection" | "dutySectionOf" | "dutyCandidatesOf">,
): TdsEvents {
  const tdsParties = new Set(ctx.tdsParties);
  const bookings: TdsBooking[] = [];
  const payments: TdsPayment[] = [];
  const deductions: TdsDeduction[] = [];
  const deposits: TdsDeposit[] = [];
  const reductions: TdsReduction[] = [];

  for (const { ledger, rows } of expenseLedgers) {
    const res = ctx.resolveSection(ledger);
    // A timing-only section's expense debit is a booking even when its
    // counterparty is not a declared TDS party (194T, 2026-09-26o item 035):
    // partner remuneration is credited to the partners' Capital Accounts,
    // which are not vendor parties, and the operator's 194T mapping is the
    // liability signal. The deduction is deposit-monitored section-level
    // below; no not-deducted/threshold finding is ever raised for it.
    const timingOnly = res.section !== null && timingOnlySection(res.section);
    for (const r of byDate(rows)) {
      if (!tdsParties.has(r.counterparty) && !(timingOnly && r.counterparty !== "")) continue;
      if (isDebit(r)) {
        bookings.push({
          date: r.date,
          voucherNumber: r.voucherNumber,
          party: r.counterparty,
          gross: r.amount,
          ledger,
          section: res.section,
          candidates: res.candidates,
        });
      } else if (res.section !== null && Math.abs(r.amount) > ZERO) {
        // A credit on a section-mapped expense ledger whose counterparty is a
        // TDS party (2026-09-26o items 4/5): a debit note, or any reversal of
        // a charge. It reduces the base of the same ledger+deductee's charges
        // — netted in netDebitNotes, never treated as a booking of its own.
        reductions.push({
          date: r.date,
          voucherNumber: r.voucherNumber,
          party: r.counterparty,
          amount: Math.abs(r.amount),
          ledger,
          section: res.section,
        });
      }
    }
  }
  for (const { ledger, rows } of partyLedgers) {
    if (!tdsParties.has(ledger)) continue;
    for (const r of byDate(rows)) {
      if (isDebit(r)) {
        payments.push({
          date: r.date,
          voucherNumber: r.voucherNumber,
          party: ledger,
          amount: r.amount,
        });
      }
    }
  }
  // Voucher composition over the fetched expense ledgers (2026-09-26c): the
  // evidence a duty credit's section is resolved from when its own duty
  // ledger maps to more than one section. Only fetched ledgers appear, which
  // is enough — the evidence is always an expense-side debit.
  const expenseByVoucher = new Map<string, { ledger: string; row: LedgerVoucherRow }[]>();
  const expenseByDate = new Map<string, { ledger: string; row: LedgerVoucherRow }[]>();
  for (const { ledger, rows } of expenseLedgers) {
    for (const r of rows) {
      if (!r.voucherNumber) continue;
      const entry = { ledger, row: r };
      const k = `${r.date}|${r.voucherNumber}`;
      const list = expenseByVoucher.get(k) ?? [];
      list.push(entry);
      expenseByVoucher.set(k, list);
      const byDate = expenseByDate.get(r.date) ?? [];
      byDate.push(entry);
      expenseByDate.set(r.date, byDate);
    }
  }
  /** Distinct operator sections among the expense-side debit lines, within the duty ledger's own candidates. */
  const sectionsFrom = (entries: { ledger: string; row: LedgerVoucherRow }[], candidates: string[]): Set<string> => {
    const sections = new Set<string>();
    for (const { ledger, row } of entries) {
      if (!isDebit(row)) continue;
      const res = ctx.resolveSection(ledger);
      if (res.section !== null && candidates.includes(res.section)) sections.add(res.section);
    }
    return sections;
  };
  /**
   * The same party's charge bills (expense-side debits whose ledger resolves
   * to exactly one section), indexed once per counterparty — the universe the
   * nearest-bill fallback (2026-09-26f) searches.
   */
  const billByParty = new Map<string, { ledger: string; row: LedgerVoucherRow }[]>();
  for (const { ledger, rows } of expenseLedgers) {
    for (const r of rows) {
      if (!isDebit(r)) continue;
      const res = ctx.resolveSection(ledger);
      if (res.section === null) continue;
      const k = canonicalKey(r.counterparty);
      if (!k) continue;
      const list = billByParty.get(k) ?? [];
      list.push({ ledger, row: r });
      billByParty.set(k, list);
    }
  }
  /**
   * A duty credit's section when its ledger is ambiguous: the expense debit
   * line of the same voucher (the three-line `Dr Expense / Cr Party (net) /
   * Cr Duty` shape), else the linked same-date bill's expense line (the
   * two-line journal `Dr Party / Cr Duty` whose bill is booked the same day,
   * linked by the party), else — 2026-09-26f, strictly additive — the same
   * party's nearest charge bill within a bounded window (the books post the
   * duty journal days after the charge voucher). Only one distinct section
   * resolves it — never a guess.
   */
  const evidenceSection = (
    row: LedgerVoucherRow,
    candidates: string[],
  ): { section: string | null; source?: string; bill?: string } => {
    let sections = sectionsFrom(expenseByVoucher.get(`${row.date}|${row.voucherNumber}`) ?? [], candidates);
    if (sections.size === 1) return { section: [...sections][0], source: "same-voucher" };
    const sameDay = (expenseByDate.get(row.date) ?? []).filter((e) => e.row.counterparty === row.counterparty);
    sections = sectionsFrom(sameDay, candidates);
    if (sections.size === 1) {
      const section = [...sections][0];
      const linked = sameDay.find((e) => {
        const res = ctx.resolveSection(e.ledger);
        return isDebit(e.row) && res.section === section;
      });
      return { section, source: "same-date bill", bill: linked ? `${linked.row.date}|${linked.row.voucherNumber}` : undefined };
    }
    // Nearest-bill fallback (2026-09-26f): the same party's charge bills whose
    // expense ledger resolves to a candidate section, nearest first — same
    // calendar month preferred, then nearest before the journal, then after —
    // capped at NEAREST_BILL_CAP_DAYS. The journal's OWN voucher is excluded:
    // its expense lines were already weighed by the same-voucher path, and a
    // two-section voucher must stay unresolved (26c never-guess). The nearest
    // bill decides; its section is single by construction. Deterministic
    // ties: earlier date, then voucher number.
    const bills = (billByParty.get(canonicalKey(row.counterparty)) ?? [])
      .filter((e) => !(e.row.date === row.date && e.row.voucherNumber === row.voucherNumber))
      .filter((e) => {
        const res = ctx.resolveSection(e.ledger);
        return res.section !== null && candidates.includes(res.section);
      });
    const dnum = (d: string) => Number(d.slice(0, 4)) * 10000 + Number(d.slice(4, 6)) * 100 + Number(d.slice(6, 8));
    const ranked = bills
      .map((e) => ({ e, diff: Math.abs(dnum(e.row.date) - dnum(row.date)) }))
      .filter(({ diff }) => diff <= NEAREST_BILL_CAP_DAYS)
      .sort((a, b) => {
        const am = a.e.row.date.slice(0, 6) === row.date.slice(0, 6) ? 0 : 1;
        const bm = b.e.row.date.slice(0, 6) === row.date.slice(0, 6) ? 0 : 1;
        return am - bm || a.diff - b.diff || a.e.row.date.localeCompare(b.e.row.date) || a.e.row.voucherNumber.localeCompare(b.e.row.voucherNumber);
      });
    const near = ranked[0];
    if (!near) return { section: null };
    const res = ctx.resolveSection(near.e.ledger);
    return { section: res.section, source: `nearest bill, ${near.diff} day${near.diff === 1 ? "" : "s"}`, bill: `${near.e.row.date}|${near.e.row.voucherNumber}` };
  };

  for (const { ledger, rows } of dutyLedgers) {
    const section = ctx.dutySectionOf(ledger);
    const candidates = ctx.dutyCandidatesOf?.(ledger) ?? [];
    const ambiguous = section === null && candidates.length > 1;
    if (section === null && !ambiguous) continue;
    for (const r of byDate(rows)) {
      const tax = Math.abs(r.amount);
      if (tax < ZERO) continue;
      if (r.amount < 0) {
        const resolved = ambiguous ? evidenceSection(r, candidates) : { section };
        if (resolved.section === null) continue; // the ledger-level TDS-012 diagnostic already covers this
        // A lump duty credit that sums several same-sign debit lines
        // (`Dr A X / Dr B Y / Cr Duty X+Y`) is one deduction per draw, each
        // carrying its own party (2026-09-26o item 038). The `draws` stamp
        // exists only on the day-book path; the live ledger report has no
        // voucher composition and keeps the single-counterparty behaviour.
        const draws = r.draws && r.draws.length >= 2 ? r.draws : null;
        const common = {
          date: r.date,
          voucherNumber: r.voucherNumber,
          section: resolved.section,
          joinedTo: null,
          ...(ambiguous ? { ledger } : {}),
          ...(resolved.source ? { resolvedBy: resolved.source } : {}),
          ...(resolved.bill ? { linkedBill: resolved.bill } : {}),
        };
        if (draws) {
          const total = draws.reduce((sum, d) => sum + Math.abs(d.amount), 0);
          let allocated = 0;
          draws.forEach((d, idx) => {
            const share =
              idx === draws.length - 1 ? round2(tax - allocated) : round2((tax * Math.abs(d.amount)) / total);
            allocated = round2(allocated + share);
            if (share < ZERO) return;
            deductions.push({ ...common, party: d.ledger, tax: share });
          });
        } else {
          deductions.push({ ...common, party: r.counterparty, tax });
        }
      } else {
        deposits.push({
          date: r.date,
          party: r.counterparty,
          tax,
          section: ambiguous ? null : section,
          ...(ambiguous ? { ledger } : {}),
        });
      }
    }
  }
  return { bookings, payments, deductions, deposits, reductions };
}

/**
 * Join the event streams:
 * - a duty credit joins a booking by voucherNumber equality when both
 *   periodic reports name it, else by month + counterparty within 30 days,
 *   nearest date first; a counterparty mismatch never joins;
 * - a credit of another section never claims a booking (2026-09-26c): the
 *   by-voucher phase prefers the voucher's same-party credit whose section
 *   equals the booking's, and the month-window phase accepts only
 *   same-section candidates. A cross-section join silently drops the credit
 *   from the deposit chain (the analysis `find` pins the section) while the
 *   booking still reports TDS-001 — both sides wrong;
 * - a deposit joins a duty credit by date + amount, each side consumed once;
 *   a deposit that carries no section (an ambiguous duty ledger's row) joins
 *   only a credit of the same duty ledger.
 */
function joinEvents(events: TdsEvents, stamped: boolean, ctx: Pick<TdsCtx, "panKeyOf">): void {
  const claimed = new Set<TdsDeduction>();
  const byVoucher = new Map<string, TdsDeduction[]>();
  for (const d of events.deductions) {
    if (!d.voucherNumber) continue;
    const list = byVoucher.get(d.voucherNumber) ?? [];
    list.push(d);
    byVoucher.set(d.voucherNumber, list);
  }
  for (const b of [...events.bookings].sort((a, b) => a.date.localeCompare(b.date))) {
    // Same deductee (2026-09-26o item 2), never the same ledger string: one
    // PAN may own several Tally ledgers, and the duty journal may sit under
    // the head-office ledger while the bill sits under the site ledger.
    const sameDeductee = (d: TdsDeduction): boolean =>
      deducteeKeyOf(ctx, d.party) === deducteeKeyOf(ctx, b.party);
    const byVoucherCands = (byVoucher.get(b.voucherNumber) ?? []).filter(
      (d) => sameDeductee(d) && d.section === b.section && !claimed.has(d) && !d.booking,
    );
    const monthCands = events.deductions
      .filter((d) => sameDeductee(d) && d.section === b.section && !claimed.has(d) && !d.booking)
      .filter((d) => Math.abs(dateDiffDays(d.date, b.date)) <= 30);
    // Amount-tiebreak (2026-09-26g): when several candidates could pair, the
    // one whose TDS amount matches the booking's computed liability wins (the
    // books pair the 19,000 journal with the 9,50,000 bill, not the 3,30,000
    // one). The booking's liability is stamped before the join; a join with
    // the flag off never sees it. Deterministic fallback otherwise: voucher
    // members first, then the existing nearest-date rule.
    const liability = stamped ? round2((b.rateApplied ?? 0) * (b.liable ?? 0)) : 0;
    const matching =
      liability > ZERO
        ? [...monthCands].find((d) => Math.abs(d.tax - liability) <= TDS_TOLERANCE)
        : undefined;
    const pick =
      matching ??
      byVoucherCands.sort(
        (a, b2) => a.date.localeCompare(b2.date) || a.voucherNumber.localeCompare(b2.voucherNumber),
      )[0] ??
      monthCands.sort(
        (a, b2) =>
          Math.abs(dateDiffDays(a.date, b.date)) - Math.abs(dateDiffDays(b2.date, b.date)) ||
          a.date.localeCompare(b2.date) ||
          a.voucherNumber.localeCompare(b2.voucherNumber),
      )[0];
    if (pick) {
      claimed.add(pick);
      pick.joinedTo = b.voucherNumber;
      pick.booking = b;
    }
  }
  const used = new Set<TdsDeposit>();
  for (const d of events.deductions
    .filter((d) => d.booking)
    .sort((a, b) => a.date.localeCompare(b.date))) {
    const dep = events.deposits
      .filter(
        (e) =>
          (e.section === d.section || (e.section === null && e.ledger === d.ledger)) &&
          !used.has(e) &&
          !e.deduction,
      )
      .filter((e) => Math.abs(e.tax - d.tax) <= ZERO && e.date >= d.date)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (dep) {
      used.add(dep);
      dep.deduction = d;
    }
  }
}

/**
 * Net debit notes and other charge reversals against the bookings they
 * cancel (2026-09-26o items 4/5). Netting is LIFO at bill level, per deductee
 * + section: a reduction cancels the most recent still-open booking (never a
 * future one), consuming it fully before an older bill; an
 * unmatched remainder carries forward to the next booking (an advance credit
 * is netted against the charges it precedes). This keeps the section 194Q
 * cumulative crossing honest — the reduction lands in the liable zone, not on
 * a pre-crossing bill — and recomputes every downstream base from the net
 * grosses. A fully netted booking leaves the stream entirely.
 *
 * The grain is deductee + section, not expense ledger: a real note can credit
 * a different material ledger than the bill it cancels (e.g. a cement note
 * against furnace-oil purchases by the same party), and TDS liability is
 * already per deductee + section, so netting matches that grain.
 */
export function netDebitNotes(events: TdsEvents, ctx: Pick<TdsCtx, "panKeyOf">): void {
  const reductions = events.reductions ?? [];
  if (!reductions.length) return;
  const keyOf = (x: { party: string; section: string | null }): string =>
    `${deducteeKeyOf(ctx, x.party)}|${x.section ?? ""}`;
  const groups = new Map<string, { bookings: TdsBooking[]; reductions: TdsReduction[] }>();
  for (const b of events.bookings) {
    if (b.section === null) continue;
    const g = groups.get(keyOf(b)) ?? { bookings: [], reductions: [] };
    g.bookings.push(b);
    groups.set(keyOf(b), g);
  }
  for (const r of reductions) {
    const g = groups.get(keyOf(r));
    if (g) g.reductions.push(r);
  }
  for (const g of groups.values()) {
    if (!g.reductions.length) continue;
    // A booking sorts before a reduction of the same date, so a note can
    // cancel a bill booked the same day. Deterministic otherwise by kind.
    const timeline = [
      ...g.bookings.map((b) => ({ kind: "b" as const, date: b.date, b })),
      ...g.reductions.map((r) => ({ kind: "r" as const, date: r.date, r })),
    ].sort(
      (x, y) =>
        x.date.localeCompare(y.date) ||
        (x.kind === "r" ? 1 : 0) - (y.kind === "r" ? 1 : 0),
    );
    const open: TdsBooking[] = [];
    let carry = 0;
    for (const it of timeline) {
      if (it.kind === "b") {
        if (carry > ZERO) {
          const take = Math.min(carry, it.b.gross);
          it.b.gross = round2(it.b.gross - take);
          carry = round2(carry - take);
        }
        if (it.b.gross > ZERO) open.push(it.b);
      } else {
        let left = it.r.amount;
        while (left > ZERO && open.length) {
          const last = open[open.length - 1];
          const take = Math.min(left, last.gross);
          last.gross = round2(last.gross - take);
          left = round2(left - take);
          if (last.gross <= ZERO) open.pop();
        }
        if (left > ZERO) carry = round2(carry + left);
      }
    }
  }
  events.bookings = events.bookings.filter((b) => b.gross > ZERO);
}

interface Agg {
  party: string;
  section: string;
  bookings: TdsBooking[];
  gross: number;
  crossed: boolean;
  crossDate: string;
  /** Any booking of this aggregate carried a liability above tolerance (item 4). */
  taxDue: boolean;
}

function buildAggs(events: TdsEvents, ctx: TdsCtx & { operator: OperatorFile }): Map<string, Agg> {
  // Aggregate the gross base per deductee key (PAN-else-ledger) per section.
  const aggs = new Map<string, Agg>();
  for (const b of [...events.bookings].sort((a, b) => a.date.localeCompare(b.date))) {
    if (b.section === null) continue; // unknown sections surface as their own finding
    // s.194Q is applicable by default; the operator suppresses it for the
    // whole review when the buyer did not meet the previous-year ₹10 crore
    // turnover condition. A suppressed section produces no aggregation, no
    // findings, no totals — the whole section is out, not one party's.
    if (b.section === "194Q" && ctx.operator?.section194QApplicable === false) continue;
    const key = `${deducteeKeyOf(ctx, b.party)}|${b.section}`;
    const agg = aggs.get(key) ?? {
      party: b.party,
      section: b.section,
      bookings: [],
      gross: 0,
      crossed: false,
      crossDate: "",
      taxDue: false,
    };
    agg.bookings.push(b);
    agg.gross += b.gross;
    aggs.set(key, agg);
  }
  return aggs;
}

/**
 * Pass 1 of the engine (2026-09-26d): every booking receives its liable base
 * and applied rate before any finding is raised, so the party-month coverage
 * rule can compare a month's resolved credits with that month's whole
 * liability, and the join's amount-tiebreak (2026-09-26g) can pair a credit
 * whose tax equals the booking's liability. Threshold/unit math only, no
 * findings — pass 2 in analyzeTds raises those on the stamped bookings.
 */
function stampLiabilities(agg: Agg, ctx: TdsCtx & { operator: OperatorFile }): void {
  const section = agg.section;
  const law = lawOf(section)!;
  const wholeYear = law.wholeYearOnCross;
  const threshold = law.threshold;

  // Aggregation preserves date order (built from a date-sorted walk), but
  // the running cumulative is correctness-critical, so pin it here.
  const bookings = [...agg.bookings].sort((a, b) => a.date.localeCompare(b.date));

  let before = 0;
  for (const b of bookings) {
    const after = before + b.gross;
    if (!agg.crossed && threshold.aggregate !== undefined && after > threshold.aggregate) {
      agg.crossed = true;
      agg.crossDate = b.date;
    }
    before = after;
  }

  let cumulative = 0;
  for (const b of bookings) {
    cumulative += b.gross;
    const singleLiable = threshold.single !== undefined && b.gross > threshold.single;
    let liableBase = 0;
    if (wholeYear) {
      if (agg.crossed || singleLiable) liableBase = b.gross;
    } else if (agg.crossed) {
      // Section 194Q: only the amount beyond the crossing (C8) — measured
      // against the running cumulative through this booking, so bookings
      // before the crossing are never liable (only the excess on the
      // crossing booking, the full gross after).
      liableBase = Math.max(0, Math.min(b.gross, cumulative - (threshold.aggregate ?? 0)));
    }
    const rate = rateFor(ctx, b.party, section, b.date);
    const liability = round2(rate.rate * liableBase);
    b.liable = liableBase;
    b.rateApplied = rate.rate;
    b.viaCertificate = ctx.certificateRateOf(b.party, section, b.date) !== null;
    if (liability > TDS_TOLERANCE) {
      agg.taxDue = true;
      if (!(ctx.transporterDeclared(b.party) && section === "194C")) {
        // A transporter-declared 194C month expects no deduction at all.
        const mk = `${deducteeKeyOf(ctx, b.party)}|${section}|${b.date.slice(0, 6)}`;
        const stamp = agg as Agg & { monthLiability?: Map<string, number> };
        stamp.monthLiability ??= new Map();
        stamp.monthLiability.set(mk, (stamp.monthLiability.get(mk) ?? 0) + liability);
      }
    }
  }
}

/**
 * The whole engine: events, joins, thresholds, rates, checks and schedules.
 * Findings order by the earliest related event, then deductee, then section.
 * Every detail string is built only through `money()` / `displayDate()` —
 * outbound strings pass `scrubDigits`.
 */
export function analyzeTds(
  dutyLedgers: TdsLedgerRows[],
  expenseLedgers: TdsLedgerRows[],
  partyLedgers: TdsLedgerRows[],
  ctx: TdsCtx & { operator: OperatorFile },
): { events: TdsEvents; findings: TdsFinding[]; totals: TdsTotals; liabilities: TdsLiability[] } {
  const events = extractEvents(dutyLedgers, expenseLedgers, partyLedgers, ctx);
  // Debit notes and charge reversals reduce the charge bases before any
  // threshold or liability is measured (2026-09-26o items 4/5).
  netDebitNotes(events, ctx);
  const aggs = buildAggs(events, ctx);
  // 2026-09-26g: stamp every booking's liable base + applied rate BEFORE the
  // join, so the amount-tiebreak inside joinEvents can match a credit to the
  // booking's computed liability (the books pair the 19,000 journal with the
  // 9,50,000 bill). The math reads only gross bases and is ordering-safe.
  for (const agg of aggs.values()) stampLiabilities(agg, ctx);
  joinEvents(events, true, ctx);
  // Return-challan coverage (2026-09-26i, generalised 2026-09-26q): the filed
  // return's challan-to-deductee allocation is deposit evidence alongside the
  // books' deposit debits. A challan covers the book deduction it allocates to
  // — same party, section, deduction month and tax within tolerance — and only
  // then: a deduction the books already deposit (a 1:1 joined deposit) never
  // consumes an allocation, so a challan the books already carry is never
  // double-counted. This runs BEFORE the month pool below, so a challan-covered
  // deduction never consumes pool FIFO — the challan's own deductee allocation
  // wins over the pool, and its own (later) deposit date is what the s.201(1A)
  // (ii) interest is measured from (the return is the filing evidence; the
  // books post many small remittances the pool would silently swallow as
  // "covered"). A challan past the s.139(1) due date covers nothing: the
  // disallowance has already attached, and the deduction stays on the
  // not-deposited path. A book-year challan is no longer excluded (the
  // `depositDate > period.toDate` gate removed): the QB/Q1-Q3 challans land
  // after their Rule 30 due date, and excluding them left the interest payable
  // for those quarters almost nil.
  const joined1to1 = new Set(events.deposits.filter((e) => e.deduction).map((e) => e.deduction!));
  const s139 = s139DueDate("FY 25-26");
  const usableAllocs = (ctx.subsequentDeposits ?? [])
    .filter((a) => a.depositDate <= s139)
    .sort((a, b) => a.dedDate.localeCompare(b.dedDate) || a.tax - b.tax);
  const claimedAlloc = new Set<number>();
  // A timing-only section's credits may be orphaned (2026-09-26o item 038: the
  // partners' remuneration deduction credits the partners' Capital Accounts,
  // not a Winman-named party, so the 1:1 join never fires). They are still
  // deposit-monitored, so a usable allocation for the same section + deduction
  // month + tax covers them even without a party-name match — the return's own
  // section total is the evidence. A non-timing section keeps the strict
  // deductee match.
  // 2026-09-26t (inbox 075, captain): a return challan allocation covers the
  // deduction it allocates to even when the books also carry a 1:1 or month-pool
  // remittance inside the Rule 30 window — the return is the filing evidence and
  // its (later) challan date is the actual deposit date for s.201(1A)(ii). So a
  // 1:1-joined deduction is no longer excluded from challan coverage; it is
  // claimed when an allocation matches (same party/section/month/tax), and the
  // pass-2 deposit check prefers the challan date over the book deposit. The
  // book remittance remains the fallback where no challan covers the deduction.
  const unmatchedDeds = events.deductions
    .filter((d) => !d.subsequentDeposit)
    .sort((a, b) => a.date.localeCompare(b.date) || a.tax - b.tax);
  for (const d of unmatchedDeds) {
    // A timing-only section's allocations are matched by section + month + tax
    // alone (2026-09-26o item 038/039): the duty credit debits the partners'
    // Capital Accounts, which no operator row declares as a Winman deductee,
    // so the return's section-level total is the evidence. Whether the credit
    // also joined a booking is irrelevant to deposit coverage.
    const loose = timingOnlySection(d.section);
    const idx = usableAllocs.findIndex(
      (a, i) =>
        !claimedAlloc.has(i) &&
        (deducteeKeyOf(ctx, a.party) === deducteeKeyOf(ctx, d.party) || loose) &&
        a.section === d.section &&
        a.dedDate.slice(0, 6) === d.date.slice(0, 6) &&
        Math.abs(a.tax - d.tax) <= TDS_TOLERANCE,
    );
    if (idx < 0) continue;
    claimedAlloc.add(idx);
    d.subsequentDeposit = usableAllocs[idx].depositDate;
    d.subsequentInterestPaid = usableAllocs[idx].interestPaid;
    d.subsequentChallanId = usableAllocs[idx].challanId;
  }
  // Month-level deposit coverage (2026-09-26e, evidence §10.5): the books
  // deposit TDS through a duty ledger in lump challan rows whose counterparty
  // is the bank, never the deductee, so coverage is measured ledger-scope.
  // Months in date order per pool (a resolved section, or an ambiguous duty
  // ledger); a month's need is the Σ tax of that pool+month's deductions
  // without a 1:1 joined deposit; the pool is the unconsumed deposit debits
  // dated within [month start, end of next month] (the Rule 30 window); FIFO
  // consumption; the month is covered only when the pool reaches the need,
  // and an uncovered remainder still produces rows.
  // Pool key: a resolved credit from an ambiguous duty ledger carries the
  // ledger stamp, and that ledger's deposit debits are null-section rows —
  // so a stamped credit pools by LEDGER (its deposits can never carry the
  // section), while an unambiguous ledger's credit and its deposits pool by
  // section.
  const poolKeyOf = (d: { section: string | null; ledger?: string }): string =>
    d.section === null || d.ledger !== undefined ? `L:${canonicalKey(d.ledger ?? "")}` : `S:${d.section}`;
  const joined = new Set(events.deposits.filter((e) => e.deduction).map((e) => e.deduction!));
  const monthNeed = new Map<string, Map<string, TdsDeduction[]>>();
  for (const d of events.deductions) {
    // A subsequent-year challan already covers this credit (2026-09-26i) —
    // it never consumes the books' pool.
    if (!d.booking && !timingOnlySection(d.section)) continue;
    if (joined.has(d) || d.subsequentDeposit) continue;
    const pk = poolKeyOf(d);
    const month = d.date.slice(0, 6);
    const byMonth = monthNeed.get(pk) ?? new Map<string, TdsDeduction[]>();
    const list = byMonth.get(month) ?? [];
    list.push(d);
    byMonth.set(month, list);
    monthNeed.set(pk, byMonth);
  }
  const monthPool = new Map<string, { date: string; tax: number; left: number }[]>();
  // A deposit debit already spent on a joined deduction (2026-09-26i: the
  // pool double-spent it — once through the 1:1 join, once here — so a
  // February book deposit silently covered March's need) never enters the
  // pool. Phase-1 and phase-2 joins both stamp e.deduction.
  for (const e of events.deposits.filter((e) => !e.deduction)) {
    const pk = poolKeyOf(e);
    const list = monthPool.get(pk) ?? [];
    list.push({ date: e.date, tax: e.tax, left: e.tax });
    monthPool.set(pk, list);
  }
  for (const [pk, pool] of monthPool) pool.sort((a, b) => a.date.localeCompare(b.date));
  for (const [pk, byMonth] of monthNeed) {
    const pool = monthPool.get(pk) ?? [];
    for (const month of [...byMonth.keys()].sort()) {
      const deds = byMonth.get(month)!;
      const need = deds.reduce((a, d) => a + d.tax, 0);
      if (need <= ZERO) continue;
      // The window runs to the end of the NEXT month (the Rule 30 due date
      // falls next month): month +2 calendar months, capped at December.
      const y = Number(month.slice(0, 4));
      const m = Number(month.slice(4, 6));
      const endMonth = m <= 11 ? `${y}${String(m + 1).padStart(2, "0")}` : `${y + 1}01`;
      let avail = 0;
      for (const p of pool) {
        if (p.left <= ZERO || p.date.slice(0, 6) > endMonth) continue;
        avail += p.left;
      }
      if (avail + ZERO < need) {
        // Uncovered: consume what the window offers anyway (FIFO), leave the
        // month's deductions to fire.
        let left = avail;
        for (const p of pool) {
          if (left <= ZERO) break;
          if (p.left <= ZERO || p.date.slice(0, 6) > endMonth) continue;
          const take = Math.min(p.left, left);
          p.left -= take;
          left -= take;
        }
        continue;
      }
      let left = need;
      for (const p of pool) {
        if (left <= ZERO) break;
        if (p.left <= ZERO || p.date.slice(0, 6) > endMonth) continue;
        const take = Math.min(p.left, left);
        p.left -= take;
        left -= take;
      }
      for (const d of deds) d.depositCovered = true;
    }
  }

  // Aggregate the gross base per deductee key (PAN-else-ledger) per section.
  const findings: TdsFinding[] = [];
  const liabilities: TdsLiability[] = [];
  const ordinals = new Map<TdsCheckId, number>();
  const nextOrd = (check: TdsCheckId): number => {
    const n = (ordinals.get(check) ?? 0) + 1;
    ordinals.set(check, n);
    return n;
  };
  const push = (
    check: TdsCheckId,
    severity: TdsFinding["severity"],
    deductee: string,
    section: string | null,
    amount: number,
    detail: string,
    schedule?: TdsScheduleRow[],
  ): void => {
    findings.push({
      id: tdsFindingId(check, nextOrd(check)),
      check,
      severity,
      deductee,
      group: "Sundry Creditors",
      section,
      amount,
      detail,
      ...(schedule ? { schedule } : {}),
    });
  };

  let notDeducted = 0;
  let shortDeducted = 0;
  let interestI = 0;
  let interestIi = 0;
  let notDepositedTax = 0;
  // Short deductions are staged per deductee key and flushed at the end
  // (2026-09-26o item 3): a party's sub-₹100 FY total is not reported, and
  // the floor is measured across all its short rows before any is emitted.
  const shortStage: { key: string; party: string; section: string; amount: number; detail: string }[] = [];
  const stageShort = (party: string, section: string, amount: number, detail: string): void => {
    shortStage.push({ key: deducteeKeyOf(ctx, party), party, section, amount, detail });
  };
  // s.40(a)(ia) measures 30% of the EXPENDITURE, not of the tax (2026-09-26
  // addendum item 6): the gross of each affected booking is accumulated
  // alongside the tax figures the findings carry.
  let notDeductedBase = 0;
  let notDepositedBase = 0;
  // Master gaps: duty ledgers whose section is not mapped. Review-only,
  // never guessed. The no-PAN gap lives after the aggregation pass — it needs
  // the crossed/tax-due state (2026-09-26 addendum items 4+5) — and the
  // master's deductee-type field is no longer read at all (item 8: the
  // deductee type comes from the PAN's 4th character, never the master).
  for (const duty of dutyLedgers) {
    if (ctx.dutySectionOf(duty.ledger) === null) {
      push(
        "tds_master_gap",
        "review",
        duty.ledger,
        null,
        0,
        `the TDS duty ledger ${duty.ledger}'s nature of payment has no section mapping; its deductions are not analyzed, never guessed.`
      );
    }
  }

  // Deposit-level detail rows (date, deductee, section) for sorting later.

  // Party-month resolved credit totals (2026-09-26d): Σ tax of every
  // RESOLVED duty credit per party|section|month, joined or not. Unresolved
  // (null-section) rows never cover. Journal-level credit patterns — several
  // liability-bearing bookings covered by one combined journal credit — read
  // as covered here even when no single credit joins each booking 1:1.
  const monthCredit = new Map<string, number>();
  for (const d of events.deductions) {
    if (d.section === null) continue;
    const mk = `${deducteeKeyOf(ctx, d.party)}|${d.section}|${d.date.slice(0, 6)}`;
    monthCredit.set(mk, (monthCredit.get(mk) ?? 0) + d.tax);
  }

  for (const agg of aggs.values()) {
    const section = agg.section;
    const law = lawOf(section)!;
    const wholeYear = law.wholeYearOnCross;
    const threshold = law.threshold;

    // Aggregation preserves date order (built from a date-sorted walk), but
    // the running cumulative is correctness-critical, so pin it here.
    const bookings = [...agg.bookings].sort((a, b) => a.date.localeCompare(b.date));

    let before = 0;
    for (const b of bookings) {
      const after = before + b.gross;
      if (!agg.crossed && threshold.aggregate !== undefined && after > threshold.aggregate) {
        agg.crossed = true;
        agg.crossDate = b.date;
      }
      before = after;
    }

    // Pass 1 already ran before the join (2026-09-26g sum); the stamped
    // bookings carry liable/rateApplied, and the agg carries monthLiability.
    const stamped = agg as Agg & { monthLiability?: Map<string, number> };
    const monthLiability = stamped.monthLiability ?? new Map<string, number>();

    // Pass 2 — findings, on the stamped bookings.
    for (const b of bookings) {
      const liability = round2((b.rateApplied ?? 0) * (b.liable ?? 0));
      if (liability <= TDS_TOLERANCE) continue;
      const rate = rateFor(ctx, b.party, section, b.date);

      const panNote = rate.via206AA
        ? " (s.206AA: no PAN on the deductee)"
        : ctx.panDerivedFromGstinOf?.(b.party)
          ? " (PAN derived from GSTIN)"
          : "";
      if (ctx.transporterDeclared(b.party) && section === "194C") {
        // 194C(6): a transporter declaration excludes these payments.
        push(
          "tds_not_deducted",
          "review",
          b.party,
          section,
          0,
          `booking of ${money(b.gross)} on ${displayDate(b.date)}: covered by a section 194C(6) transporter declaration; review the declaration; no deduction expected, no interest.`,
        );
        continue;
      }

      const ded = events.deductions.find(
        (d) =>
          d.booking === b &&
          deducteeKeyOf(ctx, d.party) === deducteeKeyOf(ctx, b.party) &&
          d.section === section,
      );
      // Per-booking liability fact, additive: the exact figures the findings
      // above derive from, captured here so the 194Q running-cumulative and
      // whole-year rules are never re-derived in a second module. `ded` is
      // null for an undeducted booking; no other filtering is applied.
      liabilities.push({ booking: b, section, liableBase: b.liable ?? 0, liability, rate: b.rateApplied ?? rate.rate, deduction: ded ?? null });
      if (!ded) {
        // A timing-only section (194T, 2026-09-26o item 035) never raises a
        // not-deducted finding: its deductee is a partner's Capital Account,
        // its liability is not rate-recomputed, and its duty credits are
        // deposit-monitored section-level below.
        if (timingOnlySection(section)) continue;
        // Party-month coverage (2026-09-26d): when the party's resolved
        // same-section deduction credits for the month already cover that
        // month's whole liability for the section, the month's remaining
        // bookings are covered — no TDS-001. The 1:1 join stays untouched for
        // the deposit and late-deduction chains; unresolved (null-section)
        // rows never cover.
        const mk = `${deducteeKeyOf(ctx, b.party)}|${section}|${b.date.slice(0, 6)}`;
        const monthLiab = monthLiability.get(mk) ?? 0;
        const monthCred = monthCredit.get(mk) ?? 0;
        if (monthLiab > ZERO && monthCred >= monthLiab) continue;
        // 194Q matches at party-month level (2026-09-26k): the month's TDS
        // (usually one month-end journal) is matched against the month's
        // whole liability, so the shortfall is raised once per party-month
        // below, never per purchase voucher.
        if (section === "194Q") continue;
        notDeducted += liability;
        notDeductedBase += b.gross;
        push(
          "tds_not_deducted",
          "critical",
          b.party,
          section,
          liability,
          `booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${panNote}: tax of ${money(liability)} was payable, but no duty credit was found.`,
        );
        continue;
      }
      if (ded.tax < liability - TDS_TOLERANCE && section !== "194Q" && !timingOnlySection(section)) {
        stageShort(
          b.party,
          section,
          round2(liability - ded.tax),
          `duty credit of ${money(ded.tax)} on ${displayDate(ded.date)} is short of the ${money(liability)} payable on the booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${panNote}.`,
        );
      }
      const advance = events.payments
        .filter((p) => p.party === b.party && p.date < b.date && p.date <= ded.date)
        .map((p) => p.date)
        .sort()[0];
      const deductibleDate = advance ?? b.date;
      if (ded.date > deductibleDate && (ctx.lateDeductionInterest ?? true)) {
        const shielded = ctx.deducteeFiledReturn(b.party);
        const months = calendarMonths(deductibleDate, ded.date);
        const interest = shielded ? 0 : interestOn(0.01, months, ded.tax);
        push(
          "tds_late_deducted",
          "warning",
          b.party,
          section,
          ded.tax,
          shielded
            ? `deduction of ${money(ded.tax)} on ${displayDate(ded.date)} is after the ${displayDate(deductibleDate)} deductible date; s.201(1) proviso shields interest (i) (deductee filed a return).`
            : `deduction of ${money(ded.tax)} on ${displayDate(ded.date)} is after the ${displayDate(deductibleDate)} deductible date; s.201(1A) interest (i) of ${money(interest)} for ${months} month(s) at 1%.`,
          shielded ? undefined : [{ kind: "i", amount: interest, from: deductibleDate, to: ded.date, basis: `1% of ${months} month(s)` }],
        );
        interestI += interest;
        ded.interestI = interest;
      }
      // Deposit checks: the joined deposit was matched in joinEvents.
      const dep = events.deposits.find((e) => e.deduction === ded);
      // 2026-09-26t (inbox 075, captain): where a Winman return challan covers
      // the deduction, its date is the deposit date for lateness — overriding an
      // in-window book remittance (1:1 or month-pool). The book remittance date
      // applies only where no challan covers the deduction.
      if (dep && ded.subsequentDeposit && ded.date <= ctx.asOnDate) {
        const due = depositDue(ded.date);
        if (ded.subsequentDeposit > due) {
          const months = calendarMonths(ded.date, ded.subsequentDeposit);
          const ii = interestOn(0.015, months, ded.tax);
          push(
            "tds_late_deposit",
            "warning",
            b.party,
            section,
            ded.tax,
            `deposit on ${displayDate(ded.subsequentDeposit)} after the Rule 30 due date of ${displayDate(due)} — per the return's challan; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%.`,
            [{ kind: "ii", amount: ii, from: ded.date, to: ded.subsequentDeposit, basis: `1.5% of ${months} month(s)` }],
          );
          interestIi += ii;
          ded.interestII = ii;
        }
      } else if (dep) {
        const due = depositDue(ded.date);
        if (dep.date > due) {
          const months = calendarMonths(ded.date, dep.date);
          const ii = interestOn(0.015, months, ded.tax);
          push(
            "tds_late_deposit",
            "warning",
            b.party,
            section,
            ded.tax,
            `deposit on ${displayDate(dep.date)} after the Rule 30 due date of ${displayDate(due)}; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%.`,
            [{ kind: "ii", amount: ii, from: ded.date, to: dep.date, basis: `1.5% of ${months} month(s)` }],
          );
          interestIi += ii;
          ded.interestII = ii;
        }
        // A book-vs-file deposit difference is its own finding.
        const month = `${ded.date.slice(0, 4)}-${ded.date.slice(4, 6)}`;
        const challan = (ctx.operator?.challans ?? []).find((c) => c.section === section && c.forMonth === month);
        if (challan && challan.depositDate.slice(0, 6) !== dep.date.slice(0, 6)) {
          push(
            "tds_deposit_mismatch",
            "review",
            b.party,
            section,
            ded.tax,
            `book deposit on ${displayDate(dep.date)} disagrees with the operator challan for section ${section}, month ${month}.`,
          );
        }
      } else if (ded.subsequentDeposit && ded.date <= ctx.asOnDate) {
        // Deposited in the subsequent year (2026-09-26i): deposited, but
        // after the FY end — lateness interest (ii) still runs to the
        // challan date, while the s.40(a)(ia) base is untouched (the engine
        // only stamps allocations on or before the s.139(1) due date).
        const due = depositDue(ded.date);
        if (ded.subsequentDeposit > due) {
          const months = calendarMonths(ded.date, ded.subsequentDeposit);
          const ii = interestOn(0.015, months, ded.tax);
          push(
            "tds_late_deposit",
            "warning",
            b.party,
            section,
            ded.tax,
            `deposit on ${displayDate(ded.subsequentDeposit)} after the Rule 30 due date of ${displayDate(due)} — per the return's challan; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%.`,
            [{ kind: "ii", amount: ii, from: ded.date, to: ded.subsequentDeposit, basis: `1.5% of ${months} month(s)` }],
          );
          interestIi += ii;
          ded.interestII = ii;
        }
      } else if (ded.date <= ctx.asOnDate && !ded.depositCovered) {
        notDepositedTax += ded.tax;
        // s.40(a)(ia) base is proportional to the tax NOT deposited (2026-09-26o
        // item 041): when a deduction carries only part of the booking's tax
        // (a split 194T draw), only that share of the expenditure disallows.
        // A timing-only section is handled once at section level below (its
        // joined and orphan credits must not be double-counted).
        if (!timingOnlySection(section)) {
          notDepositedBase += liability > ZERO ? round2(b.gross * (ded.tax / liability)) : b.gross;
        }
        push(
          "tds_not_deposited",
          "critical",
          b.party,
          section,
          ded.tax,
          `duty credit of ${money(ded.tax)} on ${displayDate(ded.date)} has no deposit debit by ${displayDate(ctx.asOnDate)} (the Rule 30 due date falls next month).`,
        );
      }
    }

    // 194Q party-month matching (2026-09-26k): the month's resolved duty
    // credits are matched against the month's whole liability — one finding
    // per short party-month instead of one per purchase voucher. Zero
    // credits for the month stay tds_not_deducted; partial credits become
    // tds_short_deducted for the shortfall. The ₹50 lakh annual threshold
    // and the C8 excess-only base are unchanged (stamped above); other
    // sections keep the per-booking matching.
    if (section === "194Q") {
      const monthGross = new Map<string, { party: string; gross: number; date: string }>();
      for (const b of bookings) {
        if ((b.liable ?? 0) <= 0) continue;
        const mk = `${deducteeKeyOf(ctx, b.party)}|${section}|${b.date.slice(0, 6)}`;
        if (!monthLiability.has(mk)) continue;
        const cur = monthGross.get(mk) ?? { party: b.party, gross: 0, date: b.date };
        cur.gross += b.gross;
        monthGross.set(mk, cur);
      }
      for (const [mk, m] of monthGross) {
        const liab = round2(monthLiability.get(mk) ?? 0);
        if (liab <= TDS_TOLERANCE) continue;
        const cred = monthCredit.get(mk) ?? 0;
        if (cred >= liab - TDS_TOLERANCE) continue;
        const label = displayDate(`${mk.slice(-6)}01`).slice(3);
        const r0 = rateFor(ctx, m.party, section, m.date);
        const panNote = r0.via206AA
          ? " (s.206AA: no PAN on the deductee)"
          : ctx.panDerivedFromGstinOf?.(m.party)
            ? " (PAN derived from GSTIN)"
            : "";
        if (cred <= TDS_TOLERANCE) {
          notDeducted += liab;
          notDeductedBase += m.gross;
          push(
            "tds_not_deducted",
            "critical",
            m.party,
            section,
            liab,
            `purchases of ${money(m.gross)} for ${label} under section ${section}${panNote}: tax of ${money(liab)} was payable, but no duty credit was found for the month.`,
          );
        } else {
          stageShort(
            m.party,
            section,
            round2(liab - cred),
            `duty credits of ${money(cred)} for ${label} fall short of the ${money(liab)} payable on purchases of ${money(m.gross)} under section ${section}${panNote}.`,
          );
        }
      }
    }

    if (agg.crossed && !timingOnlySection(section)) {
      const rate = rateFor(ctx, agg.party, section, agg.crossDate || agg.bookings[0].date).rate;
      push(
        "tds_threshold_crossed",
        "review",
        agg.party,
        section,
        round2(rate * agg.gross),
        `aggregate of ${money(agg.gross)} crossed the threshold in ${displayDate(agg.crossDate)}: ${wholeYear ? "the whole year's amounts are liable;" : "only the amount beyond the crossing is liable (section 194Q);"}`,
      );
    }
  }

  // Timing-only sections (194T, 2026-09-26o item 035): every duty credit is
  // deposit/interest-monitored at section level, whether or not it joined a
  // booking (a partner's Capital Account is not a declared deductee, so the
  // 1:1 join usually cannot fire). A credit the month pool covers is silent;
  // an uncovered credit past its Rule 30 due point raises tds_not_deposited.
  // The s.40(a)(ia) base is proportional to the tax actually NOT deposited
  // (2026-09-26o item 041): section gross × (undeposited tax / the section's
  // total tax), so a challan that did cover its share removes that share of
  // the base. It is computed once per section over BOTH joined and orphan
  // uncovered credits (a joined one already raised its own finding above).
  const timingSectionGross = new Map<string, number>();
  for (const b of events.bookings) {
    if (!timingOnlySection(b.section)) continue;
    const s = b.section as string;
    timingSectionGross.set(s, round2((timingSectionGross.get(s) ?? 0) + b.gross));
  }
  const timingSectionTax = new Map<string, number>();
  for (const d of events.deductions) {
    if (!timingOnlySection(d.section)) continue;
    const s = d.section as string;
    timingSectionTax.set(s, round2((timingSectionTax.get(s) ?? 0) + d.tax));
  }
  // A timing-only credit covered by a subsequent-year challan (2026-09-26p):
  // the deposit lands after the FY end, so its s.201(1A)(ii) interest runs
  // from the deduction date to the deposit date at 1.5% per month or part
  // month. The per-booking pass cannot reach an orphan credit (duty credit
  // against Capital Accounts, no booking), so the interest is stamped here
  // and reported once. The challan's own Interest column carries what was
  // actually paid.
  for (const d of events.deductions) {
    if (!timingOnlySection(d.section)) continue;
    if (d.subsequentDeposit === undefined) continue;
    if (d.date > ctx.asOnDate) continue;
    if (d.booking) continue; // a booked credit's lateness is raised by the per-booking pass
    const section = d.section as string;
    const due = depositDue(d.date);
    if (d.subsequentDeposit <= due) continue;
    const months = calendarMonths(d.date, d.subsequentDeposit);
    const ii = interestOn(0.015, months, d.tax);
    if (ii <= 0) continue;
    push(
      "tds_late_deposit",
      "warning",
      d.party,
      section,
      d.tax,
      `deposit on ${displayDate(d.subsequentDeposit)} after the Rule 30 due date of ${displayDate(due)} — per the return's challan; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%${d.subsequentInterestPaid && d.subsequentInterestPaid > 0 ? ` (interest paid ${money(d.subsequentInterestPaid)})` : ""}.`,
      [{ kind: "ii", amount: ii, from: d.date, to: d.subsequentDeposit, basis: `1.5% of ${months} month(s)` }],
    );
    interestIi += ii;
    d.interestII = ii;
  }
  const timingUndepositedTax = new Map<string, number>();
  for (const d of events.deductions) {
    if (!timingOnlySection(d.section)) continue;
    if (d.date > ctx.asOnDate) continue;
    const section = d.section as string;
    if (d.depositCovered || d.subsequentDeposit) continue;
    timingUndepositedTax.set(section, round2((timingUndepositedTax.get(section) ?? 0) + d.tax));
    if (d.booking) continue; // its finding was raised by the per-booking pass
    notDepositedTax += d.tax;
    push(
      "tds_not_deposited",
      "critical",
      d.party,
      section,
      d.tax,
      `duty credit of ${money(d.tax)} on ${displayDate(d.date)} has no deposit debit by ${displayDate(ctx.asOnDate)} (the Rule 30 due date falls next month).`,
    );
  }
  for (const [section, undep] of timingUndepositedTax) {
    const gross = timingSectionGross.get(section) ?? 0;
    const totalTax = timingSectionTax.get(section) ?? 0;
    notDepositedBase += totalTax > ZERO ? round2(gross * (undep / totalTax)) : gross;
  }

  // Flush the staged short deductions (2026-09-26o item 3): a deductee's
  // whole-FY short total (across sections) below ₹100 is not reported; only
  // the parties that reach the floor emit their per-row findings and feed the
  // totals and the s.271C exposure.
  const shortTotalByDeductee = new Map<string, number>();
  for (const s of shortStage) {
    shortTotalByDeductee.set(s.key, round2((shortTotalByDeductee.get(s.key) ?? 0) + s.amount));
  }
  for (const s of shortStage) {
    if ((shortTotalByDeductee.get(s.key) ?? 0) < SHORT_DEDUCTION_MIN) continue;
    shortDeducted += s.amount;
    push("tds_short_deducted", "critical", s.party, s.section, s.amount, s.detail);
  }

  // No-PAN master gaps (2026-09-26 addendum items 4+5): one finding per
  // party+section carrying that section's own gross, and only where TDS was
  // actually due — the threshold was crossed (single-bill or aggregate, both
  // visible in the agg pass) or tax was deducted. Below-threshold parties
  // are not compliance gaps; the s.206AA rate is what the engine assumed.
  const noPanDue = new Map<string, { party: string; section: string; gross: number }>();
  for (const agg of aggs.values()) {
    if (ctx.panKeyOf(agg.party)) continue;
    if (timingOnlySection(agg.section)) continue; // 194T is never a PAN gap (2026-09-26o item 035)
    const taxed =
      agg.crossed ||
      agg.taxDue ||
      events.deductions.some((d) => d.booking?.party === agg.party && d.booking.section === agg.section);
    if (!taxed) continue;
    const key = `${agg.party}|${agg.section}`;
    const e = noPanDue.get(key) ?? { party: agg.party, section: agg.section, gross: 0 };
    e.gross += agg.gross;
    noPanDue.set(key, e);
  }
  for (const e of [...noPanDue.values()].sort(
    (a, b) => a.party.localeCompare(b.party) || a.section.localeCompare(b.section),
  )) {
    push(
      "tds_master_gap",
      "review",
      e.party,
      e.section,
      e.gross,
      `no PAN recorded for the deductee (${money(e.gross)} gross under section ${e.section} this period): aggregation runs per ledger and the s.206AA rate is assumed.`,
    );
  }

  // Unmapped sections: review-only, no interest, never guessed. Two cases,
  // at most two findings: an expense ledger with no mapping at all, and one
  // mapped to more than one section (whose candidates are law enums — safe to
  // print — and are named so the fix is actionable: split the ledger).
  const unknownBookings = events.bookings.filter((b) => b.section === null && b.candidates.length === 0);
  if (unknownBookings.length) {
    const gross = unknownBookings.reduce((a, b) => a + b.gross, 0);
    push(
      "tds_section_unknown",
      "review",
      unknownBookings[0].party,
      null,
      gross,
      `${unknownBookings.length} booking(s) totalling ${money(gross)} are on expense ledgers with no section in the operator file; applicability is never guessed.`,
    );
  }
  const ambiguousBookings = events.bookings.filter((b) => b.section === null && b.candidates.length > 0);
  if (ambiguousBookings.length) {
    const gross = ambiguousBookings.reduce((a, b) => a + b.gross, 0);
    const candidates = uniqueList(ambiguousBookings.flatMap((b) => b.candidates));
    push(
      "tds_section_unknown",
      "review",
      ambiguousBookings[0].party,
      null,
      gross,
      `${ambiguousBookings.length} booking(s) totalling ${money(gross)} are on expense ledgers mapped to more than one section (${candidates.join(", ")}); the section cannot be decided from the booking, so no tax is computed. Split the ledger per section, or remove the extra mapping.`,
    );
  }

  // Statement checks (Rule 31A): a quarter with deductions or a statement row.
  const quarterTax = new Map<string, number>();
  for (const d of events.deductions) {
    const q = quarterOfDate(d.date);
    quarterTax.set(q, (quarterTax.get(q) ?? 0) + d.tax);
  }
  for (const q of ["Q1", "Q2", "Q3", "Q4"] as const) {
    const due = statementDue(q, "FY 25-26");
    if (due > ctx.asOnDate) continue;
    const rows = (ctx.operator?.statements ?? []).filter((s) => s.quarter === q);
    const tax = quarterTax.get(q) ?? 0;
      const latest = rows.length ? rows.map((r) => r.filedDate).sort()[rows.length - 1] : "";
    if (latest === "" && tax <= TDS_TOLERANCE) continue;
    if (!latest) {
      const days = Math.max(0, dateDiffDays(ctx.asOnDate, due));
      const fee = tax <= ZERO ? 0 : Math.min(lateFeePerDay(tax) * days, tax);
      push(
        "tds_statement_missing",
        "warning",
        `statement ${q}`,
        null,
        fee,
        `the quarter had duty deductions of ${money(tax)}, but no statement row; s.234E fee of ${money(fee)} for ${days} day(s) capped at the quarter's TDS.`,
        fee > 0 ? [{ kind: "fee", amount: fee, from: due, to: ctx.asOnDate, basis: `200/day for ${days} day(s), capped at ${money(tax)}` }] : undefined,
      );
      continue;
    }
    const extra = latest > due;
    if (extra) {
      const days = Math.max(0, dateDiffDays(latest, due));
      const fee = tax <= ZERO ? 0 : Math.min(lateFeePerDay(tax) * days, tax);
      const oneMonth = Math.abs(dateDiffDays(latest, due)) <= 31;
      push(
        "tds_statement_late",
        "warning",
        `statement ${q}`,
        null,
        fee,
        `statement filed on ${displayDate(latest)} after the Rule 31A due date of ${displayDate(due)}; s.234E fee of ${money(fee)};${oneMonth ? " s.271H is not levied where tax, interest and fee are paid and the statement was filed within a month;" : " s.271H penalty (10000 to 100000) may apply."}`,
        fee > 0 ? [{ kind: "fee", amount: fee, from: due, to: latest, basis: `200/day for ${days} day(s), capped at ${money(tax)}` }] : undefined,
      );
    }
  }
  // Exposures: 30% disallowance and the s.271C penalty, review-only, never
  // payables. The fleet-wide figures name no deductee (2026-09-26 addendum
  // item 2: the first party was a mislabel) — the deductee stays blank.
  // s.40(a)(ia) is 30% of the expenditure itself (item 6), and s.271C covers
  // failure to deduct whole OR PART, so the short-deduction shortfall is
  // included in its base — and a shortfall alone (every deduction taken but
  // some short) is still an exposure on its own.
  if (notDeducted > ZERO) {
    push(
      "tds_exposure_40a_ia",
      "review",
      "",
      null,
      round2(notDeductedBase * 0.3),
      `s.40(a)(ia) exposure: 30% disallowance of the expenditure of ${money(round2(notDeductedBase))} where TDS was not deducted; an exposure, never a payable.`,
    );
  }
  if (notDeducted + shortDeducted > ZERO) {
    push(
      "tds_exposure_271c",
      "review",
      "",
      null,
      round2(notDeducted + shortDeducted),
      `s.271C exposure: a penalty equal to the tax not deducted or short deducted, ${money(round2(notDeducted + shortDeducted))}, relieved by s.273B; an exposure, never a payable.`,
    );
  }
  if (notDepositedTax > ZERO) {
    push(
      "tds_exposure_40a_ia",
      "review",
      "",
      null,
      round2(notDepositedBase * 0.3),
      `s.40(a)(ia) exposure: 30% disallowance of the expenditure of ${money(round2(notDepositedBase))} whose tax was deducted but not deposited by the s.139(1) due date; an exposure, never a payable.`,
    );
  }

  const bySection = new Map<string, TdsSectionTotals>();
  for (const agg of aggs.values()) {
    bySection.set(agg.section, { section: agg.section, gross: agg.gross, tax: round2(rateFor(ctx, agg.party, agg.section, agg.bookings[0]?.date ?? ctx.period.fromDate).rate * agg.gross) });
  }

  return {
    events,
    findings,
    liabilities,
    totals: {
      bySection: [...bySection.values()],
      notDeducted: round2(notDeducted),
      shortDeducted: round2(shortDeducted),
      interestI: round2(interestI),
      interestIi: round2(interestIi),
    },
  };
}

/** FY 25-26 quarters by month number: Apr-Jun Q1 ... Jan-Mar Q4. */
export function quarterOfDate(date: string): "Q1" | "Q2" | "Q3" | "Q4" {
  const m = Number(date.slice(4, 6));
  if (m >= 4 && m <= 6) return "Q1";
  if (m >= 7 && m <= 9) return "Q2";
  if (m >= 10) return "Q3";
  return "Q4";
}

