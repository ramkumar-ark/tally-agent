import type { VoucherEntry, VoucherRow } from "./downstream.js";
import { displayDate, money } from "./format.js";
import { canonicalKey } from "./key.js";
import { dueDate, dueDateIsSunday, lawFor } from "./pf-esi-law.js";
import type { FundKey } from "./pf-esi-law.js";
import type { OperatorChallan, OperatorPfEsi } from "./pf-esi-file.js";
import { findingId, type CheckId, type Finding } from "./types.js";

/**
 * The books side of Form 3CD clause 20(b): find the PF/ESI payable ledgers and
 * extract the employees'-share contribution credits out of the day book.
 * Design of record: docs/design/2026-09-23-winman-3cd-pf-esi-design.md §3.
 *
 * The sign convention is project-wide: downstream of the gateway positive =
 * debit (R-MCP-5), so an employee contribution — a credit to a fund payable —
 * is NEGATIVE. This predicate tests `amount < 0` and never re-flips; the single
 * flip lives at the gateway boundary (`src/downstream.ts`).
 */

/** How the books know a ledger's group and the root of its ancestry. */
export interface BooksContext {
  groupOf: (ledger: string) => string;
  rootOf: (ledger: string) => string;
}

/** The fund payable ledgers, each list in ledger-master order. */
export interface FundLedgers {
  pf: string[];
  esi: string[];
}

/** One employees'-share contribution credit, with its wage month. */
export interface FundEvent {
  fund: FundKey;
  wageMonth: string;
  date: string;
  voucherNumber: string;
  ledger: string;
  amount: number;
}

/** A fund payable must sit under a liability root — this is what excludes a fixed asset whose name merely matches. */
const isLiabilityRoot = (root: string): boolean => /liabilit/i.test(root);
const isExpenseRoot = (root: string): boolean => /expense/i.test(root);

const PF_NAME = /\b(epf|pf|provident)\b/i;
const ESI_NAME = /\bes\s?i\b|employees'? state insurance/i;
/** The employer's contribution is clause 26 (s.43B), never clause 20(b). */
const NOT_FUND = /employer|contribution/i;
const SALARY_NAME = /salar|wages|staff cost/i;
const EMPLOYER_NAME = /employer/i;
const CONTRIBUTION_NAME = /contribution/i;

const monthOf = (date: string): string => `${date.slice(0, 4)}-${date.slice(4, 6)}`;

/**
 * Discover the fund payable ledgers from the ledger masters. A ledger is a
 * fund payable when its root is a liability root, its name matches the fund's
 * name pattern, and it is not the employer/contribution expense side.
 * Operator overrides (`config/overrides.json`'s `pfEsiLedgers`) replace the
 * heuristic wholesale for the fund they name. An empty list is returned for a
 * fund that matches nothing: a company with no ESI registration is legitimate,
 * and the caller decides whether that is an error.
 */
export function findFundLedgers(
  ledgers: Array<{ name: string; parent: string }>,
  ctx: BooksContext,
  overrides?: Partial<FundLedgers>,
): FundLedgers {
  const pf: string[] = [];
  const esi: string[] = [];
  for (const { name } of ledgers) {
    if (!name) continue;
    if (!isLiabilityRoot(ctx.rootOf(name))) continue;
    if (NOT_FUND.test(name)) continue;
    if (PF_NAME.test(name)) pf.push(name);
    else if (ESI_NAME.test(name)) esi.push(name);
  }
  return { pf: overrides?.pf ?? pf, esi: overrides?.esi ?? esi };
}

/**
 * Walk the day book for credits to the fund payable ledgers. Each voucher is
 * classified by its other entries: a debit to a salary/wages ledger under an
 * expense root is the employees'-share contribution; a debit to an employer
 * contribution ledger is an employer accrual (clause 26, skipped); neither is
 * a `pf_esi_unclassified_contribution` finding, never a silent drop.
 */
