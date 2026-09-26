/**
 * TCS law table, FY 2025-26 only (s.206C, Income-tax Act, 1961 — the 2025 Act's
 * s.394 re-enactment runs from FY 2026-27). Mirrors src/pf-esi-law.ts's
 * C-marker convention: all 13 natures stay pending captain confirmation until
 * the Winman import (V4). Rates are fractions (0.01 = 1%).
 * Values verified against the official TCS pages at incometaxindia.gov.in,
 * s.206C text on India Code and Rule 37CA/31AA on 2026-09-24; the confirm
 * markers stay PENDING regardless (Posting Date V4 confirm gate).
 */
export interface TcsNature { key: string; winman: string; rate: number; threshold: number; authority: string; confirm?: string }

const C = "CONFIRM with captain before V4 import (FY 25-26 rate/threshold)";

export const TCS_NATURES: readonly TcsNature[] = [
  { key: "liquor", winman: "Liquor", rate: 0.01, threshold: 0, authority: "s.206C(1)(i)", confirm: C },
  { key: "minerals", winman: "Minerals-coal/lignite/iron ore", rate: 0.01, threshold: 0, authority: "s.206C(1)(vii)", confirm: C },
  { key: "mining-lease", winman: "Mining & Quarrying Lease", rate: 0.02, threshold: 0, authority: "s.206C(1C)(iii)", confirm: C },
  { key: "motor-vehicle", winman: "Motor vehicle", rate: 0.01, threshold: 1000000, authority: "s.206C(1F)(i) (per-transaction ₹10L)", confirm: C },
  { key: "overseas-tour", winman: "Overseas Tour package", rate: 0.05, threshold: 0, authority: "s.206C(1G)(b); flat 5% until 30-Sep-2025, 20% on the amount in excess of ₹10L from 01-Oct-2025 (Taxation Laws (Amendment) Act, 2025)", confirm: C },
  { key: "parking-lease", winman: "Parking Lot Lease", rate: 0.02, threshold: 0, authority: "s.206C(1C)(i)", confirm: C },
  { key: "lrs", winman: "Remittance under LRS", rate: 0.05, threshold: 1000000, authority: "s.206C(1G)(a); 20% on the excess of ₹10L for purposes other than education/medical from 01-Oct-2025; nil for education loan under s.80E", confirm: C },
  { key: "notified-goods", winman: "Sale of Notified goods u/s 206C(1F)(ii)", rate: 0.01, threshold: 1000000, authority: "s.206C(1F)(ii); 10 notified goods w.e.f. 22-Apr-2025 (Notification No. 36/2025); per-item ₹10L", confirm: C },
  { key: "scrap", winman: "Scrap", rate: 0.01, threshold: 0, authority: "s.206C(1)(vi)", confirm: C },
  { key: "tendu", winman: "Tendu leaves", rate: 0.05, threshold: 0, authority: "s.206C(1)(ii)", confirm: C },
  { key: "timber-lease", winman: "Timber or other forest product(except tendu leaves)-Forest Lease", rate: 0.02, threshold: 0, authority: "s.206C(1)(iii)", confirm: C },
  { key: "timber-others", winman: "Timber-Others", rate: 0.02, threshold: 0, authority: "s.206C(1)(iv)", confirm: C },
  { key: "toll-plaza", winman: "Toll Plaza Lease", rate: 0.02, threshold: 0, authority: "s.206C(1C)(ii)", confirm: C },
];

export function tcsNatureByWinman(name: string): TcsNature | null {
  return TCS_NATURES.find((n) => n.winman === name) ?? null;
}

function ymd(y: number, m: number, d: number): string { return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`; }

/** s.206C(3) deposit due: 7th of the following month (Rule 37CA(2)); March→30 Apr; December→7 Jan (Rule 30 mirror). */
export function tcsDepositDue(collectionDate: string): string {
  const y = Number(collectionDate.slice(0, 4)), m = Number(collectionDate.slice(4, 6));
  if (m === 3) return ymd(y, 4, 30);
  if (m === 12) return ymd(y + 1, 1, 7);
  return ymd(y, m + 1, 7);
}

/** 27EQ due dates (Rule 31AA quarters, FY 25-26). */
export function tcsStatementDue(quarter: "Q1" | "Q2" | "Q3" | "Q4", _fy: "FY 25-26"): string {
  const due: Record<"Q1" | "Q2" | "Q3" | "Q4", string> = { Q1: "20250731", Q2: "20251031", Q3: "20260131", Q4: "20260531" };
  return due[quarter];
}

export const TCS_INTEREST = { lateCollection: 0.01, lateDeposit: 0.015, authority: "s.206C(7)", confirm: "CONFIRM: 1% p.m. late collection, 1.5% p.m. late deposit, month convention" };

export const TCS_CONFIRM_POINTS: readonly string[] = [C, TCS_INTEREST.confirm, "tcsDepositDue March/December specials mirror TDS Rule 30 — CONFIRM for 206C(3)"];
