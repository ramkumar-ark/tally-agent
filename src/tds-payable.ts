import { calendarMonths, depositDue, interestOn } from "./tds-law.js";
import type { Clause21bBookRow, TdsLiability } from "./tds.js";

/**
 * The TDS payable statement's pure core (design of record:
 * docs/design/2026-10-01-tds-payable-statement-design.md).
 *
 * Two things live here and nothing else: a **pure projector** from a cached
 * `tb_tds_review` run to the critical findings the operator must decide on, and
 * the statement computation from the Accepted ones. Like `booksCandidates` in
 * `src/notds.ts`, the projector never re-derives a liability predicate and never
 * re-runs the engine — it reads the run's own rows and joins them by id.
 *
 * The interest is the review's OWN schedule: `calendarMonths`, `depositDue` and
 * `interestOn` from `src/tds-law.ts`, at the same 1% / 1.5% rates, simply
 * re-parameterised to the payment date. There is deliberately no second
 * interest formula in this project.
 *
 * Real party names and PANs appear on these rows, so they belong on the
 * operator's disk and in the session cache only — never in a finding, an error
 * message or a tool result.
 */

/** The four characters of a PAN that decide company status, per the PAN shape. */
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** What a critical finding needs the operator to decide on it. */
export interface TdsPayableFinding {
  id: string;
  check: string;
  severity: string;
  /** null on a finding the engine raised without a section (none today). */
  section: string | null;
  /** The shortfall tax — the figure at stake on this finding. */
  amount: number;
  detail: string;
}

/**
 * One critical finding, enriched with the books facts of the clause 21(b) row
 * its raise site pushed. `party` is the real ledger name (operator disk only).
 */
export interface TdsPayableCandidate {
  findingId: string;
  check: string;
  party: string;
  /** "" when no clause 21(b) row resolved — a 194Q party-month row. */
  section: string;
  /** The booking date, YYYYMMDD; "" when no clause 21(b) row resolved. */
  date: string;
  /** The expense the shortfall sits on; 0 when unresolved. */
  amountPaid: number;
  /** The tax payable on that base before any credit; 0 when unresolved. */
  taxPayable: number;
  /** What the books actually deducted (0 when nothing was). */
  taxDeducted: number;
  deductionDate: string | null;
  depositDate: string | null;
  /** The finding's own amount. */
  shortfall: number;
  /** null = no rate could be resolved; the sheet prints it blank, never guessed. */
  rate: number | null;
  /** The review's own words for this finding (already masked and scrubbed). */
  detail: string;
}

const isYmd = (s: string): boolean => /^\d{8}$/.test(s);

/** `party|date|voucher|section` — the same key grain the 21(b) projector uses. */
const rowKey = (party: string, date: string, voucher: string, section: string): string =>
  `${party}|${date}|${voucher}|${section}`;

/**
 * The applied rate for a row: the engine's own stamped rate when a cached
 * liability matched, else the STATUTORY rate for that deductee and section
 * (the s.197 certificate, the PAN's 4th character, or the s.206AA floor when
 * the deductee has no PAN) as `analyzeTds` itself charges it, else null.
 *
 * Never the ratio the row's figures imply: `gross` is the engine's *base*,
 * which for a threshold/cumulative section is smaller than the bill, so a
 * ratio reads 10.0151% for a 10% rate — the column is the rate of deduction,
 * not an accident of the base.
 *
 * Indexed once: a linear scan per candidate over a run's liabilities is the
 * shape AGENTS.md records as a 30-minute event-blocker.
 */
function rateIndex(liabilities: readonly TdsLiability[]): {
  exact: Map<string, number>;
  loose: Map<string, number>;
} {
  const exact = new Map<string, number>();
  const loose = new Map<string, number>();
  for (const l of liabilities) {
    const key = rowKey(l.booking.party, l.booking.date, l.booking.voucherNumber, l.section);
    if (!exact.has(key)) exact.set(key, l.rate);
    // A 194Q party-month row carries no voucher number, so the engine's own
    // per-booking key can never match it: the party|date|section key is the
    // fallback for that grain.
    const lk = `${l.booking.party}|${l.booking.date}|${l.section}`;
    if (!loose.has(lk)) loose.set(lk, l.rate);
  }
  return { exact, loose };
}

