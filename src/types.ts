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
 * `tax_id` and `doc` are vault-label-only roles (TaxId N / Doc N aliases); the classifier never returns them. */
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
  | "doc"
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
  | "tds_threshold_crossed"
  | "tds_daybook_month_empty" | "tds_daybook_rows_rejected" | "tds_daybook_unverified"
  | "tds_daybook_ledger_unmastered";

/** TDS ids live in their own ordinal space (TDS-<ordinal>-<n>); other tables are never renumbered. */
export const TDS_CHECK_ORDINAL: Record<TdsCheckId, number> = {
  tds_not_deducted: 1, tds_short_deducted: 2, tds_late_deducted: 3,
  tds_not_deposited: 4, tds_late_deposit: 5, tds_statement_late: 6,
  tds_statement_missing: 7, tds_deposit_mismatch: 8, tds_exposure_40a_ia: 9,
  tds_exposure_271c: 10, tds_section_unknown: 11, tds_master_gap: 12,
  tds_threshold_crossed: 13,
  tds_daybook_month_empty: 14, tds_daybook_rows_rejected: 15, tds_daybook_unverified: 16,
  tds_daybook_ledger_unmastered: 17,
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

export type DepCheckId =
  | "dep_block_rate_unresolved" | "dep_asset_ledger_outside_block"
  | "dep_opening_wdv_unverified" | "dep_rate_not_in_act"
  | "dep_credit_unclassified" | "dep_discount_unattributed"
  | "dep_disposal_outside_block" | "dep_book_charge_missing"
  | "dep_book_charge_differs" | "dep_block_charge_differs"
  | "dep_book_charge_unreconciled" | "dep_charge_predates_acquisition"
  | "dep_block_extinguished" | "dep_block_wdv_nil"
  | "dep_additional_depreciation_unclaimed";

/** Ordinal used to build stable finding ids. Never renumber. */
export const DEP_CHECK_ORDINAL: Record<DepCheckId, number> = {
  dep_block_rate_unresolved: 1, dep_asset_ledger_outside_block: 2,
  dep_opening_wdv_unverified: 3, dep_rate_not_in_act: 4,
  dep_credit_unclassified: 5, dep_discount_unattributed: 6,
  dep_disposal_outside_block: 7, dep_book_charge_missing: 8,
  dep_book_charge_differs: 9, dep_block_charge_differs: 10,
  dep_book_charge_unreconciled: 11, dep_charge_predates_acquisition: 12,
  dep_block_extinguished: 13, dep_block_wdv_nil: 14,
  dep_additional_depreciation_unclaimed: 15,
};

export function depFindingId(check: DepCheckId, ordinal: number): string {
  return `DEP-${String(DEP_CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}

export type FaCheckId =
  | "fa_vehicle_incidental_expensed"
  | "fa_vehicle_incidental_missing"
  | "fa_vehicle_vendor_unsettled"
  | "fa_disposal_unmatched";

/** FA ids live in their own ordinal space (FA-<ordinal>-<n>); other tables are never renumbered. */
export const FA_CHECK_ORDINAL: Record<FaCheckId, number> = {
  fa_vehicle_incidental_expensed: 1,
  fa_vehicle_incidental_missing: 2,
  fa_vehicle_vendor_unsettled: 3,
  fa_disposal_unmatched: 4,
};

export function faFindingId(check: FaCheckId, ordinal: number): string {
  return `FA-${String(FA_CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}

export interface FaFinding {
  id: string;
  check: FaCheckId;
  severity: Severity;
  /** Real ledger name pre-mask: the vehicle ledger, the vendor, or the signal ledger. */
  ledger: string;
  block: string;
  amount: number;
  /** money()/displayDate() only — never toFixed(2), never a raw YYYYMMDD. */
  detail: string;
}

export interface DepFinding {
  id: string;
  check: DepCheckId;
  severity: Severity;
  /** Real ledger name pre-mask; "" for a block-level finding. */
  ledger: string;
  /** The block group name, or "" where none resolved. */
  block: string;
  amount: number;
  /** money()/displayDate() only — never toFixed(2), never a raw YYYYMMDD. */
  detail: string;
}

/** Act-vs-books differences below this are rounding, not findings. */
export const DEP_TOLERANCE = 1.0;
