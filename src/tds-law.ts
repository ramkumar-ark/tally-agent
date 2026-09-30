/**
 * The TDS law table, FY 2025-26 only (captain's final word): the 1961 Act
 * figures with their confirm markers. Sources per row:
 * - 194C: s.194C text (Indian Kanoon 2022 consolidation — thresholds stale,
 *   morphology only); FB 2025 memo Cl.51–62. Thresholds C1 (secondary).
 * - 194J: FB 2025 memo Cl.51–62.
 * - 194-I: s.194-I text (rates, FA 2009); Captain instruction 2026-09-26 (Addendum 26m):
 *   FY aggregate ₹6,00,000 per party per year, no per-month test. Captain instruction
 *   2026-09-30: no deduction while the party's cumulative FY bookings are within that
 *   aggregate; the crossing booking carries the cumulative to date (`cumulativeOnCross`).
 *   Captain instruction 2026-09-30 (second half): that annual-cumulative reading is the
 *   rule for EVERY annual-aggregate section, so `cumulativeOnCross` is set on 194C, 194J,
 *   194A and 194H as well — 194Q and 194T excepted, as the captain stated.
 * - 194A: s.194A text; FB 2025 memo. Rate confirm C2 ("rates in force").
 * - 194H: F(No.2)B 2024 memo Cl.57.
 * - 194Q: s.194Q text; only the amount after crossing (captain's C8).
 * - 194T: F(No.2)B 2024 memo Cl.62; timing-only.
 * - 206AA: s.206AA text. 206AB omitted from 1 Apr 2025 (FB 2025) — no check.
 * Confirm markers (C1–C8) recorded in full in
 * docs/design/2026-09-14-tds-compliance-review-design.md §6.
 */

export interface TdsLawEntry {
  section: string;
  label: string;
  rates: { standard: number; noPan?: number; pan4thChar?: Record<string, number> };
  threshold: { single?: number; aggregate?: number; perMonth?: number };
  wholeYearOnCross: boolean;
  /**
   * Annual aggregate, liability at the crossing (194-I(a) / 194-I(b),
   * captain instruction 2026-09-30). A booking is not liable while the
   * party's cumulative FY bookings for the section are within the aggregate;
   * the booking AT WHICH the cumulative crosses carries the whole cumulative
   * to date (earlier bookings included) and every later booking carries its
   * own full gross. The section's year-total tax is therefore unchanged — the
   * rule only stops the pre-crossing bookings being reported on their own.
   * A party that never crosses is never liable and raises nothing.
   * The captain's instruction of 2026-09-30 is SECTION-NEUTRAL: it applies to
   * EVERY section whose threshold is an annual aggregate — 194C, 194-I(a),
   * 194-I(b), 194J, 194A and 194H all carry this flag. A per-bill `single`
   * limit is tested independently and still makes a single large booking
   * liable on its own whatever the aggregate has done (194C's ₹30,000). 194Q
   * deliberately keeps its own "only the amount beyond the crossing" rule, and
   * 194T is timing-only and never rate-recomputed.
   */
  cumulativeOnCross?: boolean;
  /**
   * Timing-only (194T, design of record table L163): the section is
   * deposit/interest-monitored, never rate-recomputed. Its deductee is a
   * partner's Capital Account, not a declared vendor party, so the engine
   * observes the duty credits and their deposits and never raises
   * not-deducted / short-deduction / threshold findings for it
   * (2026-09-26o item 035).
   */
  timingOnly?: boolean;
  confirm?: string;
}

