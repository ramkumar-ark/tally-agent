export type Severity = "critical" | "warning" | "review";

export type CheckId =
  | "out_of_balance"
  | "suspense_balance"
  | "negative_cash"
  | "wrong_side_balance"
  | "overdrawn_bank"
  | "ledger_under_primary_group"
  | "dormant_balance"
  | "ledger_in_wrong_group";

/** Ordinal used to build stable finding ids. Never renumber. */
export const CHECK_ORDINAL: Record<CheckId, number> = {
  out_of_balance: 1,
  suspense_balance: 2,
  negative_cash: 3,
  wrong_side_balance: 4,
  overdrawn_bank: 5,
  ledger_under_primary_group: 6,
  dormant_balance: 7,
  ledger_in_wrong_group: 8,
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

/** What a Tally primary group makes its ledgers: which statement, and which side of it. */
export type GroupNature = "capital" | "liability" | "asset" | "income" | "expense";

/** What a ledger's name suggests it is. Read in code by src/checks/nameSignal.ts, never by the model. */
export type NameSignal = "expense" | "income" | "party" | "bank" | "capital" | "loan";

/** Operator tuning for ledger_in_wrong_group, from the "wrongGroup" key of config/overrides.json. */
export interface WrongGroupConfig {
  /** Ledgers confirmed as correctly placed. Matched by canonicalKey (case and whitespace insensitive). */
  ignoreLedgers: string[];
  /** Company-specific single words added to the built-in vocabulary; "neutral" words veto a name. */
  keywords: Partial<Record<NameSignal | "neutral", string[]>>;
}

export const EMPTY_WRONG_GROUP: WrongGroupConfig = { ignoreLedgers: [], keywords: {} };

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
  /** The expected side, or for ledger_in_wrong_group the likely nature of the ledger's proper group. */
  expected: Side | GroupNature | null;
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
  /** The group, its parent, and so on up to the top — nearest first (Classifier.ancestry). */
  ancestryOf(group: string): string[];
  wrongGroup: WrongGroupConfig;
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

export type LedgerCheckId =
  | "ls_opening_closing_mismatch"
  | "ls_wrong_side_during_period"
  | "ls_duplicate_entry"
  | "ls_duplicate_reference"
  | "ls_large_entry"
  | "ls_round_sum_journal"
  | "ls_movement_spike"
  | "ls_activity_gap"
  | "ls_unjoined_rows"
  | "ls_gst_rate_nonstandard"
  | "ls_gst_untaxed_supply";

/** Ledger scrutiny ids live in their own ordinal space (LS-<ledgerSeq>-<ordinal>-<n>). Never renumber. */
export const LEDGER_CHECK_ORDINAL: Record<LedgerCheckId, number> = {
  ls_opening_closing_mismatch: 1,
  ls_wrong_side_during_period: 2,
  ls_duplicate_entry: 3,
  ls_duplicate_reference: 4,
  ls_large_entry: 5,
  ls_round_sum_journal: 6,
  ls_movement_spike: 7,
  ls_activity_gap: 8,
  ls_unjoined_rows: 9,
  ls_gst_rate_nonstandard: 10,
  ls_gst_untaxed_supply: 11,
};

/**
 * One scrutiny run per ledger per session shares a ledgerSeq, so two ledgers'
 * findings never collide in the session's finding-id -> ledger map.
 */
export function ledgerFindingId(check: LedgerCheckId, ledgerSeq: number, ordinal: number): string {
  return `LS-${ledgerSeq}-${String(LEDGER_CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}

export type TdsCheckId =
  | "tds_not_deducted" | "tds_short_deducted" | "tds_late_deducted"
  | "tds_not_deposited" | "tds_late_deposit" | "tds_statement_late"
  | "tds_statement_missing" | "tds_deposit_mismatch" | "tds_exposure_40a_ia"
  | "tds_exposure_271c" | "tds_section_unknown" | "tds_master_gap"
  | "tds_threshold_crossed";

/** TDS ids live in their own ordinal space (TDS-<ordinal>-<n>); other tables are never renumbered. */
export const TDS_CHECK_ORDINAL: Record<TdsCheckId, number> = {
  tds_not_deducted: 1, tds_short_deducted: 2, tds_late_deducted: 3,
  tds_not_deposited: 4, tds_late_deposit: 5, tds_statement_late: 6,
  tds_statement_missing: 7, tds_deposit_mismatch: 8, tds_exposure_40a_ia: 9,
  tds_exposure_271c: 10, tds_section_unknown: 11, tds_master_gap: 12,
  tds_threshold_crossed: 13,
};

export function tdsFindingId(check: TdsCheckId, ordinal: number): string {
  return `TDS-${String(TDS_CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}

export interface TdsScheduleRow {
  kind: "i" | "ii" | "fee";
  amount: number;
  from: string;  // YYYYMMDD: deductible date / deduction date / statement due date
  to: string;    // deduction date / deposit date / filing-or-asOn date
  basis: string; // why the months/days were counted as reported
}

export interface TdsFinding {
  id: string;
  check: TdsCheckId;
  severity: Severity;
  deductee: string;   // real ledger name pre-mask
  group: string;
  section: string | null;
  amount: number;     // tax involved, positive
  detail: string;     // money()/displayDate() only
  schedule?: TdsScheduleRow[];
}