/**
 * The run's critical findings, in the review's own order, each enriched with
 * the clause 21(b) row its raise site pushed (joined on the finding id).
 *
 * A critical finding with no 21(b) row still appears, with no party name and
 * the shortfall it carries — honest, never guessed, and it still has to be
 * decided on.
 */
export function payableCandidates(args: {
  findings: readonly TdsPayableFinding[];
  clause21b: readonly Clause21bBookRow[];
  liabilities: readonly TdsLiability[];
  /**
   * The statutory rate for a deductee and section, resolved by the caller over
   * the review's own context (`rateFor`: certificate, then the PAN's 4th
   * character, then the s.206AA floor when there is no PAN). Null when the
   * section is not in the law table, or when the caller resolves nothing.
   */
  statutoryRateOf?: (party: string, section: string, date: string) => number | null;
}): TdsPayableCandidate[] {
  const byId = new Map<string, Clause21bBookRow>();
  for (const r of args.clause21b) if (!byId.has(r.findingId)) byId.set(r.findingId, r);
  const rates = rateIndex(args.liabilities);
  // The engine's own rate resolution, bound by the caller to `rateFor` over
  // the review's own context. A hand-built call (a test, a future channel)
  // may omit it, and then a row with no matched liability carries no rate.
  const statutory = args.statutoryRateOf ?? (() => null);
  const out: TdsPayableCandidate[] = [];
  for (const f of args.findings) {
    if (f.severity !== "critical") continue;
    const r = byId.get(f.id);
    if (!r) {
      out.push({
        findingId: f.id, check: f.check, party: "", section: f.section ?? "", date: "",
        amountPaid: 0, taxPayable: 0, taxDeducted: 0, deductionDate: null,
        depositDate: null, shortfall: f.amount, rate: null, detail: f.detail,
      });
      continue;
    }
    // A short-deduction 21(b) row reports the UNDEDUCTED portion of the
    // expense and carries tdsDone 0 by design (the 21(b) sheet is about the
    // undeducted part). The books' actual credit is that row's own liability
    // less the finding's shortfall — an identity, not a guess.
    const deducted =
      r.tdsDone > 0
        ? r.tdsDone
        : r.reason === "short_deducted"
          ? Math.max(0, r.liability - f.amount)
          : 0;
    const rate =
      rates.exact.get(rowKey(r.party, r.date, r.voucherNumber, r.section)) ??
      rates.loose.get(`${r.party}|${r.date}|${r.section}`) ??
      statutory(r.party, r.section, r.date);
    out.push({
      findingId: f.id,
      check: f.check,
      party: r.party,
      section: r.section,
      date: r.date,
      amountPaid: r.gross,
      taxPayable: r.liability,
      taxDeducted: deducted,
      deductionDate: r.deductionDate ?? null,
      depositDate: r.depositDate,
      shortfall: f.amount,
      rate,
      detail: f.detail,
    });
  }
  return out;
}

/** Company status read off the PAN's 4th character, exactly as the review reads it. */
export type PayablePartyKind = "Company" | "Non-company" | "Not determinable (no PAN)";

/**
 * `C` in the PAN's 4th position is a company. A PAN that is absent, or that
 * does not carry the PAN shape, is **never guessed** — it is reported as not
 * determinable, which the summary keeps as its own bucket so the split still
 * reconciles to the totals.
 */
export function partyKindOf(pan: string | null | undefined): PayablePartyKind {
  const p = (pan ?? "").trim().toUpperCase();
  if (!PAN_SHAPE.test(p)) return "Not determinable (no PAN)";
  return p[3] === "C" ? "Company" : "Non-company";
}

