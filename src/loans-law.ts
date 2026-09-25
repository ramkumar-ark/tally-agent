/**
 * Loan law table for Form 3CD clauses 31 (l.269SS / l.269T) and 269ST,
 * FY 2025-26. Style precedent: src/pf-esi-law.ts.
 *
 * Limits:
 * - l.269SS / l.269T: no accepting or repaying any loan/deposit/specified sum
 *   of Rs. 20,000 or more otherwise than by an account-payee cheque/DD/ECS.
 *   Receipt penalty: s.271D; repayment penalty: s.271E.
 * - l.269ST: no receiving Rs. 2,00,000 or more in the aggregate in respect of
 *   a loan (or a instalment thereof) — receipted in cash disobedience is
 *   penalised s.271DA.
 *
 * The mode tokens are the byte-exact INTER strings used by the clause-31
 * worksheet vocabulary (receipt side = RECEIPT_MODES, repayment/journal side =
 * NONAC_MODES). They are punctuation-heavy; never retype them — paste or diff
 * against this file.
 */

export const LOANS_LIMIT = 20_000; // s.269SS / s.269T
export const S269ST_LIMIT = 2_00_000; // s.269ST

export const RECEIPT_MODES = [
  "A/c payee Cheque",
  "A/c payee DD",
  "ECS",
  "Credit card",
  "Debit card",
  "Net Banking",
  "IMPS",
  "UPI",
  "RTGS",
  "NEFT",
  "BHIM",
  "Non-A/c payee modes",
  "Other A/c payee modes:",
] as const;

export const NONAC_MODES = [
  "Cash",
  "Cheque (Not a/c payee)",
  "DD (Not a/c payee)",
  "Transfer of asset",
  "Transfer of liability",
  "Conversion of assets",
  "Conversion of liabilities",
  "Journal entry",
  "Others:",
] as const;

export type ReceiptMode = (typeof RECEIPT_MODES)[number];
export type NonAcMode = (typeof NONAC_MODES)[number];

/**
 * Narration hints used when a journal-mode movement must be given the benefit
 * of the doubt for its bank channel. First match wins, in this order.
 */
export const NARRATION_MODE_HINTS: { re: RegExp; mode: ReceiptMode }[] = [
  { re: /\brtgs\b/i, mode: "RTGS" },
  { re: /\bneft\b/i, mode: "NEFT" },
  { re: /\bimps\b/i, mode: "IMPS" },
  { re: /\bupi\b/i, mode: "UPI" },
];

/** C4: default F-token for bank-mode movements without a narration hint. */
export const DEFAULT_BANK_MODE: ReceiptMode = "ECS";

export interface LawConfirmPoint {
  id: string;
  point: string;
  defaultApplied: string;
}

/**
 * The §4 confirm table of the loans 269SS/T/ST design (design of record),
 * inlined. Each entry records the operator-confirmed position and the default
 * applied in its place when the position is an information gap.
 */
export const CONFIRM_POINTS: LawConfirmPoint[] = [
  {
    id: "C1",
    point:
      "The clause-31 workbook shape is authoritative for the clause-31 fill; the mode lettering is cosmetic",
    defaultApplied:
      "Workbook columns and tokens drive the fill as-is; post-23/2025 notified statutory tables are not machine-fetchable and are not fetched",
  },
  {
    id: "C2",
    point:
      "‘Specified sums’ (sheet 2) scope: books cannot reliably immutably identify advances or receivables",
    defaultApplied:
      "Sheet 2 is operator-fill only; the books emit advisories for it, never figures",
  },
  {
    id: "C3",
    point: "Journal-mode movements are not auto-breaches",
    defaultApplied:
      "A journal-mode movement earns a loans_mode_unknown advisory plus the operator mapping template; it is never auto-breach",
  },
  {
    id: "C4",
    point: "Bank-mode movements without a narration hint still need a mode token",
    defaultApplied:
      "The default F-token ECS is applied when the narration carries no mode hint",
  },
  {
    id: "C5",
    point:
      "Bearer versus account-payee character of a cheque/DD is unknowable from the books",
    defaultApplied:
      "Sheets 4/5 rows come only from operator-template declarations; the books never invent one",
  },
  {
    id: "C6",
    point:
      "Bank-party loans (the Bank OD A/c subtree etc.) are 269SS/T-exempt counterparties",
    defaultApplied: "Such counterparties are excluded from findings altogether",
  },
  {
    id: "C7",
    point:
      "MAXAMOUNT/SQUAREDUP movement-only offline; the opening balance may be unknowable offline",
    defaultApplied:
      "The loans_max_amount_estimated advisory is emitted when the opening balance is unknowable; live runs may source the opening balance from tally_trial_balance instead",
  },
  {
    id: "C8",
    point:
      "269ST aggregation beyond same-day-same-party is operator-declared",
    defaultApplied:
      "The books scan is the same-day-same-party aggregate only; anything wider waits on operator declaration",
  },
];
