/**
 * No TDS Disallowance.xlsm (clause 21(b)) — presentation law: the form id,
 * the four sheet tab names, Winman's TDSSECTION dropdown spellings and the
 * per-sheet row-2 key routing. Values are transcribed verbatim from the
 * workbook's INTER ranges (§2.2 of docs/design/2026-09-24-no-tds-disallowance-design.md).
 * No law rates live here — see src/tds-law.ts for the law table.
 */

import { canonicalKey } from "./key.js";
import {
  TDS_TOLERANCE,
  type TdsDeposit,
  type TdsDeduction,
  type TdsEvents,
  type TdsLiability,
} from "./tds.js";
import { depositDue } from "./tds-law.js";

export const NOTDS_FORM_ID = "3cdNoTDS";

export type NotdsSheetKey =
  | "40(a)(ia) to resident"
  | "40(a)(i) to non-resident"
  | "40(a)(ib) - Equalisation Levy"
  | "40(a)(iii)";

export const RESIDENT_SECTIONS: readonly string[] = [
  "192",
  "193",
  "194",
  "194-IA",
  "194-IB",
  "194-IC",
  "194-O",
  "194A",
  "194B",
  "194BA",
  "194BB",
  "194C",
  "194D",
  "194DA",
  "194EE",
  "194G",
  "194H",
  "194I (a)",
  "194I (b)",
  "194J",
  "194K",
  "194LA",
  "194LBA",
  "194LBB",
  "194LBC",
  "194M",
  "194N",
  "194P",
  "194Q",
  "194R",
  "194S",
  "194T",
];

export const NR_SECTIONS: readonly string[] = [
  "194BA",
  "194E",
  "194LB",
  "194LBA",
  "194LBA(3)",
  "194LBB",
  "194LBC",
  "194LC",
  "194N",
  "194Q",
  "194T",
  "195",
  "196A",
  "196B",
  "196C",
  "196D",
];

const RESIDENT_SET = new Set(RESIDENT_SECTIONS);
const NR_SET = new Set(NR_SECTIONS);

const LAW_TO_WINMAN = new Map<string, string>([
  ["194-I(a)", "194I (a)"],
  ["194-I(b)", "194I (b)"],
]);

export function winmanSectionOf(lawKey: string): string {
  const mapped = LAW_TO_WINMAN.get(lawKey);
  if (mapped !== undefined) return mapped;
  if (!RESIDENT_SET.has(lawKey) && !NR_SET.has(lawKey)) {
    throw new Error(`not a Winman 3CD No-TDS section key: ${JSON.stringify(lawKey)}`);
  }
  return lawKey;
}

export function isResidentSectionSpelling(s: string): boolean {
  return RESIDENT_SET.has(s);
}

export function isNrSectionSpelling(s: string): boolean {
  return NR_SET.has(s);
}

export function doneKeyOf(sheet: NotdsSheetKey): "TDSDONE" | "LEVYDEDUCTED" | undefined {
  return sheet === "40(a)(ib) - Equalisation Levy" ? "LEVYDEDUCTED" : sheet === "40(a)(iii)" ? undefined : "TDSDONE";
}

export function depositedKeyOf(sheet: NotdsSheetKey): "TDSDEPOSITED" | "LEVYDEPOSITED" | undefined {
  return sheet === "40(a)(ib) - Equalisation Levy" ? "LEVYDEPOSITED" : sheet === "40(a)(iii)" ? undefined : "TDSDEPOSITED";
}

export function amountKeyOf(sheet: NotdsSheetKey): "EXPENSEAMOUNT" | "AMOUNT" {
  return sheet === "40(a)(iii)" ? "AMOUNT" : "EXPENSEAMOUNT";
}

export interface NoTdsCandidateRow {
  key: string;              // `${canonicalKey(party)}|${date}|${voucherNumber}|${section}` — stable template↔parse join
  party: string;            // real name, unmasked; session + disk only
  date: string;             // YYYYMMDD (booking date)
  voucherNumber: string;    // auditor trace, never written to the workbook
  gross: number;            // full payment (C13 default)
  tdsDone: number;          // deduction tax, 0 when none
  tdsDeposited: number;     // deposit tax, 0 when none
  depositDate: string | null;
  section: string;          // law key
  liability: number;        // engine figure, review prose only
  pan: string | null;       // real PAN in-session; written to disk; NEVER outbound
  panFromGstin: boolean;
}