export const TDS_SECTIONS: readonly TdsLawEntry[] = [
  {
    section: "194C",
    label: "contract work",
    rates: { standard: 0.02, noPan: 0.2, pan4thChar: { P: 0.01, H: 0.01, C: 0.02, F: 0.02 } },
    threshold: { single: 30000, aggregate: 100000 },
    wholeYearOnCross: true,
    cumulativeOnCross: true,
    confirm: "C1: threshold figures (30000/100000) are secondary; confirm. Captain instruction 2026-09-30: the s.194C(5) aggregate limit is an annual cumulative, exactly as for 194-I — a booking before the crossing is not charged, the crossing booking carries the cumulative booked to that date, and a single bill above the per-bill limit stays liable on its own",
  },
  {
    section: "194J",
    label: "professional / technical fees",
    rates: { standard: 0.1, noPan: 0.2, pan4thChar: { P: 0.1, H: 0.1, C: 0.02, F: 0.02 } },
    threshold: { aggregate: 50000 },
    wholeYearOnCross: true,
    cumulativeOnCross: true,
  },
  {
    section: "194-I(a)",
    label: "rent — plant and machinery",
    rates: { standard: 0.02, noPan: 0.2 },
    threshold: { aggregate: 600000 },
    wholeYearOnCross: true,
    cumulativeOnCross: true,
    confirm: "Captain instruction 2026-09-26 (Addendum 26m): FY aggregate ₹6,00,000 per party per year, no per-month test",
  },
  {
    section: "194-I(b)",
    label: "rent — land and building",
    rates: { standard: 0.1, noPan: 0.2 },
    threshold: { aggregate: 600000 },
    wholeYearOnCross: true,
    cumulativeOnCross: true,
    confirm: "Captain instruction 2026-09-26 (Addendum 26m): FY aggregate ₹6,00,000 per party per year, no per-month test",
  },
  {
    section: "194A",
    label: "interest other than on securities",
    rates: { standard: 0.1, noPan: 0.2 },
    threshold: { aggregate: 10000 },
    wholeYearOnCross: true,
    cumulativeOnCross: true,
    confirm: "C2: 10% is the rates-in-force figure; confirm",
  },
  {
    section: "194H",
    label: "commission / brokerage",
    rates: { standard: 0.02, noPan: 0.2 },
    threshold: { aggregate: 20000 },
    wholeYearOnCross: true,
    cumulativeOnCross: true,
  },
  {
    section: "194Q",
    label: "purchase of goods",
    rates: { standard: 0.001, noPan: 0.05 },
    threshold: { aggregate: 5000000 },
    wholeYearOnCross: false, // C8: only the amount after crossing (captain's correction)
  },
  {
    section: "194T",
    label: "firm to partner remuneration / interest",
    rates: { standard: 0.1, noPan: 0.2 },
    threshold: { aggregate: 20000 },
    wholeYearOnCross: true,
    timingOnly: true,
  },
  {
    section: "206AA",
    label: "deductee without PAN",
    rates: { standard: 0.2 },
    threshold: {},
    wholeYearOnCross: false,
  },
];

export function lawOf(section: string): TdsLawEntry | null {
  return TDS_SECTIONS.find((s) => s.section === section) ?? null;
}

export function wholeYearOnCross(section: string): boolean {
  return lawOf(section)?.wholeYearOnCross ?? true;
}

/**
 * A timing-only section (194T, 2026-09-26o item 035) is analysed for deposit
 * timing and interest only — never for its own rate, not-deducted or threshold
 * findings.
 */
export function timingOnlySection(section: string | null): boolean {
  return section !== null && lawOf(section)?.timingOnly === true;
}

/** YYYYMMDD helpers. All law helpers take YYYYMMDD strings and return like-shaped ones. */

function yearOf(d: string): number { return Number(d.slice(0, 4)); }
function monthOf(d: string): number { return Number(d.slice(4, 6)); }
function dayOf(d: string): number { return Number(d.slice(6, 8)); }

