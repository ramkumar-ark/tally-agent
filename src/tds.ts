import type { LedgerVoucherRow } from "./downstream.js";
import { money, count, displayDate, displayMonth } from "./format.js";
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
  /**
   * The tax this booking is charged on its OWN account: `rate x liable` less
   * what the earlier bookings of the same deductee + section + year already
   * carried (captain 2026-09-30, `chargedSoFar` in the analysis walk, inbox
   * 016). Only a cumulative-limit CROSSING booking differs from
   * `rate x liable`, and it is the figure a duty credit settles, so the amount
   * tiebreak must match against it — a credit booked on the crossing bill's
   * own date was computed by the operator from the same netting.
   */
  chargeNet?: number;
}

export interface TdsPayment {
  date: string;
  voucherNumber: string;
  party: string;
  amount: number;
}

/**
 * One booking's share of a split duty credit (2026-09-29): the credit's tax
 * is the exact sum of the shares' computed liabilities, so the credit covers
 * every booking of the share list. A share is a per-booking VIEW — the credit
 * itself keeps its own tax, its deposit chain, its return-challan evidence and
 * its place in the month pool, and a share never enters any of those streams
 * (a return carries one allocation for the journal, not one per bill).
 */
export interface TdsShare {
  booking: TdsBooking;
  /** This booking's own computed liability — the share of the credit's tax. */
  tax: number;
  /** Stamps: the s.201(1A) interest components raised for THIS share only. */
  interestI?: number;
  interestII?: number;
}

/**
 * One duty credit that covers SEVERAL bookings, as the review reports it
 * (2026-09-29). Such a credit raises no finding of its own — that is the point
 * of the report: it is how a reader sees that a booking counted as deducted
 * because of a shared journal, not because nothing happened.
 */
export interface TdsConsolidation {
  party: string;
  section: string;
  /** "month": every covered booking falls in the credit's own calendar month. "window": the bounded 30-day split. */
  scope: "month" | "window";
  /** YYYYMMDD of the shared duty credit. */
  creditDate: string;
  creditVoucherNumber: string;
  /** The credit's own tax — the sum of the covered bookings' liabilities. */
  tax: number;
  bookings: { date: string; voucherNumber: string; tax: number }[];
}

/**
 * A same-month consolidation the partial search could not settle (2026-09-29):
 * the month holds more unpaired bookings than `CONSOLIDATION_MAX_CANDIDATES`,
 * and neither the whole-month sum nor any searched subset equalled the credit's
 * tax. The review states the bound in plain words rather than staying silent.
 */
export interface TdsConsolidationSkip {
  party: string;
  section: string;
  /** YYYYMMDD of the credit whose allocation could not be settled. */
  creditDate: string;
  tax: number;
  /** YYYYMM — the credit's own calendar month. */
  month: string;
  /** How many unpaired same-month bookings the month holds. */
  unpairedBookings: number;
  /** How many of them the partial subset search actually looked at. */
  searchedBookings: number;
}

export interface TdsDeduction {
  date: string;
  voucherNumber: string;
  party: string;
  tax: number;
  section: string;
  joinedTo: string | null;
  booking?: TdsBooking;
  /**
   * Split allocation (2026-09-29): the bookings this ONE credit covers, when
   * its tax is the exact sum of their liabilities. `booking` is then the first
   * share (the credit's marker that it is claimed, exactly as a 1:1 join
   * marks it), and the findings pass reads the share list in preference to the
   * 1:1 field. Empty/absent on every ordinary credit.
   */
  shares?: TdsShare[];
  /**
   * Set when this ONE credit covers more than one booking (2026-09-29):
   * "month" for a same-calendar-month consolidation (the ordinary shape — one
   * journal pays a month of bills) and "window" for the bounded cross-month
   * split. The review lists every such credit under `consolidations`, so a
   * reader can see why a booking counts as deducted even though it raised no
   * finding of its own.
   */
  consolidated?: "month" | "window";
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
  /**
   * The s.201(1A)(i) interest this credit earns by settling bills that were
   * already due when it was booked (the backward pool, 2026-09-30) — 1% from
   * each settled bill's own deductible date to this credit's date. It rides
   * here, not on `interestI`, because a backward settlement is not one of this
   * credit's own deductions and the 3CD interest sheets have no other way to
   * see it (a bill the return never deducted has no allocation of its own).
   * Additive: one credit can settle several bills, and for 194Q both the
   * month pass and the per-booking walk may settle the same credit.
   * `tds3cd` adds it, gated by the operator's `lateDeductionInterest` exactly
   * like every other late-deduction interest.
   */
  backInterestI?: number;
  /**
   * The draw's expense share (2026-09-26o item 038/039): a lump duty credit
   * split across same-sign debits (per partner) carries each draw's own debit
   * amount, so the clause 21(b) not-deposited rows can name the partner's
   * expenditure share, not just the tax share. Only the per-draw split sets
   * it; the single-counterparty path leaves it unset (the joined booking's
   * gross supplies the base instead).
   */
  drawGross?: number;
}

/**
 * One clause 21(b) book row, collected by the engine at exactly the raise
 * points where the review's own `tds_not_deducted` / `tds_short_deducted` /
 * `tds_not_deposited` findings fire (2026-09-26 005: the sheets must reconcile
 * to the review, never to a second scan). `reason` names which finding kind
 * produced the row.
 */
