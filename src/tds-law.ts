/**
 * The TDS law table, FY 2025-26 only (captain's final word): the 1961 Act
 * figures with their confirm markers. Sources per row:
 * - 194C: s.194C text (Indian Kanoon 2022 consolidation — thresholds stale,
 *   morphology only); FB 2025 memo Cl.51–62. Thresholds C1 (secondary).
 * - 194J: FB 2025 memo Cl.51–62.
 * - 194-I: s.194-I text (rates, FA 2009); FB 2025 memo (threshold).
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
  confirm?: string;
}

export const TDS_SECTIONS: readonly TdsLawEntry[] = [
  {
    section: "194C",
    label: "contract work",
    rates: { standard: 0.02, noPan: 0.2, pan4thChar: { P: 0.01, H: 0.01, C: 0.02, F: 0.02 } },
    threshold: { single: 30000, aggregate: 100000 },
    wholeYearOnCross: true,
    confirm: "C1: threshold figures (30000/100000) are secondary; confirm",
  },
  {
    section: "194J",
    label: "professional / technical fees",
    rates: { standard: 0.1, noPan: 0.2, pan4thChar: { P: 0.1, H: 0.1, C: 0.02, F: 0.02 } },
    threshold: { aggregate: 50000 },
    wholeYearOnCross: true,
  },
  {
    section: "194-I",
    label: "rent",
    rates: { standard: 0.1, noPan: 0.2, pan4thChar: { P: 0.1, H: 0.1, C: 0.02, F: 0.02 } },
    threshold: { perMonth: 50000 },
    wholeYearOnCross: true,
  },
  {
    section: "194A",
    label: "interest other than on securities",
    rates: { standard: 0.1, noPan: 0.2 },
    threshold: { aggregate: 10000 },
    wholeYearOnCross: true,
    confirm: "C2: 10% is the rates-in-force figure; confirm",
  },
  {
    section: "194H",
    label: "commission / brokerage",
    rates: { standard: 0.02, noPan: 0.2 },
    threshold: { aggregate: 20000 },
    wholeYearOnCross: true,
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

/** Rule 30(2)–(3): 7th of the following month; March deductions due 30 April. */
export function depositDue(deduction: string): string {
  const y = yearOf(deduction);
  const m = monthOf(deduction);
  return m === 12 ? mkDate(y, 1, 7, 1) : m === 3 ? `${y}0430` : mkDate(y, m, 7, 1);
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

/** s.201(1A) interest = rate x months x amount; pending C5, round100 applies the
 * Rule 119A(c) ₹100 treatment to sub-₹100 figures (the review page's ₹225 worked
 * example is the authority for exact figures). */
export function interestOn(rate: number, months: number, amount: number, round100: boolean): number {
  const raw = rate * months * amount;
  return round100 && raw > 0 && raw < 100 ? 100 : raw;
}

/** s.234E fee: 200 per day of default; the caller applies the quarter's-TDS cap. */
export function lateFeePerDay(amount: number): number {
  return amount > 0 ? 200 : 0;
}
