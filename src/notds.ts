/**
 * No TDS Disallowance.xlsm (clause 21(b)) — presentation law: the form id,
 * the four sheet tab names, Winman's TDSSECTION dropdown spellings and the
 * per-sheet row-2 key routing. Values are transcribed verbatim from the
 * workbook's INTER ranges (§2.2 of docs/design/2026-09-24-no-tds-disallowance-design.md).
 * No law rates live here — see src/tds-law.ts for the law table.
 */

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
