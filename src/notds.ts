/**
 * No TDS Disallowance.xlsm (clause 21(b)) — presentation law: the form id,
 * the four sheet tab names, Winman's TDSSECTION dropdown spellings and the
 * per-sheet row-2 key routing. Values are transcribed verbatim from the
 * workbook's INTER ranges (§2.2 of docs/design/2026-09-24-no-tds-disallowance-design.md).
 * No law rates live here — see src/tds-law.ts for the law table.
 */

import { canonicalKey } from "./key.js";
import type { Clause21bBookRow } from "./tds.js";

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
  gross: number;            // expense the 21(b) sheet reports (engine row's gross)
  tdsDone: number;          // deduction tax, 0 when none
  tdsDeposited: number;     // deposit tax, 0 when none
  depositDate: string | null;
  section: string;          // law key
  liability: number;        // engine figure, review prose only
  findingId: string;        // the review finding id this row maps to (`TDS-<nnn>-<n>`)
  pan: string | null;       // real PAN in-session; written to disk; NEVER outbound
  panFromGstin: boolean;
}

/**
 * The clause 21(b) books projection: the engine's own clause 21(b) row facts
 * (`Clause21bBookRow` — collected at exactly the raise points where the
 * review's not_deducted / short / not_deposited findings fire) projected to
 * the candidate rows the four sheets are filled from, one candidate per
 * engine row and so one per review finding (2026-09-26 007: the sheets map
 * 1:1 to the review). There is no second scan and no re-derived predicate: a
 * booking is a candidate only because the engine itself wrote one.
 *
 * The one collapse left is within a single booking: the engine can raise a
 * short-deducted row AND a not-deposited row for the same booking (a
 * deduction taken, found short, and never deposited). They share a key, and
 * the not-deposited row's facts (deposited 0) are the stricter, so the short
 * arm is dropped. Two DISTINCT bookings that happen to share a key (same
 * party, date, voucher and section — two expense lines on one voucher) are
 * never merged: their finding ids (and so their rows) are distinct.
 * Pure: no I/O, no vault, no masking.
 */
export function booksCandidates(
  rows: readonly Clause21bBookRow[],
  panOf: (party: string) => string | null,
  panDerivedFromGstinOf: (party: string) => boolean,
): NoTdsCandidateRow[] {
  const out: NoTdsCandidateRow[] = [];
  // Keys already represented by a not-deposited row, and the index of a
  // pending short arm still removable if a not-deposited sibling arrives.
  const notDepositedKeys = new Set<string>();
  const shortIndexOfKey = new Map<string, number>();
  for (const r of rows) {
    const key = `${canonicalKey(r.party)}|${r.date}|${r.voucherNumber}|${r.section}`;
    const cand: NoTdsCandidateRow = {
      key,
      party: r.party,
      date: r.date,
      voucherNumber: r.voucherNumber,
      gross: r.gross,
      tdsDone: r.tdsDone,
      tdsDeposited: r.tdsDeposited,
      depositDate: r.depositDate,
      section: r.section,
      liability: r.liability,
      findingId: r.findingId,
      pan: panOf(r.party),
      panFromGstin: panDerivedFromGstinOf(r.party),
    };
    if (r.reason === "not_deposited") {
      // A not-deposited row supersedes the same booking's short arm.
      const pending = shortIndexOfKey.get(key);
      if (pending !== undefined && !notDepositedKeys.has(key)) {
        out[pending] = cand;
        shortIndexOfKey.delete(key);
      } else {
        out.push(cand);
      }
      notDepositedKeys.add(key);
    } else if (r.reason === "short_deducted") {
      // A short arm arriving after its booking's not-deposited sibling is
      // dropped (the not-deposited facts win); otherwise it waits in case the
      // sibling arrives later.
      if (!notDepositedKeys.has(key)) {
        shortIndexOfKey.set(key, out.length);
        out.push(cand);
      }
    } else {
      out.push(cand);
    }
  }
  return out;
}

/**
 * The final clause 21(b) row the four sheets are filled from and the written
 * workbook carries — the merged, de-duplicated result of the books candidates
 * and the operator decisions/manual additions. A no-TDS-review cache row:
 * real names and real PAN in-session and on the operator's disk, never in any
 * outbound payload. `amount` is the expense the workbook states (the engine's
 * undeducted portion for a short/not_deducted row, the payment base for a
 * not_deposited row, or the operator's amount override), `tdsDone`/
 * `tdsDeposited` the deduction/deposit facts, `section` the Winman TDSSECTION
 * spelling (null only on the levy and salary sheets, which take no section).
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
