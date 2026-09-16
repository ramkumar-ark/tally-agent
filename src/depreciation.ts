import type { LedgerVoucherRow } from "./downstream.js";
import type { CreditKind, DepOperatorFile } from "./depreciation-file.js";
import { ADDITIONAL_DEPRECIATION_RATE, isActRate, isShortPeriod } from "./depreciation-law.js";

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

export const NETTING_WINDOW_DAYS = 30;
export const NEW_ACQUISITION_GAP_DAYS = 90;

export interface Acquisition {
  ledger: string;
  /** Proxy for the statutory put-to-use date: the earliest debit's date (D8). */
  firstUse: string;
  cost: number;
  counterparty: string;
  debits: LedgerVoucherRow[];
  /** Purchase discount netted against this acquisition. */
  netted: number;
}

const at = (ymd: string): number =>
  Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
const daysBetween = (a: string, b: string): number => Math.abs(at(a) - at(b)) / 86400000;

/**
 * Group an asset ledger's debits into acquisitions. A later instalment paid
 * from a BANK is cost of an asset already in use, not a new asset — verified
 * against live books, where treating each debit separately disagreed with a
 * correctly-kept ledger (design §10).
 */
export function groupAcquisitions(
  ledger: string, rows: LedgerVoucherRow[], ctx: DepCtx,
): Acquisition[] {
  const debits = rows.filter((r) => r.amount > 0).slice().sort((a, b) => a.date.localeCompare(b.date));
  const out: Acquisition[] = [];
  const hasOpening = Math.abs(ctx.bookOpening(ledger)) >= 0.005;

  for (const row of debits) {
    const root = canon(ctx.groupRootOf(row.counterparty));
    const fromSupplier = SUPPLIER_ROOTS.has(root) || /^purc/i.test(row.voucherType);

    const sameParty = out.find(
      (a) => canon(a.counterparty) === canon(row.counterparty)
        && daysBetween(a.firstUse, row.date) <= NEW_ACQUISITION_GAP_DAYS,
    );

    if (fromSupplier && !sameParty) {
      out.push({ ledger, firstUse: row.date, cost: row.amount, counterparty: row.counterparty, debits: [row], netted: 0 });
      continue;
    }
    const target = sameParty ?? out[out.length - 1];
    if (target) {
      target.cost += row.amount;
      target.debits.push(row);
      continue;
    }
    // Nothing open to attach to.
    if (hasOpening) continue;                       // cost of an asset already in use
    out.push({ ledger, firstUse: row.date, cost: row.amount, counterparty: row.counterparty, debits: [row], netted: 0 });
  }
  return out;
}

/**
 * Net purchase discounts against acquisitions: same ledger, same counterparty,
 * within 30 days, nearest acquisition first and capped at its remaining cost.
 * A discount that ties to nothing is returned unattributed — it is excluded
 * and flagged, never assumed against an opening written-down value (§11).
 */