/** One line of the payable statement — one Accepted critical finding. */
export interface TdsPayableStatementRow {
  findingId: string;
  date: string;
  party: string;
  pan: string | null;
  /** True when the PAN came from the GSTIN, never a master PAN. */
  panFromGstin: boolean;
  partyKind: PayablePartyKind;
  section: string;
  amountPaid: number;
  taxPayable: number;
  taxDeducted: number;
  deductionDate: string | null;
  rate: number | null;
  shortfall: number;
  interestI: number;
  interestII: number;
  /** s.201(1A) interest due to the payment date — the two legs summed. */
  interest: number;
  depositDueDate: string;
}

export interface TdsPayableTotals {
  amountPaid: number;
  taxPayable: number;
  taxDeducted: number;
  shortfall: number;
  interestI: number;
  interestII: number;
  interest: number;
  /** shortfall + interest — what the challan carries. */
  payable: number;
}

export interface TdsPayableStatement {
  paymentDate: string;
  rows: TdsPayableStatementRow[];
  totals: TdsPayableTotals;
  bySection: Array<{ section: string; rows: number; totals: TdsPayableTotals }>;
  byPartyKind: Array<{ kind: PayablePartyKind; rows: number; totals: TdsPayableTotals }>;
  accepted: number;
  rejected: number;
}

export type PayableDecision = "Accept" | "Reject" | null;

const emptyTotals = (): TdsPayableTotals => ({
  amountPaid: 0, taxPayable: 0, taxDeducted: 0, shortfall: 0,
  interestI: 0, interestII: 0, interest: 0, payable: 0,
});

const round2 = (n: number): number => Math.round(n * 100) / 100;

const addTotals = (t: TdsPayableTotals, r: TdsPayableStatementRow): TdsPayableTotals => ({
  amountPaid: round2(t.amountPaid + r.amountPaid),
  taxPayable: round2(t.taxPayable + r.taxPayable),
  taxDeducted: round2(t.taxDeducted + r.taxDeducted),
  shortfall: round2(t.shortfall + r.shortfall),
  interestI: round2(t.interestI + r.interestI),
  interestII: round2(t.interestII + r.interestII),
  interest: round2(t.interest + r.interest),
  payable: round2(t.payable + r.shortfall + r.interest),
});

/**
 * The critical findings that are still open: a blank Decision is not
 * finalized, and neither is a finding whose row the operator deleted from the
 * sheet (a deleted row is not a decision).
 */
export function openFindings(
  candidates: readonly TdsPayableCandidate[],
  decisions: ReadonlyMap<string, PayableDecision>,
): TdsPayableCandidate[] {
  return candidates.filter((c) => {
    const d = decisions.get(c.findingId);
    return d !== "Accept" && d !== "Reject";
  });
}

/**
 * One Accepted finding as a statement row, with the s.201(1A) interest the
 * existing schedule gives, measured to the payment date:
 *
 * - a `not_deposited` finding's tax WAS deducted and was not deposited, so the
 *   late-deposit leg runs from its deduction date to the payment date (the
 *   Rule 30 due date only decides whether leg (ii) is charged at all), and the
 *   late-deduction leg runs when the credit postdates the booking;
 * - an undeducted or short-deducted shortfall is deemed deducted when the
 *   challan is paid, so its late-deposit leg is zero by construction and its
 *   deposit-due date is the Rule 30 date after the payment.
 */