export interface Clause21bBookRow {
  party: string;
  /** YYYYMMDD; a 194Q party-month row uses the month's first day. */
  date: string;
  voucherNumber: string;
  /**
   * The expense the 21(b) sheet reports for this row. For a not-deposited row
   * it is the payment base; for a not_deducted or short_deducted row it is the
   * UNDEDUCTED portion of the expense — the liable tax / the applicable rate
   * (captain, 2026-09-26), so a 194Q party-month row carries the taxable part
   * beyond the ₹50 lakh crossing, never the whole month's purchases.
   */
  gross: number;
  tdsDone: number;
  tdsDeposited: number;
  depositDate: string | null;
  section: string;
  reason: "not_deducted" | "short_deducted" | "not_deposited";
  /** The figure the producing finding carried (template/review prose only). */
  liability: number;
  /**
   * The id of the review finding that produced this row (`TDS-<nnn>-<n>`),
   * captured at the same raise point (2026-09-26 007: the sheets declare a
   * one-to-one mapping to the review). A 194Q party-month or timing-only
   * section row carries the single finding raised for it.
   */
  findingId: string;
  /**
   * The date the duty credit was booked, where the raise site had the joined
   * credit in scope (2026-10-01: the s.201(1A) payable statement). Additive
   * and optional — it adds a fact for a downstream projector and changes no
   * computation, finding, total or 21(b) sheet value. Absent on an undeducted
   * row (no credit exists) and on a 194Q party-month short row (a month of
   * credits has no single date, so it is left null rather than invented).
   */
  deductionDate?: string | null;
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
            deductions.push({ ...common, party: d.ledger, tax: share, drawGross: round2(d.amount) });
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
 * How many bookings ONE duty credit may cover, and how many candidate
 * bookings a credit may be matched against (2026-09-29). The subset search is
 * `Σ C(12, 2..4)` combinations per credit — bounded by construction, so a
 * large party with hundreds of bills cannot blow the cost up. A journal that
 * pays a quarter's bills at once is still a journal that pays a few bills.
 */
const SPLIT_MAX_BOOKINGS = 4;
const SPLIT_MAX_CANDIDATES = 12;
/** The date window a credit may cover bookings in — the 1:1 join's own rule. */
const SPLIT_WINDOW_DAYS = 30;

/**
 * The same-month consolidation search (2026-09-29, captain). A month-end TDS
 * journal is routinely booked against EVERY expense entry of one deductee and
 * section in that month — normal bookkeeping, not a compliance gap, and the
 * 1:1 model could only hand it to one bill, stranding the rest. The whole set
 * of the month's unpaired bookings is therefore tried FIRST and UNBOUNDED
 * (that set is the common shape, and it is one sum, not a search): N bookings
 * clear one credit for any N. Only a PARTIAL month — a journal that pays some
 * of the month's bills — falls to the subset search, and that search looks at
 * at most this many of the month's unpaired bookings. A larger month still
 * gets the whole-month check; only the partial search is capped, and every cap
 * hit is reported as a finding rather than left silent.
 */
const CONSOLIDATION_MAX_CANDIDATES = 12;

/**
 * Consolidated allocation (2026-09-29): one TDS journal commonly pays TDS on
 * several bills of the same party in the same month. Under a strict 1:1 join
 * the credit can attach to only one of them, so the other bill reports
 * "no duty credit was found" and the pairing cascades: each stranded booking
 * takes the NEXT bill's credit by nearest date until the party's credits run
 * out (measured on a real FY: 9 findings, 95% of the not-deducted total, for
 * deductions that were fully present in the books).
 *
 * A credit is therefore allocated to two or more bookings of the same
 * deductee and section whose computed liabilities sum to its tax within
 * `TDS_TOLERANCE`, in two scopes, tried in this order:
 * 1. "month" — every booking falls in the credit's OWN calendar month, the
 *    case the captain named. The month's whole unpaired set is tried first
 *    (unbounded, one sum, so any N of them clear one credit); a partial month
 *    falls to a subset search bounded by `CONSOLIDATION_MAX_CANDIDATES`.
 * 2. "window" — the original 30-day, `SPLIT_MAX_BOOKINGS` split, unchanged,
 *    which is what still handles a credit that pays bills of a different month.
 * Selection is deterministic: the fewest bookings, then the tightest date span
 * around the credit, then the earliest booking. An exact 1:1 pairing always
 * wins, so the ordinary case is untouched.
 *
 * Returns the bookings a shared credit settled, the shared credits themselves
 * (the review lists them — a booking covered by a shared journal raises no
 * finding, so this is where a reviewer sees why it counts as deducted), and
 * the same-month attempts the partial search could not settle. The credit keeps
 * its own tax and its own place in the deposit/challan streams (see `TdsShare`).
 */
function allocateSplitCredits(
  events: TdsEvents,
  ctx: Pick<TdsCtx, "panKeyOf">,
): { covered: Set<TdsBooking>; consolidations: TdsConsolidation[]; skipped: TdsConsolidationSkip[] } {
  const covered = new Set<TdsBooking>();
  const consolidations: TdsConsolidation[] = [];
  const skipped: TdsConsolidationSkip[] = [];
  if (events.bookings.length === 0 || events.deductions.length === 0) {
    return { covered, consolidations, skipped };
  }
  const candsByKey = new Map<string, { booking: TdsBooking; liability: number }[]>();
  for (const b of events.bookings) {
    if (b.section === null) continue;
    const liability = round2((b.rateApplied ?? 0) * (b.liable ?? 0));
    if (liability <= ZERO) continue;
    const key = `${deducteeKeyOf(ctx, b.party)}|${b.section}`;
    const list = candsByKey.get(key) ?? [];
    list.push({ booking: b, liability });
    candsByKey.set(key, list);
  }
  for (const list of candsByKey.values()) {
    list.sort(
      (a, b) =>
        a.booking.date.localeCompare(b.booking.date) ||
        a.booking.voucherNumber.localeCompare(b.booking.voucherNumber),
    );
  }
  for (const d of [...events.deductions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.voucherNumber.localeCompare(b.voucherNumber),
  )) {
    if (d.booking !== undefined) continue;
    const open = (candsByKey.get(`${deducteeKeyOf(ctx, d.party)}|${d.section}`) ?? []).filter(
      (c) => !covered.has(c.booking),
    );
    const cands = open
      .filter((c) => Math.abs(dateDiffDays(d.date, c.booking.date)) <= SPLIT_WINDOW_DAYS)
      .sort(
        (a, b) =>
          Math.abs(dateDiffDays(a.booking.date, d.date)) -
            Math.abs(dateDiffDays(b.booking.date, d.date)) ||
          a.booking.date.localeCompare(b.booking.date) ||
          a.booking.voucherNumber.localeCompare(b.booking.voucherNumber),
      )
      .slice(0, SPLIT_MAX_CANDIDATES);
    // The credit's own calendar month, whole and uncut — the captain's case.
    const monthCands = open.filter((c) => c.booking.date.slice(0, 6) === d.date.slice(0, 6));
    if (cands.length < 2 && monthCands.length < 2) continue;
    // An exact one-to-one pairing is the ordinary case and always wins, in
    // either scope (the same month included, beyond the window candidate cap).
    if (
      [...cands, ...monthCands].some((c) => Math.abs(c.liability - d.tax) <= TDS_TOLERANCE)
    ) {
      continue;
    }
    let subset: { booking: TdsBooking; liability: number }[] | null = null;
    let scope: "month" | "window" = "window";
    if (monthCands.length >= 2) {
      // (1) the whole month, unbounded: one sum over every unpaired booking
      // of the month. This is what clears N > 4 bookings with one credit.
      const wholeMonth = round2(monthCands.reduce((sum, c) => sum + c.liability, 0));
      if (Math.abs(wholeMonth - d.tax) <= TDS_TOLERANCE) {
        subset = monthCands;
      } else {
        // (2) a partial month, bounded. A cap hit is recorded, never silent.
        const capped = monthCands.slice(0, CONSOLIDATION_MAX_CANDIDATES);
        subset = bestSubset(d, capped, capped.length);
        if (!subset && monthCands.length > capped.length) {
          skipped.push({
            party: d.party,
            section: d.section,
            creditDate: d.date,
            tax: d.tax,
            month: d.date.slice(0, 6),
            unpairedBookings: monthCands.length,
            searchedBookings: capped.length,
          });
        }
      }
      if (subset) scope = "month";
    }
    if (!subset) {
      if (cands.length < 2) continue;
      subset = bestSubset(d, cands, SPLIT_MAX_BOOKINGS);
      if (!subset) continue;
      scope = "window";
    }
    // Date order for the share list (the candidate list is nearest-credit
    // first, which is a search order, not a report order), so the credit's
    // `booking` marker is its earliest covered bill.
    subset.sort(
      (a, b) =>
        a.booking.date.localeCompare(b.booking.date) ||
        a.booking.voucherNumber.localeCompare(b.booking.voucherNumber),
    );
    d.shares = subset.map((c) => ({ booking: c.booking, tax: c.liability }));
    d.consolidated = scope;
    // `booking` stays the credit's "claimed" marker (the 1:1 field the
    // candidate filters and the deposit phase read); the findings pass takes
    // the share list in preference, so the first share's own figures are
    // never read off the whole credit.
    d.booking = subset[0].booking;
    d.joinedTo = subset[0].booking.voucherNumber;
    for (const s of d.shares) covered.add(s.booking);
    consolidations.push({
      party: d.party,
      section: d.section,
      scope,
      creditDate: d.date,
      creditVoucherNumber: d.voucherNumber,
      tax: d.tax,
      bookings: d.shares.map((s) => ({
        date: s.booking.date,
        voucherNumber: s.booking.voucherNumber,
        tax: s.tax,
      })),
    });
  }
  return { covered, consolidations, skipped };
}

/**
 * The best subset of 2..maxBookings candidates whose liabilities sum to the
 * credit's tax. Shared by the two scopes: the 30-day window split caps the
 * count at `SPLIT_MAX_BOOKINGS` (a journal that pays a quarter's bills is
 * still a journal that pays a few), while the same-month partial search is
 * bounded by its candidate cap instead, because "any number of bookings in
 * this month" is the case the captain named.
 */
function bestSubset(
  d: TdsDeduction,
  cands: { booking: TdsBooking; liability: number }[],
  maxBookings: number,
): { booking: TdsBooking; liability: number }[] | null {
  const n = cands.length;
  const max = Math.min(maxBookings, n);
  let best: { booking: TdsBooking; liability: number }[] | null = null;
  let bestKey = "";
  const consider = (pick: { booking: TdsBooking; liability: number }[]): void => {
    // Fewest bookings, then the tightest date span around the credit, then
    // the earliest booking — a total order, so the choice never depends on
    // iteration luck.
    const dates = pick.map((c) => c.booking.date).sort();
    const span = dateDiffDays(dates[dates.length - 1], dates[0]);
    const key = `${String(pick.length).padStart(2, "0")}|${String(Math.abs(span)).padStart(4, "0")}|${dates[0]}`;
    if (best !== null && key >= bestKey) return;
    best = pick;
    bestKey = key;
  };
  const indices: number[] = [];
  const walk = (start: number, sum: number): void => {
    if (indices.length >= 2 && Math.abs(sum - d.tax) <= TDS_TOLERANCE) {
      consider(indices.map((k) => cands[k]));
    }
    if (indices.length >= max) return;
    for (let i = start; i < n; i++) {
      // Every liability is positive, so a partial sum past the credit's tax
      // can only grow — skip the branch (deterministic, and it bounds the
      // search on a large party).
      const next = sum + cands[i].liability;
      if (next - d.tax > TDS_TOLERANCE) continue;
      indices.push(i);
      walk(i + 1, next);
      indices.pop();
    }
  };
  walk(0, 0);
  return best;
}

/**
 * The evidence a not-deducted finding carries about the credit that was
 * considered and not allocated to this booking (2026-09-29). "No duty credit
 * was found" sent the operator hunting for a payment the books already held:
 * a credit existed for the party and section, it was applied to a different
 * bill, or one journal covered several bills and only some of them. Names,
 * voucher numbers and PANs never appear here — only dates and money, and only
 * for this booking's own deductee and section.
 */
function creditEvidence(
  events: TdsEvents,
  b: TdsBooking,
  section: string,
  ctx: Pick<TdsCtx, "panKeyOf">,
): string {
  const key = deducteeKeyOf(ctx, b.party);
  const seen = events.deductions
    .filter((d) => d.section === section && deducteeKeyOf(ctx, d.party) === key)
    .filter((d) => Math.abs(dateDiffDays(d.date, b.date)) <= SPLIT_WINDOW_DAYS)
    .sort((a, b2) => a.date.localeCompare(b2.date))[0];
  if (!seen) return "";
  const where = seen.shares
    ? `is applied across ${seen.shares.length} bookings of this party and section (${seen.shares
        .map((s) => displayDate(s.booking.date))
        .join(", ")})`
    : seen.booking
      ? `is already applied to the booking of ${displayDate(seen.booking.date)}`
      : "is not applied to any booking of this party and section";
  return ` Evidence considered: a duty credit of ${money(seen.tax)} on ${displayDate(seen.date)} for this party and section ${where} — the payment is in the books, its allocation is not this booking.`;
}

/**
 * Are a booking and a duty credit the SAME voucher? Number equality alone is
 * not that (inbox 016, captain): Tally numbers every voucher TYPE in its own
 * space, so a `Sales` voucher 1 and a `Journal` voucher 1 are two unrelated
 * entries, and a real book's rows collide like that all the year. The rule
 * that arrived with the 2026-09-15 design doc — "join a duty credit to the
 * booking by voucher number when both reports name it" — therefore took a
 * 09-Jun-2025 bill and a 31-Jan-2026 credit as one voucher, both numbered 462,
 * and reported the eight-month-old bill as deducted late.
 *
 * The number is corroborating evidence, not identity: the TDS line must also
 * carry the bill's own date, which is what a duty line sitting on the bill's
 * own voucher looks like (same entry, so same number AND same date). A credit
 * booked separately — the ordinary month-end journal — has its own number and
 * is matched by the date/counterparty rules instead, which is the honest
 * reading. Both pairing sites (the amount tiebreak's voucher preference and
 * the walk's by-voucher phase) go through this one predicate so they can never
 * disagree.
 */
function sameVoucher(b: Pick<TdsBooking, "voucherNumber" | "date">, d: Pick<TdsDeduction, "voucherNumber" | "date">): boolean {
  return !!b.voucherNumber && b.voucherNumber === d.voucherNumber && b.date === d.date;
}

/**
 * Amount-tiebreak pass (captain instruction 2026-09-30), run before the
 * by-voucher / nearest-date walk: settle every duty credit against the
 * booking whose computed liability it matches, across the whole deductee +
 * section stream at once.
 *
 * The tiebreak used to be consulted only inside the walk, so it could only
 * choose among the candidates of the booking being walked, and the walk is in
 * date order — an EARLIER booking could therefore take a credit by date that
 * was owed to a LATER booking. On a real FY a 20-Aug 1,26,200 bill claimed the
 * 1,967 credit of 30-Aug because its own 1% liability (1,262) matched no
 * amount, while the 30-Aug 1,96,740 bill the credit was actually for reported
 * not deducted. Order is irrelevant to an amount match, so it must not be
 * decided by order.
 *
 * Pairs settle strongest-match-first — a same-voucher pair before any other,
 * then the smallest absolute difference between the credit's tax and the
 * booking's liability, so an approximate match can never take a credit that an
 * exact one is owed — and each booking and each credit is consumed once. Every
 * other constraint the walk applies holds here: same deductee
 * (`deducteeKeyOf`), same section, an unclaimed credit with no booking yet, a
 * credit no consolidation already covers, and the 30-day window. A booking
 * with no amount match is left untouched for the walk.
 */
function pairExactAmounts(
  events: TdsEvents,
  stamped: boolean,
  ctx: Pick<TdsCtx, "panKeyOf">,
  claimed: Set<TdsDeduction>,
  skip: Set<TdsBooking>,
): void {
  // A join with the flag off never saw a stamped liability, so it has no
  // amounts to match and must keep the walk's behaviour exactly.
  if (!stamped) return;
  const pairs: { b: TdsBooking; d: TdsDeduction; voucher: boolean; diff: number }[] = [];
  for (const b of events.bookings) {
    if (skip.has(b)) continue;
    // The amount the engine charges this booking ON ITS OWN ACCOUNT. On a
    // cumulative-limit crossing booking that is the netted figure, not
    // `rate x liable` (inbox 016): a real book's crossing bill is paid by a
    // credit computed from the same netting, so matching against the statutory
    // base left the credit to be claimed by the earlier booking the walk
    // reached first and reported the crossing bill not deducted (JANARTHANAN
    // SWD's 1,212 credit of 15-Sep against its 1,211.70 liability).
    const liability = b.chargeNet ?? round2((b.rateApplied ?? 0) * (b.liable ?? 0));
    if (liability <= ZERO) continue;
    const key = deducteeKeyOf(ctx, b.party);
    for (const d of events.deductions) {
      if (d.section !== b.section || d.booking || claimed.has(d)) continue;
      if (deducteeKeyOf(ctx, d.party) !== key) continue;
      if (Math.abs(dateDiffDays(d.date, b.date)) > SPLIT_WINDOW_DAYS) continue;
      const diff = Math.abs(d.tax - liability);
      if (diff > TDS_TOLERANCE) continue;
      pairs.push({ b, d, voucher: sameVoucher(b, d), diff });
    }
  }
  pairs.sort(
    (a, z) =>
      Number(z.voucher) - Number(a.voucher) ||
      a.diff - z.diff ||
      a.b.date.localeCompare(z.b.date) ||
      a.d.date.localeCompare(z.d.date),
  );
  const paired = new Set<TdsBooking>();
  for (const p of pairs) {
    if (claimed.has(p.d) || paired.has(p.b)) continue;
    claimed.add(p.d);
    paired.add(p.b);
    p.d.joinedTo = p.b.voucherNumber;
    p.d.booking = p.b;
  }
}

/**
 * Join the event streams:
 * - an amount tiebreak settles a credit against the booking whose computed
 *   liability it matches, over the whole stream and BEFORE the walk below, so
 *   that a date-earlier booking can never take a credit owed to a later one
 *   (`pairExactAmounts`);
 * - a duty credit joins a booking on the SAME VOUCHER — number and date
 *   agreeing, never number alone, because Tally numbers each voucher type in
 *   its own space (`sameVoucher`, inbox 016) — else by month + counterparty
 *   within 30 days, nearest date first; a counterparty mismatch never joins;
 * - a credit of another section never claims a booking (2026-09-26c): the
 *   by-voucher phase prefers the voucher's same-party credit whose section
 *   equals the booking's, and the month-window phase accepts only
 *   same-section candidates. A cross-section join silently drops the credit
 *   from the deposit chain (the analysis `find` pins the section) while the
 *   booking still reports TDS-001 — both sides wrong;
 * - one credit may cover SEVERAL bookings (2026-09-29) when its tax is the
 *   exact sum of their liabilities — a month of bills netted into one TDS
 *   journal is ordinary practice, and the 1:1 model could only hand that
 *   credit to one bill, stranding the rest (and cascading the pairing for
 *   later bills of the same party). The consolidation pass runs first, covers
 *   the credit's own calendar month for any number of bookings (whole-month
 *   set first, then a bounded partial search) and the 30-day window for up to
 *   `SPLIT_MAX_BOOKINGS` of them, and is skipped whenever an exact 1:1 pairing
 *   exists for that credit. `report` receives the shared credits and the
 *   same-month attempts its bound could not settle;
 * - a deposit joins a duty credit by date + amount, each side consumed once;
 *   a deposit that carries no section (an ambiguous duty ledger's row) joins
 *   only a credit of the same duty ledger.
 */
function joinEvents(
  events: TdsEvents,
  stamped: boolean,
  ctx: Pick<TdsCtx, "panKeyOf">,
  report?: { consolidations: TdsConsolidation[]; skipped: TdsConsolidationSkip[] },
): void {
  const claimed = new Set<TdsDeduction>();
  const byVoucher = new Map<string, TdsDeduction[]>();
  for (const d of events.deductions) {
    if (!d.voucherNumber) continue;
    const list = byVoucher.get(d.voucherNumber) ?? [];
    list.push(d);
    byVoucher.set(d.voucherNumber, list);
  }
  const allocated = stamped ? allocateSplitCredits(events, ctx) : null;
  const splitCovered = allocated?.covered ?? new Set<TdsBooking>();
  if (allocated && report) {
    report.consolidations.push(...allocated.consolidations);
    report.skipped.push(...allocated.skipped);
  }
  // The amount tiebreak first, over the whole stream (2026-09-30): the walk
  // below is in date order and would let an earlier booking claim a credit by
  // date that a later booking's liability is owed. Whatever it settles is
  // `claimed` before the walk and is invisible to it.
  pairExactAmounts(events, stamped, ctx, claimed, splitCovered);
  for (const b of [...events.bookings].sort((a, b) => a.date.localeCompare(b.date))) {
    // A booking a split credit already covers is settled: the credit is
    // claimed, and the walk must not hand it a second credit or let a later
    // booking take the credit that covered it.
    if (splitCovered.has(b)) continue;
    // Same deductee (2026-09-26o item 2), never the same ledger string: one
    // PAN may own several Tally ledgers, and the duty journal may sit under
    // the head-office ledger while the bill sits under the site ledger.
    const sameDeductee = (d: TdsDeduction): boolean =>
      deducteeKeyOf(ctx, d.party) === deducteeKeyOf(ctx, b.party);
    const byVoucherCands = (byVoucher.get(b.voucherNumber) ?? []).filter(
      (d) => sameDeductee(d) && d.section === b.section && !claimed.has(d) && !d.booking && sameVoucher(b, d),
    );
    const monthCands = events.deductions
      .filter((d) => sameDeductee(d) && d.section === b.section && !claimed.has(d) && !d.booking)
      .filter((d) => Math.abs(dateDiffDays(d.date, b.date)) <= 30);
    // No amount match is left — `pairExactAmounts` already settled every
    // credit whose tax equals a booking's liability, so the walk is the
    // fallback chain only: the voucher's own same-party credit first, then
    // the existing nearest-date rule.
    const pick =
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
  let crossIdx = -1;
  for (let i = 0; i < bookings.length; i++) {
    const after = before + bookings[i].gross;
    if (crossIdx < 0 && threshold.aggregate !== undefined && after > threshold.aggregate) {
      agg.crossed = true;
      agg.crossDate = bookings[i].date;
      crossIdx = i;
    }
    before = after;
  }

  let cumulative = 0;
  // The running statutory charge of the earlier bookings (inbox 016). Only the
  // CROSSING booking is netted against it — the same rule and the same index
  // the analysis walk applies — so `chargeNet` publishes per booking the
  // liability the engine will actually charge it, which is what a duty credit
  // booked against that bill settles. (The walk's own running total is taken
  // after the over-deduction bank, so the two can differ by the bank's
  // effect on an earlier booking of the same party; the tiebreak only uses this
  // figure to CHOOSE a pairing, and the walk's figure stays the authority for
  // what is reported.)
  let charged = 0;
  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];
    cumulative += b.gross;
    const singleLiable = threshold.single !== undefined && b.gross > threshold.single;
    let liableBase = 0;
    if (wholeYear) {
      if (law.cumulativeOnCross) {
        // 194-I(a)/(b) (captain 2026-09-30): no deduction while the party's
        // cumulative FY bookings are within the annual aggregate; the crossing
        // booking carries the whole cumulative to date (earlier bookings
        // included) and each later booking its own full gross. The section's
        // year total is unchanged — only the pre-crossing bookings stop being
        // reported. A party that never crosses (crossIdx -1) is never liable.
        // The crossing booking is identified by INDEX, not by date: several
        // bookings can share the crossing date and only the later one carries
        // the crossing.
        if (crossIdx < 0) liableBase = singleLiable ? b.gross : 0;
        else if (i === crossIdx) liableBase = cumulative;
        else if (i > crossIdx || singleLiable) liableBase = b.gross;
      } else if (agg.crossed || singleLiable) liableBase = b.gross;
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
    b.chargeNet = i === crossIdx ? round2(Math.max(0, liability - charged)) : liability;
    charged = round2(charged + Math.max(0, liability));
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
): { events: TdsEvents; findings: TdsFinding[]; totals: TdsTotals; liabilities: TdsLiability[]; clause21b: Clause21bBookRow[]; consolidations: TdsConsolidation[] } {
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
  // Consolidations (2026-09-29): one credit covering several bookings. They
  // raise no finding, so they are collected here and handed to the review.
  const consolidations: TdsConsolidation[] = [];
  const consolidationSkips: TdsConsolidationSkip[] = [];
  joinEvents(events, true, ctx, { consolidations, skipped: consolidationSkips });
  // Consolidated allocations (2026-09-29): a booking a shared credit covers
  // reads that credit, but only its OWN share of the credit's tax — the
  // findings, the interest stamps and the s.40(a)(ia) base all measure the
  // bill, not the journal. Indexed once (never a per-booking scan of the
  // deductions).
  const shareOf = new Map<TdsBooking, { ded: TdsDeduction; share: TdsShare }>();
  for (const d of events.deductions) {
    for (const share of d.shares ?? []) shareOf.set(share.booking, { ded: d, share });
  }
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
  const clause21b: Clause21bBookRow[] = [];
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
  ): string => {
    const id = tdsFindingId(check, nextOrd(check));
    findings.push({
      id,
      check,
      severity,
      deductee,
      group: "Sundry Creditors",
      section,
      amount,
      detail,
      ...(schedule ? { schedule } : {}),
    });
    return id;
  };

  let notDeducted = 0;
  let shortDeducted = 0;
  let interestI = 0;
  let interestIi = 0;
  let notDepositedTax = 0;
  // Short deductions are staged per deductee key and flushed at the end
  // (2026-09-26o item 3): a party's sub-₹100 FY total is not reported, and
  // the floor is measured across all its short rows before any is emitted.
  const shortStage: {
    key: string; party: string; section: string; amount: number; detail: string;
    row?: { date: string; voucherNumber: string; gross: number; tdsDone: number; tdsDeposited: number; depositDate: string | null; liability: number; deductionDate?: string | null };
  }[] = [];
  const stageShort = (
    party: string,
    section: string,
    amount: number,
    detail: string,
    row?: { date: string; voucherNumber: string; gross: number; tdsDone: number; tdsDeposited: number; depositDate: string | null; liability: number; deductionDate?: string | null },
  ): void => {
    shortStage.push({ key: deducteeKeyOf(ctx, party), party, section, amount, detail, ...(row ? { row } : {}) });
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
    // Mapped means AT LEAST ONE candidate section (2026-09-29). `dutySectionOf`
    // returns a section only for a single mapping, so reading its null as
    // "unmapped" called a multi-mapped ledger unmapped — a false positive on
    // a ledger whose credits ARE analysed: `extractEvents` resolves each of
    // its rows against the candidate set and the booking's own section
    // evidence (2026-09-26c), and on a real FY 25-26 run that was 222 bookings
    // and ₹4.42 lakh of duty credits assigned to 194-I(a) and 194-I(b).
    // Without `dutyCandidatesOf` the caller cannot disambiguate at all, so its
    // rows really are skipped and the gap is genuine.
    const candidates = ctx.dutyCandidatesOf?.(duty.ledger) ?? [];
    if (ctx.dutySectionOf(duty.ledger) !== null) continue;
    if (candidates.length > 1) {
      push(
        "tds_master_gap",
        "review",
        duty.ledger,
        null,
        0,
        `the TDS duty ledger ${duty.ledger} is mapped to ${candidates.length} sections (${candidates.join(", ")}); every credit on it is resolved per row from the booking it pays, so the split between them is read from the books, not from the ledger name.`,
      );
      continue;
    }
    push(
      "tds_master_gap",
      "review",
      duty.ledger,
      null,
      0,
      `the TDS duty ledger ${duty.ledger}'s nature of payment has no section mapping; its deductions are not analyzed, never guessed.`
    );
  }

  // A month the consolidation search could not settle (2026-09-29). The whole
  // month's unpaired bookings are always tried, so a skip means the credit
  // covers only PART of a month that has more unpaired bookings than the
  // partial search looks at. Stated in plain words, with the two counts, so
  // the reader knows the bound was hit rather than the rule being off.
  for (const s of consolidationSkips) {
    // What happens to the bookings the credit does not cover depends on the
    // section: 194Q and a timing-only section report their coverage as a
    // party-month or section total (2026-09-26k / 2026-09-26o item 035), so
    // promising a per-booking not-deducted finding there would be a lie.
    const uncovered = s.section === "194Q"
      ? "this section's coverage is reported as a party-month total, not booking by booking"
      : timingOnlySection(s.section)
        ? "this section's deposit position is reported at section level, not booking by booking"
        : "the bookings it does not cover are reported below as not deducted";
    push(
      "tds_consolidation_search_skipped",
      "review",
      s.party,
      s.section,
      0,
      `the duty credit of ${money(s.tax)} dated ${displayDate(s.creditDate)} for ${s.section} in ${displayMonth(`${s.month.slice(0, 4)}-${s.month.slice(4, 6)}`)} did not match all ${count(s.unpairedBookings)} unpaired ${s.unpairedBookings === 1 ? "booking" : "bookings"} of this party that month, and the consolidation search looked at only the first ${count(s.searchedBookings)} of them; ${uncovered}. Split the credit or declare the bookings on the operator file to settle it.`,
    );
  }

  // Deposit-level detail rows (date, deductee, section) for sorting later.

  // Party-month resolved credit totals (2026-09-26d): Σ tax of every
  // RESOLVED duty credit per party|section|month, joined or not. Unresolved
  // (null-section) rows never cover. Journal-level credit patterns — several
  // liability-bearing bookings covered by one combined journal credit — read
  // as covered here even when no single credit joins each booking 1:1.
  const monthCredit = new Map<string, number>();
  // The SAME credits, one by one, so a month's over-payment can be attributed to
  // the credit it came from and spent on an EARLIER month's liability (inbox
  // 016). Built alongside `monthCredit` so the two can never disagree.
  const monthCredits = new Map<string, TdsDeduction[]>();
  for (const d of events.deductions) {
    if (d.section === null) continue;
    const mk = `${deducteeKeyOf(ctx, d.party)}|${d.section}|${d.date.slice(0, 6)}`;
    monthCredit.set(mk, (monthCredit.get(mk) ?? 0) + d.tax);
    const list = monthCredits.get(mk);
    if (list) list.push(d);
    else monthCredits.set(mk, [d]);
  }

  // The tax of a deduction the review treats as paid by the s.139(1) due date:
  // a 1:1 joined deposit wins, else the month pool's cover or the return's
  // subsequent-year challan. (The 21(b) sheet no longer reports a covered
  // credit's deducted tax — a short row carries only the undeducted portion,
  // captain 2026-09-26 — so this helper is no longer needed here.)

  for (const agg of aggs.values()) {
    const section = agg.section;
    const law = lawOf(section)!;
    const wholeYear = law.wholeYearOnCross;
    const threshold = law.threshold;

    // Aggregation preserves date order (built from a date-sorted walk), but
    // the running cumulative is correctness-critical, so pin it here.
    const bookings = [...agg.bookings].sort((a, b) => a.date.localeCompare(b.date));

    let before = 0;
    let crossIdx = -1;
    for (let i = 0; i < bookings.length; i++) {
      const after = before + bookings[i].gross;
      if (crossIdx < 0 && threshold.aggregate !== undefined && after > threshold.aggregate) {
        crossIdx = i;
      }
      before = after;
    }

    // The credit this booking was actually credited: its own share of a split
    // credit (the 1:1 field points at the credit's FIRST share, so the
    // whole-credit tax is never read here), else the 1:1 join. Read here
    // rather than inside the loop because the crossing netting below needs it
    // for bookings the walk never reaches.
    const deductionOf = (
      b: TdsBooking,
    ): { ded: TdsDeduction; split: { ded: TdsDeduction; share: TdsShare } | undefined } | null => {
      const split = shareOf.get(b);
      const ded =
        split?.ded ??
        events.deductions.find(
          (d) =>
            d.booking === b &&
            deducteeKeyOf(ctx, d.party) === deducteeKeyOf(ctx, b.party) &&
            d.section === section,
        );
      return ded ? { ded, split } : null;
    };
    const taxPaidOn = (b: TdsBooking): number => {
      const found = deductionOf(b);
      return found ? (found.split ? found.split.share.tax : found.ded.tax) : 0;
    };

    // Pass 1 already ran before the join (2026-09-26g sum); the stamped
    // bookings carry liable/rateApplied, and the agg carries monthLiability.
    const stamped = agg as Agg & { monthLiability?: Map<string, number> };
    const monthLiability = stamped.monthLiability ?? new Map<string, number>();

    // ---- The settlement plan (inbox 016, captain's v11) ------------------------
    //
    // The per-booking arithmetic is computed ONCE, here, and the findings walk
    // below only READS it, so a settlement can never disagree with the figures
    // the findings quote.
    //
    // A duty credit's excess over the liability of the booking it is booked
    // against is not that booking's business: it is credit against another
    // liability of the same party, section and year. Until v11 the bank
    // (captain 2026-09-30, third point) was FORWARD-ONLY, so an excess left
    // over at the end of a year reported the earlier unpaid bills as NOT
    // deducted. The captain's case: N. R. BABU's 194-C books carry 1,370.50 of
    // duty against 1,371.00 of credits, and v10 reported the November bills
    // 1,250 not deducted because the credits' own pairing had already spent
    // them on a later bill.
    //
    // The POOL below is that bank as a list of unspent rupees that each carry
    // the credit they came from. It is filled in booking order and spent in two
    // passes, so the same rupee can never be settled twice:
    //   1. BACKWARD (captain, inbox 016): the earliest still-unpaid booking is
    //      settled oldest-first by the earliest unspent credit dated ON OR AFTER
    //      that booking, and what it pays is reported as a LATE DEDUCTION from
    //      the booking's due date to the credit's date — the credit exists, it
    //      was simply booked after the bill it pays. A credit dated BEFORE a
    //      booking is an advance and never reaches this pass.
    //   2. FORWARD: whatever the backward pass left reduces the next booking's
    //      own liability, exactly as the v10 scalar bank did.
    //
    // Both passes are skipped for 194Q, whose liability settles at party-month
    // grain below, and for a timing-only section, whose 194T position is
    // monitored at section level — there an excess carries forward as in v10.
    type Cover = { ded: TdsDeduction; tax: number };
    interface PlanRow {
      b: TdsBooking;
      /** The statutory tax on this booking's own base, less what earlier bookings were already charged. */
      base: number;
      /** `base` less whatever the forward bank covered. */
      liability: number;
      /** The credit this booking was paired with (its own share, or a 1:1 join), if any. */
      own: { ded: TdsDeduction; split: { ded: TdsDeduction; share: TdsShare } | undefined } | null;
      ownTax: number;
      /** Credits that settled this booking out of the pool, oldest first. */
      backs: Cover[];
    }
    const pool: { ded: TdsDeduction; date: string; remaining: number }[] = [];
    const plan: PlanRow[] = [];
    // Liability already charged on EARLIER bookings of this party and section
    // (firstmate 2026-09-30, the double-count finding). A cumulative-limit
    // crossing booking carries the tax on the year's cumulative to its date,
    // which already includes the liability an earlier booking was charged on its
    // own account — a per-bill single-limit bill inside the year. The captain's
    // example: a 194-C bill of 55,764 on 15-Oct (over the 30,000 per-bill limit,
    // so 1,115.28 was due and charged there) is inside the 2,17,681.20 the
    // 26-Dec crossing charges, so charging the full 4,353.62 there makes
    // 1,115.28 liable twice and reports 1,114.90 on a party that paid
    // everything. The crossing therefore carries the cumulative LESS what is
    // already charged; the year still sums to the tax on the year's base, never
    // more (the invariant `test/tds-194i-threshold.test.ts` pins).
    //
    // `charged` accumulates the STATUTORY charge (`base`), not what was left
    // payable after the bank: a booking whose liability a credit overpaid was
    // still charged that tax, and letting the crossing charge it again would
    // count the same rupee twice.
    let charged = 0;
    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      const found = deductionOf(b);
      // A cumulative-limit crossing booking carries the tax on the year's
      // cumulative to its date, less the liability already charged on this
      // party's earlier bookings (see `charged`): at the crossing `b.liable`
      // IS the cumulative gross, so the ordinary rate x liable product is
      // exactly the number to net.
      const base =
        i === crossIdx
          ? round2((b.rateApplied ?? 0) * (b.liable ?? 0) - charged)
          : round2((b.rateApplied ?? 0) * (b.liable ?? 0));
      const ownTax = found ? (found.split ? found.split.share.tax : found.ded.tax) : 0;
      // What this booking's own credit did beyond its own liability is a free
      // rupee for this party, section and year — the pool's raw material. A
      // split credit's share is that share's own liability by construction, so
      // nothing banks; the 1:1 field points at the credit's FIRST share, so the
      // whole-credit tax is never read here.
      if (found) {
        const excess = round2(Math.max(0, ownTax - base));
        if (excess > ZERO) pool.push({ ded: found.ded, date: found.ded.date, remaining: excess });
      }
      charged = round2(charged + Math.max(0, base));
      plan.push({ b, base, liability: base, own: found, ownTax, backs: [] });
    }

    if (section !== "194Q" && !timingOnlySection(section)) {
      // Oldest credit first: a party that overpaid in June should not have a
      // December bill settled before an October one.
      const byDate = [...pool].sort(
        (x, y) => x.date.localeCompare(y.date) || pool.indexOf(x) - pool.indexOf(y),
      );
      for (const row of plan) {
        let unpaid = round2(row.liability - row.ownTax);
        for (const e of byDate) {
          if (unpaid <= TDS_TOLERANCE) break;
          if (e.remaining <= ZERO) continue;
          // An advance — the credit predates the bill — is the forward bank's
          // business, never a late deduction of this booking.
          if (e.date < row.b.date) continue;
          const taken = round2(Math.min(e.remaining, unpaid));
          e.remaining = round2(e.remaining - taken);
          unpaid = round2(unpaid - taken);
          row.backs.push({ ded: e.ded, tax: taken });
        }
      }
      for (const row of plan) {
        // A booking never draws from the pool a rupee its OWN credit put there:
        // that credit already covers this booking's base, so its excess belongs
        // to OTHER bookings. The captain's case: the 4,354 deducted on 16-Oct
        // covers the 15-Oct bill's own 1,115.28 and leaves 3,238.72 for the
        // 26-Dec bill — without this guard the forward pass would hand 1,115.28
        // of that excess straight back to the bill that produced it and report
        // 1,114.90 on a party that paid everything (inbox 015, still true in
        // v10's order-of-operations terms).
        if (row.ownTax >= row.base) continue;
        // Only what the backward pass did NOT already settle: the pool is one
        // pot, and a rupee it gave this booking above can never be spent on it
        // twice (the captain's 194-C fixture left 9.00 of a 2,750 payment over
        // and the first bill was shorted by exactly that 9.00).
        let want = round2(row.liability - row.backs.reduce((t, c) => t + c.tax, 0));
        let fromBank = 0;
        for (const e of pool) {
          if (want <= ZERO) break;
          if (e.remaining <= ZERO) continue;
          // An ADVANCE — the credit predates the bill — is the only thing this
          // direction is for. A credit dated after the bill settles it
          // BACKWARD, with s.201(1A)(i) interest (the pass above); taking it
          // here instead would discharge the bill silently.
          if (e.date > row.b.date) continue;
          const taken = round2(Math.min(e.remaining, want));
          e.remaining = round2(e.remaining - taken);
          want = round2(want - taken);
          fromBank = round2(fromBank + taken);
        }
        // Only what this pass actually took from the pool reduces the
        // liability; the backward cover stays in it, so the shortfall it leaves
        // is still reported (inbox 018).
        row.liability = round2(row.liability - fromBank);
      }
    }

    // Pass 2 — findings, on the stamped bookings and the settlement plan above.
    // Everything below READS the plan: the arithmetic was done once, so a
    // backward settlement and the figure a finding quotes cannot diverge.
    for (let i = 0; i < bookings.length; i++) {
      const row = plan[i];
      const b = row.b;
      const { liability } = row;
      const found = row.own;
      // What was actually credited against this booking: its own credit first,
      // then any pool credit that settled it from behind (inbox 016).
      const dedTax = round2(row.ownTax + row.backs.reduce((t, c) => t + c.tax, 0));
      // Covered means some credit paid some of what was due — its own, or a
      // later one the plan settled this booking with.
      const covered = found !== null || row.backs.length > 0;
      // A booking inside the annual limit owes no tax (captain 2026-09-30) and
      // is silent — but only while it also carries no credit. A credit paired
      // to such a booking is a real deduction, and its own timeliness is a
      // real question (firstmate 2026-09-30): the pre-crossing monthly
      // deductions of a rent party that later crosses the limit keep their
      // late-deduction and late-deposit findings.
      if (liability <= TDS_TOLERANCE && !covered) continue;
      const silent = liability <= TDS_TOLERANCE;
      const rate = rateFor(ctx, b.party, section, b.date);

      const panNote = rate.via206AA
        ? " (s.206AA: no PAN on the deductee)"
        : ctx.panDerivedFromGstinOf?.(b.party)
          ? " (PAN derived from GSTIN)"
          : "";
      if (!silent && ctx.transporterDeclared(b.party) && section === "194C") {
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

      const split = found?.split;
      const ded = found?.ded;
      // The tax this booking was actually credited: its own share of a split
      // credit, the whole credit on a 1:1 join.
      if (!silent) {
        // Per-booking liability fact, additive: the exact figures the findings
        // above derive from, captured here so the 194Q running-cumulative and
        // whole-year rules are never re-derived in a second module. `ded` is
        // null for an undeducted booking; no other filtering is applied.
        liabilities.push({ booking: b, section, liableBase: b.liable ?? 0, liability, rate: b.rateApplied ?? rate.rate, deduction: ded ?? null });
      }
      if (!covered) {
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
        // 194-I(a)/(b) crossing booking (captain 2026-09-30): the liability was
        // measured on the cumulative booked to that date, not on this booking's
        // own gross, so the expenditure reported with it (s.40(a)(ia) base and
        // the 21(b) row) is that same base — the 194Q `liability / rate`
        // precedent, and never the single booking's gross.
        const expense = law.cumulativeOnCross ? (b.liable ?? 0) : b.gross;
        notDeducted += liability;
        notDeductedBase += expense;
        // Say so in the finding: on this booking the payable tax is a multiple
        // of its own gross, which is only true at a crossing.
        const crossNote =
          law.cumulativeOnCross && round2(b.liable ?? 0) !== round2(b.gross)
            ? ` on the ${money(b.liable ?? 0)} booked to this date, including the earlier bookings within the annual limit`
            : "";
        const notDeductedId = push(
          "tds_not_deducted",
          "critical",
          b.party,
          section,
          liability,
          `booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${panNote}: tax of ${money(liability)} was payable${crossNote}, but no duty credit was found.${creditEvidence(events, b, section, ctx)}`,
        );
        clause21b.push({
          party: b.party, date: b.date, voucherNumber: b.voucherNumber,
          gross: expense, tdsDone: 0, tdsDeposited: 0, depositDate: null,
          section, reason: "not_deducted", liability, findingId: notDeductedId,
        });
        continue;
      }
      // Deposit checks: the joined deposit was matched in joinEvents. Read
      // before the short stage — the clause 21(b) short row carries the
      // deposit facts it can see.
      const dep = events.deposits.find((e) => e.deduction === ded);
      // Interest stamps land on the SHARE when the credit is split, so one
      // journal covering several bills never carries a single bill's interest
      // and never loses the other bills' (the 3CD interest rows read them).
      const stampInterestI = (v: number): void => {
        if (split) split.share.interestI = v;
        else if (ded) ded.interestI = v;
      };
      const stampInterestII = (v: number): void => {
        if (split) split.share.interestII = v;
        else if (ded) ded.interestII = v;
      };
      if (dedTax < liability - TDS_TOLERANCE && section !== "194Q" && !timingOnlySection(section)) {
        // The 21(b) sheet reports only the UNDEDUCTED portion of the expense
        // (captain, 2026-09-26): shortfall tax / the applicable rate, with TDS
        // done and deposited at 0 — no tax was deducted on that portion. The
        // finding above still carries the full payment facts.
        const shortRate = b.rateApplied ?? rate.rate;
        stageShort(
          b.party,
          section,
          round2(liability - dedTax),
          ded
            ? `duty credit of ${money(dedTax)} on ${displayDate(ded.date)} is short of the ${money(liability)} payable on the booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${panNote}.`
            : `duty credit of ${money(dedTax)} booked on or after ${displayDate(b.date)} is short of the ${money(liability)} payable on the booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${panNote}.`,
          {
            date: b.date,
            voucherNumber: b.voucherNumber,
            gross: shortRate > 0 ? round2((liability - dedTax) / shortRate) : b.gross,
            tdsDone: 0,
            tdsDeposited: 0,
            depositDate: dep?.date ?? ded?.subsequentDeposit ?? null,
            liability,
            // The credit's own date, for the payable statement's interest (i).
            deductionDate: ded?.date ?? null,
          },
        );
      }
      // s.201(1A) interest (i) runs on what was DUE by the deductible date, for
      // each credit that paid it, oldest credit first (inbox 016: a credit the
      // settlement plan spent on an EARLIER booking is a late deduction of that
      // booking, charged from the booking's own due date to the credit's date —
      // not a not-deduction).
      //
      // The deductible date is the booking's own date, pulled earlier by an (e)
      // payment (a receipt) that precedes the booking and lands on or before
      // this credit. A same-month consolidation carries the month's BATCH date,
      // not this booking's own deduction date (2026-09-29, captain: one
      // deduction entry against several bookings of the same month is normal
      // bookkeeping). Every monthly-payment section falls due by the 7th of the
      // month AFTER the booking (s.201(1) proviso read with the section's own
      // schedule), so a journal dated inside the booking's own month is never
      // late — the finding (and its s.201(1A) interest) would be an artefact of
      // the batch date. A delay of a real month or more is still reported, and
      // so is every finding for a cross-month "window" consolidation.
      //
      // What was actually DUE by the deductible date, and so what interest (i)
      // can run on: the booking's own liability, capped at the tax each credit
      // actually paid. A credit larger than that liability is an over-deduction
      // made in ADVANCE (captain 2026-09-30, third point: a 194-C bill of 55,764
      // carried 4,354 where only 1,115.28 was due), and an advance payment is
      // not "paid late" — the tax it over-paid belongs to a later booking, and
      // its interest is charged there, from that booking's own due date. When
      // NOTHING was due by then (a booking inside an annual limit, or one whose
      // liability the bank already covered) there is no late deduction at all.
      const covers: { ded: TdsDeduction; tax: number; own: boolean }[] = [];
      if (found && ded) covers.push({ ded, tax: row.ownTax, own: true });
      for (const c of row.backs) covers.push({ ...c, own: false });
      covers.sort((x, y) => x.ded.date.localeCompare(y.ded.date));
      // The covers discharge the booking's liability as it stood BEFORE the
      // forward bank: an advance (the forward pass) is not a cover and carries
      // no lateness, so adding the backward settlement back is what lets a bill
      // settled by a LATER credit still report its s.201(1A)(i). `liability` is
      // the plan's post-bank figure, and `row.liability` is exactly
      // `base - backs - advance` (inbox 018).
      let remaining = round2(liability + row.backs.reduce((t, c) => t + c.tax, 0));
      for (const cover of covers) {
        if (remaining <= TDS_TOLERANCE) break;
        const dueAtDate = Math.min(remaining, cover.tax);
        remaining = round2(remaining - cover.tax);
        const creditDate = cover.ded.date;
        const advance = events.payments
          .filter((p) => p.party === b.party && p.date < b.date && p.date <= creditDate)
          .map((p) => p.date)
          .sort()[0];
        const deductibleDate = advance ?? b.date;
        if (
          dueAtDate <= TDS_TOLERANCE ||
          creditDate <= deductibleDate ||
          cover.ded.consolidated === "month" ||
          (ctx.lateDeductionInterest ?? true) === false
        ) {
          continue;
        }
        const shielded = ctx.deducteeFiledReturn(b.party);
        const months = calendarMonths(deductibleDate, creditDate);
        const interest = shielded ? 0 : interestOn(0.01, months, dueAtDate);
        // A backward settlement is not "a deduction was late" — the operator
        // needs to see that the books DID deduct, on a later date.
        const paid = cover.own
          ? `deduction of ${money(dueAtDate)} on ${displayDate(creditDate)}`
          : `duty credit of ${money(dueAtDate)} on ${displayDate(creditDate)}, booked after the bill it settles (payable on the booking of ${money(b.gross)} on ${displayDate(b.date)})`;
        push(
          "tds_late_deducted",
          "warning",
          b.party,
          section,
          dueAtDate,
          shielded
            ? `${paid} is after the ${displayDate(deductibleDate)} deductible date; s.201(1) proviso shields interest (i) (deductee filed a return).`
            : `${paid} is after the ${displayDate(deductibleDate)} deductible date; s.201(1A) interest (i) of ${money(interest)} for ${months} month(s) at 1%.`,
          shielded ? undefined : [{ kind: "i", amount: interest, from: deductibleDate, to: creditDate, basis: `1% of ${months} month(s)` }],
        );
        interestI += interest;
        // The 3CD interest sheets are read off the deduction and its shares.
        // A PAIRED credit stamps there; a backward settlement is neither one of
        // this credit's own deductions nor a share, so it carries its own
        // s.201(1A)(i) on the credit and `tds3cd` adds it (inbox 018) —
        // additive, since one credit can settle several bills and the 194Q
        // month pass settles the same credit again at month grain.
        if (cover.own) stampInterestI(interest);
        else cover.ded.backInterestI = round2((cover.ded.backInterestI ?? 0) + interest);
      }
      // Deposit checks: the joined deposit was matched in joinEvents.
      // 2026-09-26t (inbox 075, captain): where a Winman return challan covers
      // the deduction, its date is the deposit date for lateness — overriding an
      // in-window book remittance (1:1 or month-pool). The book remittance date
      // applies only where no challan covers the deduction.
      //
      // A consolidated credit's deposit facts belong to the CREDIT (2026-09-29):
      // one credit deposited once cannot be late once per share — on a real
      // company that repetition reported 734 late-deposit findings for 65
      // credits. They are raised once, on the credit's primary booking, for the
      // credit's whole tax. A credit that covers several bookings contributes
      // NO s.40(a)(ia) base at all (below): the month's single deposit must be
      // resolved against the month pool (2026-09-26e) first, and a base spread
      // over the month's bookings overstates the disallowance — a 194Q
      // liability is only its post-threshold excess, so multiplying it out
      // read a whole month's purchases as not-deposited expenditure.
      // A credit the plan settled this booking with FROM BEHIND has no deposit
      // chain to run here (inbox 016): that credit's deposit facts are raised
      // once, on its own primary booking, and a second s.40(a)(ia) base or a
      // second late-deposit row would count the same payment twice. Nothing
      // follows in this walk, so skipping the rest is the same as continuing.
      if (!ded) continue;
      const consolidated = ded.shares !== undefined;
      const creditReported = !consolidated || ded.booking === b;
      // The credit's own tax, never the total credited to this booking: a
      // backward settlement pays a DIFFERENT credit, whose tax belongs to that
      // credit's own booking.
      const creditTax = consolidated ? ded.tax : row.ownTax;
      if (creditReported && dep && ded.subsequentDeposit && ded.date <= ctx.asOnDate) {
        const due = depositDue(ded.date);
        if (ded.subsequentDeposit > due) {
          const months = calendarMonths(ded.date, ded.subsequentDeposit);
          const ii = interestOn(0.015, months, creditTax);
          push(
            "tds_late_deposit",
            "warning",
            b.party,
            section,
            creditTax,
            `deposit on ${displayDate(ded.subsequentDeposit)} after the Rule 30 due date of ${displayDate(due)} — per the return's challan; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%.`,
            [{ kind: "ii", amount: ii, from: ded.date, to: ded.subsequentDeposit, basis: `1.5% of ${months} month(s)` }],
          );
          interestIi += ii;
          stampInterestII(ii);
        }
      } else if (creditReported && dep) {
        const due = depositDue(ded.date);
        if (dep.date > due) {
          const months = calendarMonths(ded.date, dep.date);
          const ii = interestOn(0.015, months, creditTax);
          push(
            "tds_late_deposit",
            "warning",
            b.party,
            section,
            creditTax,
            `deposit on ${displayDate(dep.date)} after the Rule 30 due date of ${displayDate(due)}; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%.`,
            [{ kind: "ii", amount: ii, from: ded.date, to: dep.date, basis: `1.5% of ${months} month(s)` }],
          );
          interestIi += ii;
          stampInterestII(ii);
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
            creditTax,
            `book deposit on ${displayDate(dep.date)} disagrees with the operator challan for section ${section}, month ${month}.`,
          );
        }
      } else if (creditReported && ded.subsequentDeposit && ded.date <= ctx.asOnDate) {
        // Deposited in the subsequent year (2026-09-26i): deposited, but
        // after the FY end — lateness interest (ii) still runs to the
        // challan date, while the s.40(a)(ia) base is untouched (the engine
        // only stamps allocations on or before the s.139(1) due date).
        const due = depositDue(ded.date);
        if (ded.subsequentDeposit > due) {
          const months = calendarMonths(ded.date, ded.subsequentDeposit);
          const ii = interestOn(0.015, months, creditTax);
          push(
            "tds_late_deposit",
            "warning",
            b.party,
            section,
            creditTax,
            `deposit on ${displayDate(ded.subsequentDeposit)} after the Rule 30 due date of ${displayDate(due)} — per the return's challan; s.201(1A) interest (ii) of ${money(ii)} for ${months} month(s) at 1.5%.`,
            [{ kind: "ii", amount: ii, from: ded.date, to: ded.subsequentDeposit, basis: `1.5% of ${months} month(s)` }],
          );
          interestIi += ii;
          stampInterestII(ii);
        }
      } else if (ded.date <= ctx.asOnDate && !ded.depositCovered && !consolidated) {
        // One credit, one deposit: the tax and the finding are the credit's,
        // raised on its primary booking (2026-09-29).
        notDepositedTax += creditTax;
        // s.40(a)(ia) base is proportional to the tax NOT deposited (2026-09-26o
        // item 041): when a deduction carries only part of the booking's tax
        // (a split 194T draw), only that share of the expenditure disallows.
        // A timing-only section is handled once at section level below (its
        // joined and orphan credits must not be double-counted).
        if (!timingOnlySection(section)) {
          notDepositedBase += liability > ZERO ? round2(b.gross * (row.ownTax / liability)) : b.gross;
        }
        if (creditReported) {
          const notDepositedId = push(
            "tds_not_deposited",
            "critical",
            b.party,
            section,
            creditTax,
            `duty credit of ${money(creditTax)} on ${displayDate(ded.date)} has no deposit debit by ${displayDate(ctx.asOnDate)} (the Rule 30 due date falls next month).`,
          );
          clause21b.push({
            party: b.party, date: b.date, voucherNumber: b.voucherNumber,
            gross: b.gross, tdsDone: creditTax, tdsDeposited: 0, depositDate: null,
            section, reason: "not_deposited", liability, findingId: notDepositedId,
            // The undedeposited credit's own date — the payable statement's
            // "date of deduction" and the base of its s.201(1A) (ii) run.
            deductionDate: ded.date,
          });
        }
      }
    }

    // 194Q party-month matching (2026-09-26k): the month's resolved duty
    // credits are matched against the month's whole liability — one finding
    // per short party-month instead of one per purchase voucher. Zero
    // credits for the month stay tds_not_deducted; partial credits become
    // tds_short_deducted for the shortfall. The ₹50 lakh annual threshold
    // and the C8 excess-only base are unchanged (stamped above); other
    // sections keep the per-booking matching.
    //
    // A credit of a LATER month than the purchases it pays settles them
    // backwards (inbox 016): a month whose liability is still open is covered
    // by the oldest still-unspent credit of a later month, and the amount it
    // takes is a `tds_late_deducted` (s.201(1A)(i), from the month's own last
    // purchase date to the credit's date) rather than an undeducted one. Only
    // the month's residue is reported below.
    if (section === "194Q") {
      const monthGross = new Map<string, { party: string; gross: number; date: string; last: string; liable: number }>();
      for (const b of bookings) {
        if ((b.liable ?? 0) <= 0) continue;
        const mk = `${deducteeKeyOf(ctx, b.party)}|${section}|${b.date.slice(0, 6)}`;
        if (!monthLiability.has(mk)) continue;
        const cur = monthGross.get(mk) ?? { party: b.party, gross: 0, date: b.date, last: b.date, liable: 0 };
        cur.gross += b.gross;
        cur.liable += b.liable ?? 0;
        if (b.date > cur.last) cur.last = b.date;
        monthGross.set(mk, cur);
      }
      // One slot per party-month: what the month owed, what its own credits
      // paid, and what is still open.
      interface QSlot {
        mk: string;
        party: string;
        gross: number;
        liable: number;
        liab: number;
        cred: number;
        date: string;
        backs: { ded: TdsDeduction; tax: number }[];
      }
      const slots: QSlot[] = [];
      const slotByMk = new Map<string, QSlot>();
      for (const [mk, m] of monthGross) {
        const liab = round2(monthLiability.get(mk) ?? 0);
        if (liab <= TDS_TOLERANCE) continue;
        const s: QSlot = {
          mk, party: m.party, gross: m.gross, liable: m.liable, liab,
          cred: round2(monthCredit.get(mk) ?? 0), date: m.last, backs: [],
        };
        slots.push(s);
        slotByMk.set(mk, s);
      }
      // The pool: each credit's excess over the liability of its OWN month,
      // oldest credit first within the month, carrying the credit it came
      // from. A month with no liability of its own (before the ₹50 lakh
      // crossing) contributes its whole credit — but only the agg's OWN
      // deductees' credits, keyed exactly like `monthCredit`.
      const qpool: { ded: TdsDeduction; date: string; month: string; remaining: number }[] = [];
      const partyKeys = new Set(slots.map((s) => s.mk.slice(0, -7)));
      for (const [mk, list] of monthCredits) {
        if (!partyKeys.has(mk.slice(0, -7))) continue;
        const s = slotByMk.get(mk);
        let owed = s ? s.liab : 0;
        const month = mk.slice(-6);
        for (const d of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
          const applied = Math.min(d.tax, Math.max(0, owed));
          owed = round2(owed - applied);
          const excess = round2(d.tax - applied);
          if (excess > ZERO) qpool.push({ ded: d, date: d.date, month, remaining: excess });
        }
      }
      // Backward settlement (inbox 016): a later month's credit that pays an
      // EARLIER month's still-open liability is a LATE DEDUCTION, not an
      // undeducted one — the books did deduct, on a later date. Oldest credit
      // first, oldest open month first.
      const open = slots
        .map((s) => ({ s, unpaid: round2(Math.max(0, s.liab - s.cred)) }))
        .filter((o) => o.unpaid > TDS_TOLERANCE)
        .sort((a, b) => a.s.mk.localeCompare(b.s.mk));
      qpool.sort((a, b) => a.date.localeCompare(b.date));
      for (const e of qpool) {
        if (e.remaining <= ZERO) continue;
        for (const o of open) {
          if (o.unpaid <= TDS_TOLERANCE) break;
          // A credit of the SAME or an EARLIER month is an advance against
          // the month's own liability, never a late payment of it.
          if (e.month <= o.s.mk.slice(-6)) continue;
          const taken = round2(Math.min(e.remaining, o.unpaid));
          if (taken <= ZERO) continue;
          e.remaining = round2(e.remaining - taken);
          o.unpaid = round2(o.unpaid - taken);
          o.s.backs.push({ ded: e.ded, tax: taken });
        }
      }
      for (const s of slots) {
        const { party: m, gross, liable, liab, cred, date } = s;
        const label = displayDate(`${s.mk.slice(-6)}01`).slice(3);
        const r0 = rateFor(ctx, s.party, section, s.date);
        const panNote = r0.via206AA
          ? " (s.206AA: no PAN on the deductee)"
          : ctx.panDerivedFromGstinOf?.(s.party)
            ? " (PAN derived from GSTIN)"
            : "";
        for (const back of s.backs) {
          // The month's purchases were due on its own last date, so a credit
          // from a later month is late by construction (the pool only holds
          // strictly later months). Same-day credits are inside the month.
          if (back.ded.date <= s.date) continue;
          const shielded = ctx.deducteeFiledReturn(s.party);
          const months = calendarMonths(s.date, back.ded.date);
          const interest = (ctx.lateDeductionInterest ?? true) === false || shielded
            ? 0
            : interestOn(0.01, months, back.tax);
          const paid = `duty credit of ${money(back.tax)} on ${displayDate(back.ded.date)} settles the ${money(liab)} payable on purchases of ${money(s.gross)} for ${label} under section ${section} (payable on ${displayDate(s.date)})`;
          push(
            "tds_late_deducted",
            "warning",
            s.party,
            section,
            back.tax,
            shielded
              ? `${paid}, booked after that date; s.201(1) proviso shields interest (i) (deductee filed a return).`
              : `${paid}, booked after that date; s.201(1A) interest (i) of ${money(interest)} for ${months} month(s) at 1%.`,
            interest > 0
              ? [{ kind: "i", amount: interest, from: s.date, to: back.ded.date, basis: `1% of ${months} month(s)` }]
              : undefined,
          );
          interestI += interest;
          // Additive, and on `backInterestI` rather than `interestI`: the
          // per-booking walk may already have settled this very credit for a
          // bill of its own, and the 3CD interest rows add the backward stamp
          // of its own so the two can never be counted twice (inbox 018).
          back.ded.backInterestI = round2((back.ded.backInterestI ?? 0) + interest);
        }
        const paidTotal = round2(cred + s.backs.reduce((t, c) => t + c.tax, 0));
        const resid = round2(Math.max(0, liab - paidTotal));
        if (resid <= TDS_TOLERANCE) continue;
        if (cred <= TDS_TOLERANCE && s.backs.length === 0) {
          notDeducted += liab;
          notDeductedBase += gross;
          const qId = push(
            "tds_not_deducted",
            "critical",
            m,
            section,
            liab,
            `purchases of ${money(gross)} for ${label} under section ${section}${panNote}: tax of ${money(liab)} was payable, but no duty credit was found for the month.`,
          );
          clause21b.push({
            party: m, date: `${s.mk.slice(-6)}01`, voucherNumber: "",
            // 194Q no-deduction: the expense is the TAXABLE part of the month
            // (the excess beyond the ₹50 lakh crossing), not the whole month's
            // purchases (captain, 2026-09-26) — the liable tax / the applicable
            // rate. `liable` is that same base, used as a zero-rate fallback.
            gross: r0.rate > 0 ? round2(liab / r0.rate) : round2(liable),
            tdsDone: 0, tdsDeposited: 0, depositDate: null,
            section, reason: "not_deducted", liability: liab, findingId: qId,
          });
        } else {
          // The month's shortfall is undeducted tax, so the 21(b) row reports
          // only that portion of the expense — shortfall tax / the applicable
          // rate — with TDS done and deposited at 0 (captain, 2026-09-26).
          // A backward settlement has already reported its share as a late
          // deduction above, so only the RESIDUE lands here.
          const backText = s.backs.length > 0
            ? ` (${money(paidTotal)} was deducted later, reported as a late deduction above)`
            : "";
          stageShort(
            m,
            section,
            resid,
            `duty credits of ${money(cred)} for ${label}${backText} fall short of the ${money(liab)} payable on purchases of ${money(gross)} under section ${section}${panNote}.`,
            {
              date: `${s.mk.slice(-6)}01`,
              voucherNumber: "",
              gross: r0.rate > 0 ? round2(resid / r0.rate) : round2(liable),
              tdsDone: 0,
              tdsDeposited: 0,
              depositDate: null,
              liability: liab,
            },
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
        `aggregate of ${money(agg.gross)} crossed the threshold in ${displayDate(agg.crossDate)}: ${
          law.cumulativeOnCross
            ? "the amounts booked up to the crossing are liable on the crossing booking itself and each later booking in full;"
            : wholeYear
              ? "the whole year's amounts are liable;"
              : "only the amount beyond the crossing is liable (section 194Q);"
        }`,
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
    const timingId = push(
      "tds_not_deposited",
      "critical",
      d.party,
      section,
      d.tax,
      `duty credit of ${money(d.tax)} on ${displayDate(d.date)} has no deposit debit by ${displayDate(ctx.asOnDate)} (the Rule 30 due date falls next month).`,
    );
    clause21b.push({
      party: d.party, date: d.date, voucherNumber: d.voucherNumber,
      // The disallowed expenditure is this deduction's proportional share of
      // the section's whole booking base (2026-09-26o item 041 logic, split
      // per draw for 21(b)): section gross × (this credit's tax / the
      // section's total tax). A section with no booking base keeps the draw.
      gross: (() => {
        const sectionGross = timingSectionGross.get(section) ?? 0;
        const totalTax = timingSectionTax.get(section) ?? 0;
        return sectionGross > ZERO && totalTax > ZERO
          ? round2(sectionGross * (d.tax / totalTax))
          : (d.drawGross ?? 0);
      })(),
      tdsDone: d.tax, tdsDeposited: 0, depositDate: null,
      section, reason: "not_deposited", liability: d.tax, findingId: timingId,
      deductionDate: d.date,
    });
  }
  for (const [section, undep] of timingUndepositedTax) {
    const gross = timingSectionGross.get(section) ?? 0;
    const totalTax = timingSectionTax.get(section) ?? 0;
    notDepositedBase += totalTax > ZERO ? round2(gross * (undep / totalTax)) : gross;
  }

  // Flush the staged short deductions (2026-09-26o item 3): a deductee's
  // whole-FY short total (across sections) below ₹100 is not reported; only
  // the parties that reach the floor emit their per-row findings and feed the
  // totals, the s.271C exposure and the clause 21(b) rows.
  const shortTotalByDeductee = new Map<string, number>();
  for (const s of shortStage) {
    shortTotalByDeductee.set(s.key, round2((shortTotalByDeductee.get(s.key) ?? 0) + s.amount));
  }
  for (const s of shortStage) {
    if ((shortTotalByDeductee.get(s.key) ?? 0) < SHORT_DEDUCTION_MIN) continue;
    shortDeducted += s.amount;
    const shortId = push("tds_short_deducted", "critical", s.party, s.section, s.amount, s.detail);
    if (s.row) {
      clause21b.push({
        party: s.party, date: s.row.date, voucherNumber: s.row.voucherNumber,
        gross: s.row.gross, tdsDone: s.row.tdsDone, tdsDeposited: s.row.tdsDeposited,
        depositDate: s.row.depositDate,
        section: s.section, reason: "short_deducted",
        liability: s.row.liability, findingId: shortId,
        deductionDate: s.row.deductionDate ?? null,
      });
    }
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
    clause21b,
    consolidations,
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

