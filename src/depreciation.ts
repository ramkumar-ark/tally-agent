import type { LedgerVoucherRow } from "./downstream.js";
import type { CreditKind, DepOperatorFile } from "./depreciation-file.js";
import { isActRate } from "./depreciation-law.js";

/**
 * Everything the engine needs from the world, as closures. There is NO Tally
 * call anywhere in this module: the statutory arithmetic is testable against
 * worked examples with nothing live in the loop, which is the point — the
 * Act's rules are what must be right, and they do not change when Tally does.
 */
export interface DepCtx {
  fromDate: string;   // YYYYMMDD
  toDate: string;     // YYYYMMDD
  operator: DepOperatorFile;
  /** The ledger's immediate group name, e.g. "Block 15%". */
  groupOf(ledger: string): string;
  /** The root of the ledger's ancestry, e.g. "Indirect Expenses". */
  groupRootOf(ledger: string): string;
  isAssetLedger(ledger: string): boolean;
  openingWdv(block: string): { amount: number; source: "operator" | "book-seed" };
  bookOpening(ledger: string): number;
  bookClosing(ledger: string): number;
  additionalDepreciationEligible(ledger: string): boolean;
}

const canon = (s: string): string => s.trim().toLowerCase();
const isCredit = (row: LedgerVoucherRow): boolean => row.amount < 0;

const EXPENSE_ROOTS = new Set(["indirect expenses", "direct expenses", "expenses (indirect)", "expenses (direct)"]);
const INCOME_ROOTS = new Set(["indirect incomes", "direct incomes", "income (indirect)", "income (direct)", "sales accounts"]);
const MONEY_ROOTS = new Set(["bank accounts", "bank od a/c", "cash-in-hand", "sundry debtors"]);
const SUPPLIER_ROOTS = new Set(["sundry creditors", "current liabilities"]);

const DEPRECIATION_NAME = /deprecia/i;
const DISCOUNT_NAME = /discount|rebate/i;
const WRITEOFF_NAME = /loss on (sale|disposal)|writ(e|ten).?off|discard|scrap/i;

/**
 * The block rate, read from the GROUP name only. Never from a ledger name:
 * a live company has asset ledgers whose names end in "- 18%" and "- 28 %",
 * and those are GST rates on the purchase invoice (design §7 rule 2).
 */
export function parseRateFromGroup(groupName: string): number | null {
  const m = /(\d{1,2}(?:\.\d+)?)\s*%/.exec(groupName);
  if (!m) return null;
  const rate = Number(m[1]);
  return Number.isFinite(rate) ? rate : null;
}

export function resolveRate(
  ledger: string, ctx: DepCtx,
): { rate: number | null; source: "group" | "operator" | "none" } {
  const override = ctx.operator.rateOverrides.find((o) => canon(o.ledger) === canon(ledger));
  if (override) return { rate: override.rate, source: "operator" };
  const rate = parseRateFromGroup(ctx.groupOf(ledger));
  return rate === null ? { rate: null, source: "none" } : { rate, source: "group" };
}

/** True when the parsed rate is one Appendix I actually has (check 4). */
export function rateIsInAct(rate: number): boolean {
  return isActRate(rate);
}

/**
 * Two tiers only: resolved, or unresolved. No confidence score and no
 * threshold to tune (design §8). A rule fires only on its primary signal —
 * the counter ledger resolved through the group classifier. `counterparty` is
 * Tally's Particulars DISPLAY column, not a structural field, so where it is
 * unhelpful the row is flagged rather than guessed.
 */
export function classifyCredit(
  ledger: string, row: LedgerVoucherRow, ctx: DepCtx,
): { kind: CreditKind | null; rule: string; missing: string } {
  if (!isCredit(row)) return { kind: null, rule: "", missing: "not a credit" };

  const manual = ctx.operator.creditClassifications.find(
    (c) => canon(c.ledger) === canon(ledger) && c.date === row.date
      && Math.abs(Math.abs(c.amount) - Math.abs(row.amount)) < 0.005,
  );
  if (manual) return { kind: manual.kind, rule: "operator", missing: "" };

  const other = row.counterparty.trim();
  if (!other) {
    return { kind: null, rule: "", missing: "the counter ledger is absent from the row" };
  }
  const root = canon(ctx.groupRootOf(other));
  if (!root) {
    return { kind: null, rule: "", missing: "the counter ledger resolves to no known group" };
  }

  if (EXPENSE_ROOTS.has(root) && DEPRECIATION_NAME.test(other)) {
    return { kind: "depreciation", rule: "C1", missing: "" };
  }
  if (SUPPLIER_ROOTS.has(root)) return { kind: "discount", rule: "C2a", missing: "" };
  if (INCOME_ROOTS.has(root) && DISCOUNT_NAME.test(other)) {
    return { kind: "discount", rule: "C2b", missing: "" };
  }
  if (ctx.isAssetLedger(other)) return { kind: "transfer", rule: "C5", missing: "" };
  if (EXPENSE_ROOTS.has(root) && WRITEOFF_NAME.test(other)) {
    return { kind: "writeoff", rule: "C4", missing: "" };
  }
  if (INCOME_ROOTS.has(root) || MONEY_ROOTS.has(root)) {
    return { kind: "sale", rule: "C3", missing: "" };
  }
  return { kind: null, rule: "", missing: "no rule matched the counter ledger's group" };
}
