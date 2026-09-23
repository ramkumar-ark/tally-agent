/**
 * PF/ESI due dates for Form 3CD clause 20(b), FY 2025-26. Sources:
 * - P.F.:  Para 38 of the Employees' Provident Funds Scheme, 1952 — within 15
 *          days of the close of the wage month. The 5-day grace period was
 *          withdrawn by EPFO's circular of 08-Jan-2016, w.e.f. February 2016.
 * - E.S.I.: Regulation 31 of the ESI (General) Regulations, 1950 — within 15
 *          days of the last day of the calendar month. (21 days -> 15 days from
 *          the June 2017 contribution.)
 * A deposit after the due date is permanently disallowed under s.36(1)(va);
 * s.43B does not rescue it — Checkmate Services P. Ltd. v. CIT-1, 2022 INSC 1069.
 * Confirm markers C1-C8 are CONFIRMED by the captain on 2026-09-23; their full
 * text lives in docs/design/2026-09-23-winman-3cd-pf-esi-design.md §4 and §6.
 * The confirm-string style mirrors src/tds-law.ts: each starts with its marker.
 */
export type FundKey = "PF" | "ESI";

export interface FundLaw {
  key: FundKey;
  /** The Winman sheet this fund's rows are written to. */
  sheet: string;
  label: string;
  dueDayOfNextMonth: number;
  authority: string;
  confirm?: string;
}

export const FUND_LAW: readonly FundLaw[] = [
  {
    key: "PF", sheet: "P.F.", label: "Provident Fund", dueDayOfNextMonth: 15,
    authority: "Para 38, Employees' Provident Funds Scheme, 1952 (5-day grace withdrawn w.e.f. Feb 2016)",
    confirm: "C1: strict 15th due date; a non-working day is an advisory only, the date is never moved (CONFIRMED 2026-09-23)",
  },
  {
    key: "ESI", sheet: "E.S.I.", label: "Employees' State Insurance", dueDayOfNextMonth: 15,
    authority: "Reg. 31, Employees' State Insurance (General) Regulations, 1950 (21 days -> 15 days from the June 2017 contribution)",
    confirm: "C1: strict 15th due date; a non-working day is an advisory only, the date is never moved (CONFIRMED 2026-09-23)",
  },
];

/**
 * The captain's confirm points, carried in code so a run can print them next to
 * its findings. All eight were CONFIRMED with the operator on 2026-09-23 (the
 * confirmed outcome is folded into each line). C1-C6 are the law table's;
 * C7-C8 are the books-side assumptions the review makes. Full text: design doc
 * §4 and §6.
 */
export const CONFIRM_POINTS: readonly string[] = [
  "C1: strict 15th due date; a non-working day raises an advisory only, the date is never moved (CONFIRMED 2026-09-23)",
  "C2: the statutory due date applies; no standing order, award or contract of service imposes an earlier one (CONFIRMED 2026-09-23)",
  "C3: AMOUNTPAID is the employees'-share portion of the combined challan, supplied by the operator (CONFIRMED 2026-09-23)",
  "C4: the March wage month is reported in this FY with its actual next-FY payment date (CONFIRMED 2026-09-23)",
  "C5: one row per wage month, not a single annual row (CONFIRMED 2026-09-23)",
  "C6: the Other Funds sheet is out of scope (no gratuity or superannuation fund in the books) (CONFIRMED 2026-09-23)",
  "C7: the wage month is the salary journal's own month, taken from its date (CONFIRMED 2026-09-23)",
  "C8: a wage month is never deposited in two challans; a second is rejected (CONFIRMED 2026-09-23)",
];

export function lawFor(key: FundKey): FundLaw {
  const f = FUND_LAW.find((x) => x.key === key);
  if (!f) throw new Error(`no law entry for fund ${key}`);
  return f;
}

/** "2026-03" -> "20260415": the 15th of the month after the wage month. */
export function dueDate(wageMonth: string): string {
  const y = Number(wageMonth.slice(0, 4));
  const m = Number(wageMonth.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}${String(nm).padStart(2, "0")}15`;
}

/** C1: reported as an advisory; the due date itself is never moved. */
export function dueDateIsSunday(ymd: string): boolean {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))).getUTCDay() === 0;
}