export function employeeEvents(
  vouchers: VoucherRow[],
  funds: FundLedgers,
  ctx: BooksContext,
): { events: FundEvent[]; findings: Finding[] } {
  const fundByKey = new Map<string, FundKey>();
  for (const l of funds.pf) fundByKey.set(canonicalKey(l), "PF");
  for (const l of funds.esi) fundByKey.set(canonicalKey(l), "ESI");

  const events: FundEvent[] = [];
  const findings: Finding[] = [];
  let unclassified = 0;

  for (const v of vouchers) {
    if (!v || v.cancelled) continue;
    const entries = Array.isArray(v.entries)
      ? v.entries.filter(
          (e): e is VoucherEntry =>
            !!e && typeof e === "object" && typeof (e as VoucherEntry).amount === "number",
        )
      : [];
    const date = String(v.date ?? "");
    const voucherNumber = String(v.voucherNumber ?? "");

    for (const entry of entries) {
      const fund = fundByKey.get(canonicalKey(entry.ledger));
      if (!fund || !(entry.amount < 0)) continue;
      const others = entries.filter((e) => e !== entry);

      if (
        others.some(
          (e) =>
            e.amount > 0 &&
            SALARY_NAME.test(e.ledger) &&
            isExpenseRoot(ctx.rootOf(e.ledger)),
        )
      ) {
        events.push({
          fund,
          wageMonth: monthOf(date),
          date,
          voucherNumber,
          ledger: entry.ledger,
          amount: Math.abs(entry.amount),
        });
        continue;
      }
      if (
        others.some(
          (e) =>
            e.amount > 0 &&
            EMPLOYER_NAME.test(e.ledger) &&
            CONTRIBUTION_NAME.test(e.ledger),
        )
      ) {
        continue;
      }

      unclassified += 1;
      const amount = Math.abs(entry.amount);
      findings.push({
        id: findingId("pf_esi_unclassified_contribution", unclassified),
        check: "pf_esi_unclassified_contribution",
        severity: "warning",
        ledger: entry.ledger,
        group: ctx.groupOf(entry.ledger),
        amount,
        side: null,
        expected: null,
        detail: `a credit of ${money(amount)} on ${displayDate(date)} to ${entry.ledger} could not be classified as an employees' contribution: the voucher carries no salary or wages debit and is not an employer accrual. Review it manually.`,
      });
    }
  }
  return { events, findings };
}

/**
 * One clause 20(b) row: the books' collected employees'-share contribution for
 * a fund and wage month, joined to the operator's challan. `dueDate` is the
 * strict 15th (C1 — a Sunday is an advisory, the date is never moved); C4 puts
 * the March wage month (next-FY due date) in this FY.
 */
export interface Clause20bRow {
  fund: FundKey;
  wageMonth: string;
  amountCollected: number;
  dueDate: string;
  amountPaid: number | null;
  paidOn: string | null;
  delayDays: number | null;
  disallowed: boolean;
}

/**
 * Clause 20(b) join: books-side collected amounts vs the operator's challans,
 * one row per fund per wage month (C5). A deposit after the strict due date is
 * a permanent disallowance under s.36(1)(va). An orphan challan — one whose
 * wage month the books never collected for — is reported but never invents a
 * row (Review Focus #3, both directions). Details quote a ledger's whole name
 * only, with `money()` figures and `displayDate()` dates.
 */