/**
 * The clause 21(b) books projection: the engine's per-booking liability facts
 * (`TdsLiability`, never re-derived here) projected to the candidate rows the
 * four sheets are filled from. A booking is a candidate when it carries a
 * liability beyond `TDS_TOLERANCE` and either nothing was deducted, the
 * deduction fell short of the liability beyond tolerance, or no deposit
 * joined it by the Rule 30 deposit due date (`depositDue` — the same
 * lateness the engine's `tds_late_deposit` finding measures). A deposit that
 * joined but arrived after that date still supplies the row's deposit facts;
 * whether it nevertheless cures the disallowance under the s.139(1) provisos
 * is the operator's call, not the engine's. Compliant deducted-and-deposited
 * rows are not candidates. Pure: no I/O, no vault, no masking.
 */
export function booksCandidates(
  events: TdsEvents,
  liabilities: readonly TdsLiability[],
  panOf: (party: string) => string | null,
  panDerivedFromGstinOf: (party: string) => boolean,
): NoTdsCandidateRow[] {
  // Deposit facts are indexed once by the deduction object reference (the
  // Global Constraints perf rule — no per-candidate find): joinEvents joins
  // at most one deposit per deduction, so the first deposit carrying a
  // `.deduction` back-reference wins.
  const depositByDeduction = new Map<TdsDeduction, TdsDeposit>();
  for (const dep of events.deposits) {
    if (dep.deduction && !depositByDeduction.has(dep.deduction)) {
      depositByDeduction.set(dep.deduction, dep);
    }
  }

  const rows: NoTdsCandidateRow[] = [];
  for (const l of liabilities) {
    if (l.liability <= TDS_TOLERANCE) continue; // the engine filters these too; kept as the predicate's first arm
    const ded = l.deduction;
    const dep = ded === null ? undefined : depositByDeduction.get(ded);
    const depositedOnTime = ded !== null && dep !== undefined && dep.date <= depositDue(ded.date);
    const shortDeducted = ded !== null && ded.tax < l.liability - TDS_TOLERANCE;
    // Candidate arms: no deduction OR short deduction OR no deposit joined in
    // time. Compliant (deducted within tolerance and deposited on time) falls
    // through as the only exclusion.
    if (ded !== null && !shortDeducted && depositedOnTime) continue;
    rows.push({
      key: `${canonicalKey(l.booking.party)}|${l.booking.date}|${l.booking.voucherNumber}|${l.section}`,
      party: l.booking.party,
      date: l.booking.date,
      voucherNumber: l.booking.voucherNumber,
      gross: l.booking.gross,
      tdsDone: ded?.tax ?? 0,
      tdsDeposited: dep?.tax ?? 0,
      depositDate: dep?.date ?? null,
      section: l.section,
      liability: l.liability,
      pan: panOf(l.booking.party),
      panFromGstin: panDerivedFromGstinOf(l.booking.party),
    });
  }
  return rows;
}

/**
 * The final clause 21(b) row the four sheets are filled from and the written
 * workbook carries — the merged, de-duplicated result of the books candidates
 * and the operator decisions/manual additions. A no-TDS-review cache row:
 * real names and real PAN in-session and on the operator's disk, never in any
 * outbound payload. `amount` is the payment the workbook states (C13: the
 * full payment, or the operator's amount override), `tdsDone`/`tdsDeposited`
 * the deduction/deposit facts, `section` the Winman TDSSECTION spelling
 * (null only on the levy and salary sheets, which take no section).
 */
export interface NoTdsRow {
  sheet: NotdsSheetKey;
  party: string;          // real name, unmasked; session + disk only
  date: string;           // YYYYMMDD
  amount: number;         // payment amount the workbook states (override honoured)
  tdsDone: number;        // tax/levy deducted, 0 when none
  tdsDeposited: number;   // tax/levy deposited, 0 when none
  section: string | null; // Winman spelling
  nature: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin: string | null;
  country: string | null;
  pan: string | null;     // real PAN/Aadhaar; NEVER outbound
}