export function statementRow(args: {
  candidate: TdsPayableCandidate;
  paymentDate: string;
  pan: string | null;
  panFromGstin: boolean;
}): TdsPayableStatementRow {
  const { candidate: c, paymentDate, pan } = args;
  const shortfall = round2(c.shortfall);
  const deemed = c.check !== "tds_not_deposited";
  // The date the credit is treated as made: the books' own deduction date for
  // a not-deposited row, and the payment date itself for a shortfall that was
  // never deducted at all.
  const creditDate = deemed ? paymentDate : c.deductionDate ?? c.date;
  // The Rule 30 due date of the ORIGINAL deduction or booking — 7th of the
  // next month, 30-Apr for a March deduction. Never the payment date's: a
  // shortfall that was never deducted is due on the booking's own Rule 30
  // date, and showing the date after the payment would tell the operator
  // nothing about when the liability arose.
  const depositDueDate = depositDue(deemed ? c.date : creditDate);
  const interestI = deemed
    ? interestOn(0.01, calendarMonths(c.date, paymentDate), shortfall)
    : creditDate > c.date
      ? interestOn(0.01, calendarMonths(c.date, creditDate), shortfall)
      : 0;
  // Leg (ii) is measured from the DEDUCTION date to the payment date, exactly
  // as `analyzeTds` and the 3CD interest schedule measure it; the Rule 30 due
  // date is the trigger for charging at all, never the start of the clock.
  const interestII = deemed || paymentDate <= depositDueDate
    ? 0
    : interestOn(0.015, calendarMonths(creditDate, paymentDate), shortfall);
  const interest = round2(interestI + interestII);
  return {
    findingId: c.findingId,
    date: c.date,
    party: c.party,
    pan,
    panFromGstin: args.panFromGstin,
    partyKind: partyKindOf(pan),
    section: c.section,
    amountPaid: round2(c.amountPaid),
    taxPayable: round2(c.taxPayable),
    taxDeducted: round2(c.taxDeducted),
    deductionDate: creditDate,
    rate: c.rate,
    shortfall,
    interestI: round2(interestI),
    interestII: round2(interestII),
    interest,
    depositDueDate,
  };
}

/**
 * The payable statement for one payment date. Refuses while any critical
 * finding is undecided, naming the open ones: an undecided row is not a
 * decision, and a statement that silently dropped it would understate the
 * challan.
 */
export function buildStatement(args: {
  candidates: readonly TdsPayableCandidate[];
  decisions: ReadonlyMap<string, PayableDecision>;
  paymentDate: string;
  panOf: (party: string) => string | null;
  panDerivedFromGstinOf: (party: string) => boolean;
}): TdsPayableStatement {
  const { candidates, decisions, paymentDate } = args;
  if (!isYmd(paymentDate)) {
    throw new Error("payment date must be written YYYYMMDD");
  }
  if (candidates.length === 0) {
    throw new Error("this review has no critical findings: there is nothing to pay");
  }
  const open = openFindings(candidates, decisions);
  if (open.length > 0) {
    throw new Error(
      `${open.length} of ${candidates.length} critical findings are not decided yet — ` +
        `set Accept or Reject on every row of the decisions workbook: ${open
          .map((c) => `${c.findingId}${c.section ? ` ${c.section}` : ""}`)
          .join(", ")}`,
    );
  }
  const rows: TdsPayableStatementRow[] = candidates
    .filter((c) => decisions.get(c.findingId) === "Accept")
    .map((c) =>
      statementRow({
        candidate: c,
        paymentDate,
        pan: c.party ? args.panOf(c.party) : null,
        panFromGstin: c.party ? args.panDerivedFromGstinOf(c.party) : false,
      }),
    );
  const totals = rows.reduce(addTotals, emptyTotals());
  const group = <K extends string>(
    key: (r: TdsPayableStatementRow) => K,
  ): Array<{ kind: K; rows: number; totals: TdsPayableTotals }> => {
    const map = new Map<K, TdsPayableStatementRow[]>();
    for (const r of rows) {
      const k = key(r);
      const list = map.get(k);
      if (list) list.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()]
      .map(([k, list]) => ({
        kind: k,
        rows: list.length,
        totals: list.reduce(addTotals, emptyTotals()),
      }))
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  };
  return {
    paymentDate,
    rows,
    totals,
    bySection: group((r) => r.section).map((g) => ({
      section: g.kind,
      rows: g.rows,
      totals: g.totals,
    })),
    byPartyKind: group((r) => r.partyKind).map((g) => ({
      kind: g.kind,
      rows: g.rows,
      totals: g.totals,
    })),
    accepted: rows.length,
    rejected: candidates.filter((c) => decisions.get(c.findingId) === "Reject").length,
  };
}