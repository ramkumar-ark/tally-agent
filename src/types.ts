export type Severity = "critical" | "warning" | "review";

export type CheckId =
  | "out_of_balance"
  | "suspense_balance"
  | "negative_cash"
  | "wrong_side_balance"
  | "overdrawn_bank"
  | "ledger_under_primary_group"
  | "dormant_balance";

/** Ordinal used to build stable finding ids. Never renumber. */
export const CHECK_ORDINAL: Record<CheckId, number> = {
  out_of_balance: 1,
  suspense_balance: 2,
  negative_cash: 3,
  wrong_side_balance: 4,
  overdrawn_bank: 5,
  ledger_under_primary_group: 6,
  dormant_balance: 7,
};

export type GstCheckId =
  | "gst_amount_mismatch"
  | "gst_return_not_in_books"
  | "gst_books_not_in_return"
  | "gst_party_without_gstin";

/** GST ids live in their own ordinal space (GST-<ordinal>-<n>); CHECK_ORDINAL is never renumbered (R-E-3). */
export const GST_CHECK_ORDINAL: Record<GstCheckId, number> = {
  gst_amount_mismatch: 1,
  gst_return_not_in_books: 2,
  gst_books_not_in_return: 3,
  gst_party_without_gstin: 4,
};

export function gstFindingId(check: GstCheckId, ordinal: number): string {
  return `GST-${String(GST_CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}

/** Portal returns round to whole rupees; books carry paise. Per head, per party. */
export const GST_TOLERANCE = 1.0;

export type GstKind = "outward" | "inward";

/** Tax heads as GSTR-3B reports them: SGST and UTGST merged. */
export type GstHead = "CGST" | "SGST/UTGST" | "IGST" | "CESS" | "GST-OTHER";

export const GST_HEADS: readonly GstHead[] = [
  "CGST",
  "SGST/UTGST",
  "IGST",
  "CESS",
  "GST-OTHER",
];

export type Side = "Dr" | "Cr";

/** Semantic role of a group, used by the checks. Distinct from mask policy.
 * `tax_id` is a vault-label-only role (TaxId N aliases); the classifier never returns it. */
export type GroupRole =
  | "debtor"
  | "creditor"
  | "bank"
  | "bank_od"
  | "cash"
  | "expense"
  | "income"
  | "stock"
  | "suspense"
  | "capital"
  | "duties"
  | "tax_id"
  | "other";

export type MaskPolicy = "mask" | "clear";

/** One trial balance row, amounts parsed. Positive = debit. */
export interface TbRow {
  name: string;
  parent: string;
  balance: number;
}

export interface GroupNode {
  name: string;
  parent: string;
}

export interface LedgerMaster {
  name: string;
  parent: string;
  openingBalance: number;
  closingBalance: number;
}

export interface Finding {
  id: string;
  check: CheckId;
  severity: Severity;
  ledger: string;
  group: string;
  amount: number;
  side: Side | null;
  expected: Side | null;
  detail: string;
}

/** Everything a check needs. Checks are pure functions of this. */
export interface ReviewInput {
  asOnDate: string;
  rows: TbRow[];
  ledgers: LedgerMaster[];
  totalDebit: number;
  totalCredit: number;
  roleOf(group: string): GroupRole;
  isPrimaryGroup(group: string): boolean;
}

export type Check = (input: ReviewInput) => Finding[];

export const ZERO_TOLERANCE = 0.005;
export const TOTALS_TOLERANCE = 0.05;

export function sideOf(balance: number): Side | null {
  if (Math.abs(balance) < ZERO_TOLERANCE) return null;
  return balance > 0 ? "Dr" : "Cr";
}

export function findingId(check: CheckId, ordinal: number): string {
  return `TB-${String(CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}
