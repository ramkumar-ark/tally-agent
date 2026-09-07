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

export type Side = "Dr" | "Cr";

/** Semantic role of a group, used by the checks. Distinct from mask policy. */
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