export function netDiscounts(
  acquisitions: Acquisition[],
  discounts: Array<{ row: LedgerVoucherRow }>,
  _ctx: DepCtx,
): { netted: Acquisition[]; unattributed: LedgerVoucherRow[] } {
  const netted = acquisitions.map((a) => ({ ...a }));
  const unattributed: LedgerVoucherRow[] = [];

  for (const { row } of discounts.slice().sort((a, b) => a.row.date.localeCompare(b.row.date))) {
    let remaining = Math.abs(row.amount);
    const candidates = netted
      .map((a, i) => ({ a, i, gap: daysBetween(a.firstUse, row.date) }))
      .filter((c) => canon(c.a.counterparty) === canon(row.counterparty) && c.gap <= NETTING_WINDOW_DAYS)
      .sort((x, y) => x.gap - y.gap || x.i - y.i);

    for (const c of candidates) {
      if (remaining <= 0.005) break;
      const room = c.a.cost - c.a.netted;
      const take = Math.min(room, remaining);
      if (take <= 0) continue;
      c.a.netted += take;
      remaining -= take;
    }
    if (remaining > 0.005) unattributed.push(row);
  }
  return { netted, unattributed };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BlockInput {
  block: string;
  rate: number;
  openingWdv: number;
  acquisitions: Acquisition[];
  /** Moneys payable on assets sold, discarded, demolished or destroyed. */
  deductions: number;
  anyAssetLeft: boolean;
  carryForwardAdditional: number;
}

export interface BlockResult {
  block: string; rate: number; openingWdv: number;
  additionsFull: number; additionsHalf: number; deductions: number;
  wdvBeforeDep: number;
  normalDepreciation: number; additionalDepreciation: number; totalDepreciation: number;
  closingWdv: number;
  shortTermGain: number; shortTermLoss: number;
  status: "ok" | "extinguished" | "nil-floor";
}

export function computeBlock(input: BlockInput, ctx: DepCtx): BlockResult {
  const net = (a: Acquisition) => Math.max(0, a.cost - a.netted);
  let additionsFull = 0;
  let additionsHalf = 0;
  let additional = input.carryForwardAdditional;

  for (const a of input.acquisitions) {
    const amount = net(a);
    const short = isShortPeriod(a.firstUse, ctx.toDate);
    if (short) additionsHalf += amount;
    else additionsFull += amount;
    if (ctx.additionalDepreciationEligible(a.ledger)) {
      additional += (amount * ADDITIONAL_DEPRECIATION_RATE) / 100 / (short ? 2 : 1);
    }
  }

  const gross = input.openingWdv + additionsFull + additionsHalf;
  const wdvBeforeDep = gross - input.deductions;

  // s.50, limb one: moneys payable exceeded the block.
  if (wdvBeforeDep < -0.005) {
    return {
      block: input.block, rate: input.rate, openingWdv: input.openingWdv,
      additionsFull: round2(additionsFull), additionsHalf: round2(additionsHalf),
      deductions: round2(input.deductions), wdvBeforeDep: 0,
      normalDepreciation: 0, additionalDepreciation: 0, totalDepreciation: 0,
      closingWdv: 0, shortTermGain: round2(-wdvBeforeDep), shortTermLoss: 0,
      status: "nil-floor",
    };
  }

  // s.50, limb two: value remains but the block holds no asset.
  if (!input.anyAssetLeft) {
    return {
      block: input.block, rate: input.rate, openingWdv: input.openingWdv,
      additionsFull: round2(additionsFull), additionsHalf: round2(additionsHalf),
      deductions: round2(input.deductions), wdvBeforeDep: round2(wdvBeforeDep),
      normalDepreciation: 0, additionalDepreciation: 0, totalDepreciation: 0,
      closingWdv: 0, shortTermGain: 0, shortTermLoss: round2(wdvBeforeDep),
      status: "extinguished",
    };
  }

  // Deductions are taken off opening WDV first, then full-rate additions,
  // then half-rate additions. Order matters only in the band where the
  // deductions reach down into the additions pools: this ordering rates the
  // surviving pool cheaper to depreciate, which is taxpayer-conservative.
  // The half-rate rule attaches to each asset, so the workbook's allocation
  // is where a per-asset split is shown (see design §15).
  let remaining = input.deductions;
  const takeFrom = (pool: number): number => {
    const take = Math.min(pool, remaining);
    remaining -= take;
    return pool - take;
  };
  const openLeft = takeFrom(input.openingWdv);
  const fullLeft = takeFrom(additionsFull);
  const halfLeft = takeFrom(additionsHalf);

  const normal = (openLeft + fullLeft) * (input.rate / 100) + halfLeft * (input.rate / 200);
  const total = normal + additional;

  return {
    block: input.block, rate: input.rate, openingWdv: round2(input.openingWdv),
    additionsFull: round2(additionsFull), additionsHalf: round2(additionsHalf),
    deductions: round2(input.deductions), wdvBeforeDep: round2(wdvBeforeDep),
    normalDepreciation: round2(normal), additionalDepreciation: round2(additional),
    totalDepreciation: round2(total), closingWdv: round2(wdvBeforeDep - total),
    shortTermGain: 0, shortTermLoss: 0, status: "ok",
  };
}
