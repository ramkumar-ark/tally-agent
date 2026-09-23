import type { LedgerVoucherRow } from "./downstream.js";
import { money, displayDate } from "./format.js";
import { calendarMonths, depositDue, interestOn, lateFeePerDay, lawOf, statementDue } from "./tds-law.js";
import type { OperatorFile } from "./tds-file.js";
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

export interface TdsLedgerRows {
  ledger: string;
  rows: LedgerVoucherRow[];
}

export interface TdsPeriod {
  fromDate: string; // YYYYMMDD
  toDate: string;   // YYYYMMDD
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
  panKeyOf(party: string): string | null;
  entityOf(party: string): "P" | "H" | "C" | "F" | null;
  deducteeTypeOf?(party: string): string;
  certificateRateOf(party: string, section: string, date: string): number | null;
  transporterDeclared(party: string): boolean;
  deducteeFiledReturn(party: string): boolean;
  asOnDate: string;
  round100: boolean;
  period: TdsPeriod;
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
}

export interface TdsDeposit {
  date: string;
  party: string;
  tax: number;
  section: string;
  deduction?: TdsDeduction;
}

export interface TdsEvents {
  bookings: TdsBooking[];
  payments: TdsPayment[];
  deductions: TdsDeduction[];
  deposits: TdsDeposit[];
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
  ctx: Pick<TdsCtx, "tdsParties" | "resolveSection" | "dutySectionOf">,
): TdsEvents {
  const tdsParties = new Set(ctx.tdsParties);
  const bookings: TdsBooking[] = [];
  const payments: TdsPayment[] = [];
  const deductions: TdsDeduction[] = [];
  const deposits: TdsDeposit[] = [];

  for (const { ledger, rows } of expenseLedgers) {
    for (const r of byDate(rows)) {
      if (isDebit(r) && tdsParties.has(r.counterparty)) {
        const res = ctx.resolveSection(ledger);
        bookings.push({
          date: r.date,
          voucherNumber: r.voucherNumber,
          party: r.counterparty,
          gross: r.amount,
          ledger,
          section: res.section,
          candidates: res.candidates,
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
  for (const { ledger, rows } of dutyLedgers) {
    const section = ctx.dutySectionOf(ledger);
    if (section === null) continue;
    for (const r of byDate(rows)) {
      const tax = Math.abs(r.amount);
      if (tax < ZERO) continue;
      if (r.amount < 0) {
        deductions.push({
          date: r.date,
          voucherNumber: r.voucherNumber,
          party: r.counterparty,
          tax,
          section,
          joinedTo: null,
        });
      } else {
        deposits.push({ date: r.date, party: r.counterparty, tax, section });
      }
    }
  }
  return { bookings, payments, deductions, deposits };
}

/**
 * Join the event streams:
 * - a duty credit joins a booking by voucherNumber equality when both
 *   periodic reports name it, else by month + counterparty within 30 days,
 *   nearest date first; a counterparty mismatch never joins;
 * - a deposit joins a duty credit by date + amount, each side consumed once.
 */
function joinEvents(events: TdsEvents): void {
  const claimed = new Set<TdsDeduction>();
  const byVoucher = new Map<string, TdsDeduction[]>();
  for (const d of events.deductions) {
    if (!d.voucherNumber) continue;
    const list = byVoucher.get(d.voucherNumber) ?? [];
    list.push(d);
    byVoucher.set(d.voucherNumber, list);
  }
  for (const b of [...events.bookings].sort((a, b) => a.date.localeCompare(b.date))) {
    let pick = byVoucher
      .get(b.voucherNumber)
      ?.find((d) => d.party === b.party && !claimed.has(d) && !d.booking);
    if (!pick) {
      pick = events.deductions
        .filter((d) => d.party === b.party && !claimed.has(d) && !d.booking)
        .filter((d) => Math.abs(dateDiffDays(d.date, b.date)) <= 30)
        .sort(
          (a, b2) =>
            Math.abs(dateDiffDays(a.date, b.date)) - Math.abs(dateDiffDays(b2.date, b.date)),
        )[0];
    }
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
      .filter((e) => e.section === d.section && !used.has(e) && !e.deduction)
      .filter((e) => Math.abs(e.tax - d.tax) <= ZERO && e.date >= d.date)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (dep) {
      used.add(dep);
      dep.deduction = d;
    }
  }
}

interface Agg {
  party: string;
  section: string;
  bookings: TdsBooking[];
  gross: number;
  crossed: boolean;
  crossDate: string;
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
): { events: TdsEvents; findings: TdsFinding[]; totals: TdsTotals } {
  const events = extractEvents(dutyLedgers, expenseLedgers, partyLedgers, ctx);
  joinEvents(events);

  // Aggregate the gross base per deductee key (PAN-else-ledger) per section.
  const aggs = new Map<string, Agg>();
  for (const b of [...events.bookings].sort((a, b) => a.date.localeCompare(b.date))) {
    if (b.section === null) continue; // unknown sections surface as their own finding
    // s.194Q is applicable by default; the operator suppresses it for the
    // whole review when the buyer did not meet the previous-year ₹10 crore
    // turnover condition. A suppressed section produces no aggregation, no
    // findings, no totals — the whole section is out, not one party's.
    if (b.section === "194Q" && ctx.operator?.section194QApplicable === false) continue;
    const key = `${ctx.panKeyOf(b.party) ?? `ledger:${b.party}`}|${b.section}`;
    const agg = aggs.get(key) ?? {
      party: b.party,
      section: b.section,
      bookings: [],
      gross: 0,
      crossed: false,
      crossDate: "",
    };
    agg.bookings.push(b);
    agg.gross += b.gross;
    aggs.set(key, agg);
  }

  const findings: TdsFinding[] = [];
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
  // Master gaps: parties without PAN, missing/Unknown deductee types, duty
  // ledgers whose section is not mapped. Review-only, never guessed.
  const noPanBookings = events.bookings.filter((b) => !ctx.panKeyOf(b.party));
  const noPanParties = [...new Set(noPanBookings.map((b) => b.party))];
  for (const party of noPanParties) {
    const gross = noPanBookings.filter((b) => b.party === party).reduce((a, b) => a + b.gross, 0);
    push(
      "tds_master_gap",
      "review",
      party,
      events.bookings.find((b) => b.party === party)?.section ?? null,
      gross,
      `no PAN recorded for the deductee (${money(gross)} gross this period): aggregation runs per ledger and the s.206AA rate is assumed.`,
    );
  }
  if (ctx.deducteeTypeOf) {
    for (const party of new Set(events.bookings.filter((b) => ctx.deducteeTypeOf!(b.party).trim() === "" || /unknown/i.test(ctx.deducteeTypeOf!(b.party))).map((b) => b.party))) {
      push(
        "tds_master_gap",
        "review",
        party,
        null,
        0,
        `the deductee type is missing or Unknown in the master: the statutory rate cannot be confirmed from the master.`,
      );
    }
  }
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
      if (liability <= TDS_TOLERANCE) continue;

      const mit194 = rate.via206AA ? " (s.206AA: no PAN on the deductee)" : "";
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
        (d) => d.booking === b && d.party === b.party && d.section === section,
      );
      if (!ded) {
        notDeducted += liability;
        push(
          "tds_not_deducted",
          "critical",
          b.party,
          section,
          liability,
          `booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${mit194}: tax of ${money(liability)} was payable, but no duty credit was found.`,
        );
        continue;
      }
      if (ded.tax < liability - TDS_TOLERANCE) {
        shortDeducted += liability - ded.tax;
        push(
          "tds_short_deducted",
          "critical",
          b.party,
          section,
          round2(liability - ded.tax),
          `duty credit of ${money(ded.tax)} on ${displayDate(ded.date)} is short of the ${money(liability)} payable on the booking of ${money(b.gross)} on ${displayDate(b.date)} under section ${section}${mit194}.`,
        );
      }
      const advance = events.payments
        .filter((p) => p.party === b.party && p.date < b.date && p.date <= ded.date)
        .map((p) => p.date)
        .sort()[0];
      const deductibleDate = advance ?? b.date;
      if (ded.date > deductibleDate) {
        const shielded = ctx.deducteeFiledReturn(b.party);
        const months = calendarMonths(deductibleDate, ded.date);
        const interest = shielded ? 0 : interestOn(0.01, months, ded.tax, ctx.round100);
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
      }
      // Deposit checks: the joined deposit was matched in joinEvents.
      const dep = events.deposits.find((e) => e.deduction === ded);
      if (dep) {
        const due = depositDue(ded.date);
        if (dep.date > due) {
          const months = calendarMonths(ded.date, dep.date);
          const ii = interestOn(0.015, months, ded.tax, ctx.round100);
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
      } else if (ded.date <= ctx.asOnDate) {
        notDepositedTax += ded.tax;
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

    if (agg.crossed) {
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
        ctx.tdsParties[0] ?? "",
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
        ctx.tdsParties[0] ?? "",
        null,
        fee,
        `statement filed on ${displayDate(latest)} after the Rule 31A due date of ${displayDate(due)}; s.234E fee of ${money(fee)};${oneMonth ? " s.271H is not levied where tax, interest and fee are paid and the statement was filed within a month;" : " s.271H penalty (10000 to 100000) may apply."}`,
        fee > 0 ? [{ kind: "fee", amount: fee, from: due, to: latest, basis: `200/day for ${days} day(s), capped at ${money(tax)}` }] : undefined,
      );
    }
  }
  // Exposures: 30% disallowance and the s.271C penalty, review-only, never payables.
  if (notDeducted > ZERO) {
    push(
      "tds_exposure_40a_ia",
      "review",
      ctx.tdsParties[0] ?? "",
      null,
      round2(notDeducted * 0.3),
      `s.40(a)(ia) exposure: 30% disallowance of ${money(round2(notDeducted * 0.3))} where TDS was not deducted; an exposure, never a payable.`,
    );
    push(
      "tds_exposure_271c",
      "review",
      ctx.tdsParties[0] ?? "",
      null,
      round2(notDeducted),
      `s.271C exposure: a penalty equal to the tax not deducted, ${money(notDeducted)}, relieved by s.273B; an exposure, never a payable.`,
    );
  }
  if (notDepositedTax > ZERO) {
    push(
      "tds_exposure_40a_ia",
      "review",
      ctx.tdsParties[0] ?? "",
      null,
      round2(notDepositedTax * 0.3),
      `s.40(a)(ia) exposure: 30% disallowance of ${money(round2(notDepositedTax * 0.3))} where tax was deducted but not deposited by the s.139(1) due date; an exposure, never a payable.`,
    );
  }

  const bySection = new Map<string, TdsSectionTotals>();
  for (const agg of aggs.values()) {
    bySection.set(agg.section, { section: agg.section, gross: agg.gross, tax: round2(rateFor(ctx, agg.party, agg.section, agg.bookings[0]?.date ?? ctx.period.fromDate).rate * agg.gross) });
  }

  return {
    events,
    findings,
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
function quarterOfDate(date: string): "Q1" | "Q2" | "Q3" | "Q4" {
  const m = Number(date.slice(4, 6));
  if (m >= 4 && m <= 6) return "Q1";
  if (m >= 7 && m <= 9) return "Q2";
  if (m >= 10) return "Q3";
  return "Q4";
}