function mkDate(y: number, m: number, day: number, monthOverflow = 0): string {
  const total = m - 1 + monthOverflow; // 0-based months
  const y2 = y + Math.floor(total / 12);
  const m2 = (total % 12) + 1;
  return `${String(y2).padStart(4, "0")}${String(m2).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/**
 * Calendar-inclusive month count (Rule 119A(b): part of a month counts as a
 * full month; TRACES method, captain Q5: C). Days 26 June → 31 July = 1.
 */
export function calendarMonths(from: string, to: string): number {
  if (to < from || to === from) return 0;
  return (yearOf(to) - yearOf(from)) * 12 + (monthOf(to) - monthOf(from)) + 1;
}

/**
 * Rule 30(2)–(3): 7th of the following month; March deductions due 30 April.
 *
 * December needs no special case: `mkDate` rolls the year itself, so
 * `mkDate(y, 12, 7, 1)` is 07-January of the NEXT year. The December branch
 * this replaces passed month 1 *with* the overflow and so produced
 * 07-February of the SAME year — a due date ten months in the past, which
 * made every December deduction read as a late deposit (28 false
 * tds_late_deposit rows on 06-Jan-2026 deposits; captain 2026-09-30).
 */
export function depositDue(deduction: string): string {
  const y = yearOf(deduction);
  const m = monthOf(deduction);
  if (m === 3) return `${y}0430`;
  return mkDate(y, m, 7, 1);
}

/** Rule 31A(1)–(2) statement due dates for FY 25-26 (24Q/26Q/27Q). */
export function statementDue(quarter: "Q1" | "Q2" | "Q3" | "Q4", fy: "FY 25-26"): string {
  if (fy !== "FY 25-26") throw new Error(`Unsupported financial year: ${fy}`);
  const y = yearOf(String(fy).slice(0, 2) ? "2025" : "2025"); // FY 25-26 fixed; the table is per-fy
  switch (quarter) {
    case "Q1": return `${y}0731`;
    case "Q2": return `${y}1031`;
    case "Q3": return `${y + 1}0131`;
    case "Q4": return `${y + 1}0531`;
  }
}

/**
 * s.139(1) return due date for FY 25-26 (audit case: 31 October 2026). A
 * deduction deposited on or before this date is "deposited in the subsequent
 * year" rather than a s.40(a)(ia) disallowance row (2026-09-26i); past it, the
 * deposit does not save the disallowance. Same per-FY pattern as
 * statementDue — extend the table, never guess, when a new FY arrives.
 */
export function s139DueDate(fy: "FY 25-26"): string {
  if (fy !== "FY 25-26") throw new Error(`Unsupported financial year: ${fy}`);
  return "20261031";
}

/** s.201(1A) interest = rate x months x amount. There is NO ₹100 minimum on
 * s.201(1A) interest (Rule 119A has no such floor for it; the earlier "pending
 * C5" round100 treatment was wrong — 2026-09-26r). Exact figures are the norm:
 * ₹1,059 x 1.5% x 4 = ₹63.54. The caller rounds for display only. */
export function interestOn(rate: number, months: number, amount: number): number {
  return rate * months * amount;
}

/** s.234E fee: 200 per day of default; the caller applies the quarter's-TDS cap. */
export function lateFeePerDay(amount: number): number {
  return amount > 0 ? 200 : 0;
}

/** Nature-of-payment text for the 3CD TDS sheet column D (free text — wording is ours). */
const NATURES: Record<string, string> = {
  "194C": "Payment to contractors / sub-contractors",
  "194J": "Professional or technical fees",
  "194-I(a)": "Rent of plant & machinery / equipment",
  "194-I(b)": "Rent of land & building / furniture",
  "194A": "Interest other than interest on securities",
  "194H": "Commission or brokerage",
  "194Q": "Purchase of goods",
  "194T": "Payment to partner (remuneration / interest / commission)",
};
export function natureOf(section: string): string { return NATURES[section] ?? ""; }

/** Law key → exact Winman dropdown string (INTER!$C$8:$C$51). Table, not string surgery. */
export const WINMAN_TDS_SECTIONS: ReadonlyMap<string, string> = new Map([
  ["194C", "194C"], ["194J", "194J"], ["194-I(a)", "194I (a)"], ["194-I(b)", "194I (b)"],
  ["194A", "194A"], ["194H", "194H"], ["194Q", "194Q"], ["194T", "194T"],
]);
export function winmanSectionOf(lawKey: string): string | null { return WINMAN_TDS_SECTIONS.get(lawKey) ?? null; }

export const WINMAN_TDS_DROPDOWN: readonly string[] = ["192","192A","193","194","194-IA","194-IB","194-IC","194-O","194A","194B","194BA","194BB","194C","194D","194DA","194E","194EE","194G","194H","194I (a)","194I (b)","194J","194K","194LA","194LB","194LBA(1)","194LBA(2)","194LBA(3)","194LBB","194LBC(1)","194LBC(2)","194LC","194M","194N","194P","194Q","194R","194S","194T","195","196A","196B","196C","196D"];