export function clause20b(
  events: FundEvent[],
  operator: OperatorPfEsi,
): { rows: Clause20bRow[]; findings: Finding[] } {
  const byFundMonth = new Map<string, FundEvent[]>();
  for (const ev of events) {
    const key = `${ev.fund}|${ev.wageMonth}`;
    const bucket = byFundMonth.get(key);
    if (bucket) bucket.push(ev);
    else byFundMonth.set(key, [ev]);
  }

  const findings: Finding[] = [];
  const counters: Record<string, number> = {};
  const ordinal = (check: CheckId): number => (counters[check] = (counters[check] ?? 0) + 1);
  const rows: Clause20bRow[] = [];

  const keys = [...byFundMonth.keys()].sort();
  const usedChallans = new Set<OperatorChallan>();

  for (const key of keys) {
    const [fund, wageMonth] = key.split("|") as [FundKey, string];
    const bucket = byFundMonth.get(key) ?? [];
    const amountCollected = bucket.reduce((s, e) => s + e.amount, 0);
    const due = dueDate(wageMonth);
    const ledger = bucket[0]?.ledger ?? lawFor(fund).label;

    const challan =
      operator.challans.find((c) => c.fund === fund && c.wageMonth === wageMonth) ?? null;
    if (challan) usedChallans.add(challan);

    const paidOn = challan?.paidOn ?? null;
    const amountPaid = challan?.amountPaid ?? null;
    const late = paidOn !== null && paidOn > due;
    const delayDays = paidOn !== null ? Math.max(0, dayDiff(paidOn, due)) : null;

    rows.push({ fund, wageMonth, amountCollected, dueDate: due, amountPaid, paidOn, delayDays, disallowed: late });

    if (late) {
      findings.push({
        id: findingId("pf_esi_late_deposit", ordinal("pf_esi_late_deposit")),
        check: "pf_esi_late_deposit",
        severity: "critical",
        ledger,
        group: "",
        amount: amountCollected,
        side: null,
        expected: null,
        detail: `${ledger}: the employees' contribution of ${money(amountCollected)} for the ${fund} wage month ${wageMonth} was due on ${displayDate(due)} but paid on ${displayDate(paidOn)} — a delay of ${delayDays} day(s). Disallowed under s.36(1)(va) (Checkmate Services P. Ltd. v. CIT-1, 2022 INSC 1069).`,
      });
    }
    if (!challan) {
      findings.push({
        id: findingId("pf_esi_challan_missing", ordinal("pf_esi_challan_missing")),
        check: "pf_esi_challan_missing",
        severity: "warning",
        ledger,
        group: "",
        amount: amountCollected,
        side: null,
        expected: null,
        detail: `${ledger}: the books show ${money(amountCollected)} collected for ${fund}, wage month ${wageMonth}, due ${displayDate(due)}, but the operator workpaper has no challan for that month — the matching challan is missing.`,
      });
    } else if (Math.abs(challan.amountPaid - amountCollected) > 0.009) {
      findings.push({
        id: findingId("pf_esi_amount_mismatch", ordinal("pf_esi_amount_mismatch")),
        check: "pf_esi_amount_mismatch",
        severity: "warning",
        ledger,
        group: "",
        amount: amountCollected,
        side: null,
        expected: null,
        detail: `${ledger}: for ${fund}, wage month ${wageMonth}, the books show ${money(amountCollected)} collected while the challan (sheet "${challan.sheet}", row ${challan.row}) shows ${money(challan.amountPaid)} paid — the two do not agree.`,
      });
    }

    if (dueDateIsSunday(due)) {
      findings.push({
        id: findingId("pf_esi_due_date_not_working_day", ordinal("pf_esi_due_date_not_working_day")),
        check: "pf_esi_due_date_not_working_day",
        severity: "review",
        ledger,
        group: "",
        amount: amountCollected,
        side: null,
        expected: null,
        detail: `${ledger}: the ${fund} due date ${displayDate(due)} (wage month ${wageMonth}) falls on a Sunday. Advisory only (C1): the statutory due date is never moved.`,
      });
    }
  }

  for (const c of operator.challans) {
    if (usedChallans.has(c)) continue;
    findings.push({
      id: findingId("pf_esi_challan_unmatched", ordinal("pf_esi_challan_unmatched")),
      check: "pf_esi_challan_unmatched",
      severity: "warning",
      ledger: lawFor(c.fund).label,
      group: "",
      amount: c.amountPaid,
      side: null,
      expected: null,
      detail: `${lawFor(c.fund).label}: the operator workpaper has a challan (sheet "${c.sheet}", row ${c.row}) of ${money(c.amountPaid)} paid on ${displayDate(c.paidOn)} for wage month ${c.wageMonth}, but the books show no employees' contribution collected for that fund and month. No clause 20(b) row was invented for it.`,
    });
  }

  return { rows, findings };
}

/** Calendar-day difference paidOn − dueDateYmd (both YYYYMMDD), clamped at 0. */
function dayDiff(paidOn: string, dueDateYmd: string): number {
  const d = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return Math.round((d(paidOn) - d(dueDateYmd)) / 86_400_000);
}
