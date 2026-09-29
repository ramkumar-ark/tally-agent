import { money, displayDate } from "./format.js";
import type { LedgerVoucherRow } from "./downstream.js";
import type { CreditKind, DepOperatorFile } from "./depreciation-file.js";
import { ADDITIONAL_DEPRECIATION_RATE, isActRate, isShortPeriod } from "./depreciation-law.js";
import {
  depFindingId, DEP_CHECK_ORDINAL, DEP_TOLERANCE, type DepCheckId, type DepFinding, type Severity,
} from "./types.js";

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

/**
 * How far the sum of the assets' own figures may sit from the block's
 * statutory total before it is called a real difference rather than rounding
 * (captain, 2026-09-30). Each asset's figure is rounded to paise, so n assets
 * can sum half a paisa each away from the block; a rupee covers a block of
 * ~200 assets with room to spare, and every genuine block-level item (a
 * carried-forward s.32(1)(iia) balance, an operator written-down value, a
 * deduction that spilled past its own asset) is orders of magnitude larger.
 */
export const ROUNDING_TOLERANCE = 1;

const isCredit = (row: LedgerVoucherRow): boolean => row.amount < 0;

export const EXPENSE_ROOTS = new Set(["indirect expenses", "direct expenses", "expenses (indirect)", "expenses (direct)"]);
export const INCOME_ROOTS = new Set(["indirect incomes", "direct incomes", "income (indirect)", "income (direct)", "sales accounts"]);
export const MONEY_ROOTS = new Set(["bank accounts", "bank od a/c", "cash-in-hand", "sundry debtors"]);
export const SUPPLIER_ROOTS = new Set(["sundry creditors", "current liabilities"]);

export const DEPRECIATION_NAME = /deprecia/i;
const DISCOUNT_NAME = /discount|rebate/i;
export const WRITEOFF_NAME = /loss on (sale|disposal)|writ(e|ten).?off|discard|scrap/i;

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

/**
 * The Act's rate arithmetic, shared by the block (`computeBlock`) and the
 * per-asset figure (`computeAssetFigure`) so the two can never drift: the full
 * rate on opening WDV and on additions put to use for 180 days or more, half
 * the rate on the rest.
 */
export function actOnPools(
  rate: number, openLeft: number, fullLeft: number, halfLeft: number,
): number {
  return (openLeft + fullLeft) * (rate / 100) + halfLeft * (rate / 200);
}

/**
 * Take moneys payable off opening WDV first, then full-rate additions, then
 * half-rate additions — the same order in the block and in each asset. Order
 * matters only in the band where the deductions reach down into the additions
 * pools: this ordering rates the surviving pool cheaper to depreciate, which
 * is taxpayer-conservative. The pools are clamped at nil, so a deduction that
 * reaches past its own asset's value floors that asset at zero rather than
 * going negative; the spillover then shows up as the block's residual.
 */
function takeDeductions(
  deductions: number, opening: number, full: number, half: number,
): { openLeft: number; fullLeft: number; halfLeft: number } {
  let remaining = deductions;
  const takeFrom = (pool: number): number => {
    const take = Math.min(pool, remaining);
    remaining -= take;
    return pool - take;
  };
  const openLeft = takeFrom(Math.max(0, opening));
  return { openLeft, fullLeft: takeFrom(full), halfLeft: takeFrom(half) };
}

export interface AssetFigureInput {
  /** The block's rate. Never a rate parsed from a ledger name (design §7). */
  rate: number;
  /** Book seed + rule-3 debits, which join the opening value at the full rate. */
  opening: number;
  acquisitions: Acquisition[];
  /** Sale / write-off credits on THIS ledger only (design §8 C3/C4, §10). */
  deductions: number;
  /** Whether this ledger qualifies under s.32(1)(iia). */
  additionalEligible: boolean;
  /** YYYYMMDD: the half-rate test runs against the review's end date. */
  toDate: string;
}

export interface AssetFigure {
  additionsFull: number;
  additionsHalf: number;
  deductions: number;
  normalDepreciation: number;
  /** This asset's own s.32(1)(iia) figure. A carried-forward balance is a BLOCK item. */
  additionalDepreciation: number;
  total: number;
}

/**
 * One asset at its OWN rates — the full block rate on its opening WDV and on
 * each of its acquisitions put to use for 180 days or more, half the rate on
 * each acquisition under 180 days, and its own sale / write-off credits and
 * its own netted purchase discounts netted against it and no other ledger.
 *
 * This replaced a pro-rata share of the block's statutory total (captain,
 * 2026-09-30): the share blended every asset's half-rate additions and the
 * block's netted discounts into one percentage, so a 15%-block pump with
 * 10,600 of net additions came out at 1,585.12 where the Act says 1,590.00.
 */
export function computeAssetFigure(input: AssetFigureInput): AssetFigure {
  let additionsFull = 0;
  let additionsHalf = 0;
  let additional = 0;
  for (const a of input.acquisitions) {
    const amount = Math.max(0, a.cost - a.netted);
    const short = isShortPeriod(a.firstUse, input.toDate);
    if (short) additionsHalf += amount;
    else additionsFull += amount;
    if (input.additionalEligible) {
      additional += (amount * ADDITIONAL_DEPRECIATION_RATE) / 100 / (short ? 2 : 1);
    }
  }

  const pools = takeDeductions(input.deductions, input.opening, additionsFull, additionsHalf);
  const normal = actOnPools(input.rate, pools.openLeft, pools.fullLeft, pools.halfLeft);
  return {
    additionsFull: round2(additionsFull), additionsHalf: round2(additionsHalf),
    deductions: round2(Math.max(0, input.deductions)),
    normalDepreciation: round2(normal), additionalDepreciation: round2(additional),
    total: round2(normal + additional),
  };
}

/**
 * The asset column IS the per-asset figure, so the column's sum is whatever
 * the assets compute — which must equal the block's statutory total for the
 * Act to tie out. Where it does not, the difference is returned UNSPREAD as a
 * residual: the caller states it on its own line (check 16) rather than
 * pushing it onto an asset that never earned it.
 *
 * Two deviations from a perfect tie are possible and both are deliberate:
 *  - rounding: every asset's own figure is rounded to paise, so a block of n
 *    assets can sum up to half a paisa per asset away from the block total.
 *    Within `ROUNDING_TOLERANCE` that is rounding, not a real difference, and
 *    the last asset absorbs it so the column sums to the rupee — exactly as
 *    the old pro-rata split did. Above it, a finding is worth raising.
 *  - a block-level item (an operator written-down value for the block, a
 *    carried-forward s.32(1)(iia) balance, a deduction that reached past the
 *    asset it was booked on, s.50), which belongs to no single asset and is
 *    therefore never given to one.
 */
export function attributeBlockToAssets(
  block: BlockResult, perAsset: Array<{ ledger: string; own: number }>,
): { shares: Map<string, number>; residual: number } {
  const shares = new Map(perAsset.map((a) => [a.ledger, round2(a.own)]));

  // A block that floors at nil or extinguishes has no asset-wise figure to
  // attribute; the statutory total is nil and so is every share and the
  // residual — nothing is unexplained.
  if (block.status !== "ok" || block.totalDepreciation === 0) {
    return { shares: new Map(perAsset.map((a) => [a.ledger, 0])), residual: 0 };
  }

  const assetsTotal = round2([...shares.values()].reduce((a, b) => a + b, 0));
  const residual = round2(block.totalDepreciation - assetsTotal);
  if (Math.abs(residual) <= ROUNDING_TOLERANCE) {
    // Rounding only: restate the last asset so the column sums to the rupee.
    const last = perAsset[perAsset.length - 1];
    if (last) {
      const others = round2(assetsTotal - (shares.get(last.ledger) ?? 0));
      shares.set(last.ledger, round2(block.totalDepreciation - others));
    }
    return { shares, residual: 0 };
  }
  return { shares, residual };
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
  // then half-rate additions (see `takeDeductions`).
  const pools = takeDeductions(input.deductions, input.openingWdv, additionsFull, additionsHalf);
  const normal = actOnPools(input.rate, pools.openLeft, pools.fullLeft, pools.halfLeft);
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


// ---------------------------------------------------------------------------
// The whole-review assembly
// ---------------------------------------------------------------------------

export interface DepLedgerRows {
  ledger: string;
  rows: LedgerVoucherRow[];
}

export interface DepAnalyzeInput {
  /** Asset ledgers' voucher rows, month-chunked and range-refiltered upstream. */
  ledgerRows: DepLedgerRows[];
  /** Movements on disposal-signal ledgers (design §9): proceeds with no home. */
  disposalSignals: DepLedgerRows[];
  /** Total debits on the depreciation expense ledger(s) for the period. */
  depreciationLedgerDebits: number;
}

export interface AssetRow {
  ledger: string;
  block: string;
  rate: number;
  opening: number;
  /** additionsFull + additionsHalf, the net cost added this year. */
  additionsNet: number;
  /** Additions put to use for 180 days or more, at the full rate. */
  additionsFull: number;
  /** Additions put to use for under 180 days, at half the rate. */
  additionsHalf: number;
  /** This asset's own moneys payable: sale and write-off credits on its ledger. */
  deductions: number;
  /** This asset's own s.32(1)(iia) figure; a carried-forward balance is block-level. */
  additionalDepreciation: number;
  /** YYYYMMDD, or null when the ledger had no acquisition this year. */
  firstUse: string | null;
  /**
   * True when the asset HAS additions and EVERY one of them is under 180
   * days. A mixed asset is false — the two pool columns above say which is
   * which, so this is a summary, never the whole answer.
   */
  shortPeriod: boolean;
  actDepreciation: number;
  bookCharge: number;
  difference: number;
  notes: string;
}

/**
 * A block total that the assets' own figures do not sum to, and why. The
 * amount belongs to the block, not to any ledger, so it is stated on its own
 * line and never spread (captain, 2026-09-30).
 */
export interface BlockResidual {
  block: string;
  /** The block's statutory Act depreciation for the year. */
  blockTotal: number;
  /** What its assets' own rates come to. */
  assetsTotal: number;
  /** blockTotal - assetsTotal. */
  residual: number;
  /** What the difference is, in words. Never empty when residual is non-zero. */
  reason: string;
}

export interface ExcludedRow {
  ledger: string;
  date: string;
  amount: number;
  rule: string;
  missing: string;
}

/** One movement for the workbook's audit trail (design §15, sheet 4). */
export interface MovementRow {
  ledger: string;
  date: string;
  amount: number;
  kind: string;
  rule: string;
  counterparty: string;
  nettedAgainst: string;
}

export interface DepResult {
  blocks: BlockResult[];
  assets: AssetRow[];
  /** Blocks whose statutory total their assets' own figures do not sum to. */
  blockResiduals: BlockResidual[];
  movements: MovementRow[];
  excluded: ExcludedRow[];
  findings: DepFinding[];
  bookCharge: number;
  seedSource: "operator" | "book-seed";
}

const SEVERITY: Record<DepCheckId, Severity> = {
  dep_block_rate_unresolved: "critical",
  dep_asset_ledger_outside_block: "warning",
  dep_opening_wdv_unverified: "warning",
  dep_rate_not_in_act: "warning",
  dep_credit_unclassified: "critical",
  dep_discount_unattributed: "critical",
  dep_disposal_outside_block: "critical",
  dep_book_charge_missing: "warning",
  dep_book_charge_differs: "warning",
  dep_block_charge_differs: "warning",
  dep_book_charge_unreconciled: "critical",
  dep_charge_predates_acquisition: "warning",
  dep_block_extinguished: "warning",
  dep_block_wdv_nil: "warning",
  dep_additional_depreciation_unclaimed: "review",
  dep_block_residual_unattributed: "review",
};

const FIXED_ASSETS_ROOT = "fixed assets";

const isNil = (n: number): boolean => Math.abs(n) < 0.005;

/**
 * Which asset ledgers are ASSET ROWS for the year. A ledger that did not move
 * in the FY is still an asset of its block: the Act computes on the block, so
 * the workbook's per-asset column is an allocation over every asset, and
 * allocating over only the movers silently piles the idle assets' share onto
 * the movers (measured 2026-09-30 on a real company: 24 idle ledgers carrying
 * an opening balance dropped out once the FY's depreciation journal was
 * deleted, and the block totals were right while every credit line was
 * wrong). A ledger with a NIL opening and no movement is not an asset at all
 * and stays out, as before.
 */
export function isAssetRowInScope(bookOpening: number, moved: boolean): boolean {
  return moved || !isNil(bookOpening);
}

/**
 * The whole-review assembly: rate resolution, credit classification,
 * acquisitions, discount netting, block computation, book-charge
 * reconciliation, disposal signals, asset allocation and findings — pure over
 * `DepCtx`, no Tally anywhere in it.
 */
export function analyzeDepreciation(input: DepAnalyzeInput, ctx: DepCtx): DepResult {
  const findings: DepFinding[] = [];
  const excluded: ExcludedRow[] = [];
  const movements: MovementRow[] = [];
  const assets: AssetRow[] = [];
  const blockResiduals: BlockResidual[] = [];
  const push = (
    check: DepCheckId, ledger: string, block: string, amount: number, detail: string,
  ): void => {
    findings.push({
      id: "", check, severity: SEVERITY[check],
      ledger, block, amount, detail,
    });
  };

  // Step 11: the seed's provenance marks the whole report.
  const seedSource: "operator" | "book-seed" =
    ctx.operator.openingWdv.length > 0 ? "operator" : "book-seed";
  if (seedSource === "book-seed") {
    push(
      "dep_opening_wdv_unverified", "", "", 0,
      "no operator opening written-down value was supplied: book balances seed the blocks, so every figure is an unverified seed",
    );
  }

  interface AssetWork {
    ledger: string;
    block: string;
    rate: number;
    /** Book seed + rule-3 debit amounts (design §10 rule 3, full rate). */
    ownOpening: number;
    rule3Debits: number;
    acquisitions: Acquisition[];
    creditKinds: Map<LedgerVoucherRow, { kind: CreditKind; rule: string }>;
    bookCharge: number;
    latestDepDate: string | null;
  }
  const blocks = new Map<string, { name: string; rate: number; assets: AssetWork[] }>();
  const blockOf = (name: string, rate: number) => {
    let b = blocks.get(name);
    if (!b) {
      b = { name, rate, assets: [] };
      blocks.set(name, b);
    }
    return b;
  };

  // Sale credits across all asset ledgers, for the disposal-signal match.
  const saleMatches: Array<{ date: string; amount: number }> = [];

  for (const { ledger, rows } of input.ledgerRows) {
    const resolved = resolveRate(ledger, ctx);
    const group = ctx.groupOf(ledger);
    // Step 2: a ledger whose group IS the Fixed Assets root sits outside
    // every block (design §7 rule 3).
    const outsideBlock = canon(group) === FIXED_ASSETS_ROOT;

    if (resolved.rate === null) {
      push(
        "dep_block_rate_unresolved", ledger, group, 0,
        `the group (${group || "none"}) yields no rate and no operator override covers this ledger; a rateOverrides row is required before any figure can be computed`,
      );
    }
    if (outsideBlock) {
      push(
        "dep_asset_ledger_outside_block", ledger, group, 0,
        "the ledger sits directly under Fixed Assets with no block sub-group between; a rateOverrides row must name its rate",
      );
    }
    if (resolved.rate !== null && !rateIsInAct(resolved.rate)) {
      push(
        "dep_rate_not_in_act", ledger, group, 0,
        `the rate of ${resolved.rate}% is used so the report is not empty, but Appendix I has no such rate for the year`,
      );
    }

    // Step 3: classify every credit. Unresolved and transfer credits are
    // excluded from every computed figure (design §8, §10 C5).
    const creditKinds = new Map<LedgerVoucherRow, { kind: CreditKind; rule: string }>();
    for (const r of rows) {
      if (!isCredit(r)) continue;
      const cls = classifyCredit(ledger, r, ctx);
      if (cls.kind === null) {
        excluded.push({ ledger, date: r.date, amount: Math.abs(r.amount), rule: cls.rule, missing: cls.missing });
        push(
          "dep_credit_unclassified", ledger, group, Math.abs(r.amount),
          `a credit of ${money(Math.abs(r.amount))} on ${displayDate(r.date)} is excluded from every figure: ${cls.missing || "no rule matched the counter ledger"}; a creditClassifications row would resolve it`,
        );
        continue;
      }
      if (cls.kind === "transfer") {
        excluded.push({
          ledger, date: r.date, amount: Math.abs(r.amount), rule: cls.rule,
          missing: "a cross-block transfer needs operator confirmation; it is flagged, never computed",
        });
        push(
          "dep_credit_unclassified", ledger, group, Math.abs(r.amount),
          `a transfer credit of ${money(Math.abs(r.amount))} on ${displayDate(r.date)} is excluded from every figure: a cross-block transfer is never computed without operator confirmation`,
        );
        continue;
      }
      if (cls.kind === "sale") {
        saleMatches.push({ date: r.date, amount: Math.abs(r.amount) });
      }
      creditKinds.set(r, { kind: cls.kind, rule: cls.rule });
    }

    // Step 4: acquisitions, then discount netting.
    const discountRows = [...creditKinds.entries()]
      .filter(([, k]) => k.kind === "discount")
      .map(([r]) => ({ row: r }));
    const acquisitions = groupAcquisitions(ledger, rows, ctx);
    const { netted, unattributed } = netDiscounts(acquisitions, discountRows, ctx);
    for (const r of unattributed) {
      excluded.push({ ledger, date: r.date, amount: Math.abs(r.amount), rule: "C2", missing: "the discount ties to no acquisition" });
      push(
        "dep_discount_unattributed", ledger, group, Math.abs(r.amount),
        `a discount credit of ${money(Math.abs(r.amount))} on ${displayDate(r.date)} ties to no acquisition; it is excluded, never assumed against an opening written-down value`,
      );
    }

    // Step 5: operator cost adjustments, matched by ledger and debit date
    // (or by put-to-use order when the date falls between debits).
    for (const adjRow of ctx.operator.costAdjustments) {
      if (canon(adjRow.ledger) !== canon(ledger)) continue;
      const target = netted.find((a) => a.debits.some((d) => d.date === adjRow.date))
        ?? [...netted]
          .sort((x, y) => y.firstUse.localeCompare(x.firstUse))
          .find((a) => a.firstUse <= adjRow.date);
      if (!target) continue;
      target.cost = round2(target.cost + adjRow.amount);
      movements.push({
        ledger, date: adjRow.date, amount: adjRow.amount, kind: "cost-adjustment", rule: "operator",
        counterparty: "", nettedAgainst: "",
      });
    }

    // Every acquisition debit is an audit-trail movement (design §15.4).
    for (const a of netted) {
      for (const d of a.debits) {
        movements.push({
          ledger, date: d.date, amount: d.amount, kind: "cost", rule: "acquisition",
          counterparty: d.counterparty, nettedAgainst: "",
        });
      }
    }

    // The carried obligation from the acquisitions task's review: rule-3
    // debits (attach-to-nothing on a ledger with a NON-NIL opening balance)
    // are silently dropped from groupAcquisitions' Acquisition[]. Design §10
    // rule 3 says they join the opening written-down value at the FULL rate,
    // so they are carried here into the asset's own opening seed (step 6)
    // instead of being lost.
    const acquisitionDebits = new Set(netted.flatMap((a) => a.debits));
    let rule3Debits = 0;
    if (!isNil(ctx.bookOpening(ledger))) {
      for (const r of rows) {
        if (r.amount <= 0 || acquisitionDebits.has(r)) continue;
        rule3Debits += r.amount;
        movements.push({
          ledger, date: r.date, amount: r.amount, kind: "cost", rule: "R3",
          counterparty: r.counterparty, nettedAgainst: "",
        });
      }
    }

    // Step 7: the book charge is the sum of depreciation-kind credits.
    const unattributedSet = new Set(unattributed);
    let bookCharge = 0;
    let latestDepDate: string | null = null;
    for (const [r, k] of creditKinds) {
      if (k.kind === "depreciation") {
        bookCharge += Math.abs(r.amount);
        if (latestDepDate === null || r.date > latestDepDate) latestDepDate = r.date;
      }
      let nettedAgainst = "";
      if (k.kind === "discount") {
        // Only USED discounts are movements; the unattributed residue lives on
        // the Excluded sheet. The acquisition named is the audit trail's
        // nearest same-counterparty candidate within the netting window.
        if (unattributedSet.has(r)) continue;
        const hit = netted.find(
          (a) => canon(a.counterparty) === canon(r.counterparty) && !isNil(a.netted),
        );
        nettedAgainst = hit ? displayDate(hit.firstUse) : "";
      }
      movements.push({
        ledger, date: r.date, amount: Math.abs(r.amount), kind: k.kind, rule: k.rule,
        counterparty: r.counterparty, nettedAgainst,
      });
    }

    blockOf(group || "Block", resolved.rate ?? 0).assets.push({
      ledger, block: group || "Block", rate: resolved.rate ?? 0,
      ownOpening: round2(ctx.bookOpening(ledger) + rule3Debits),
      rule3Debits, acquisitions: netted, creditKinds, bookCharge, latestDepDate,
    });
  }

  // Step 8: the independent reconciliation against the expense ledger.
  let totalBookCharge = 0;
  for (const b of blocks.values()) {
    for (const a of b.assets) totalBookCharge += a.bookCharge;
  }
  if (Math.abs(totalBookCharge - input.depreciationLedgerDebits) > DEP_TOLERANCE) {
    push(
      "dep_book_charge_unreconciled", "", "", round2(Math.abs(totalBookCharge - input.depreciationLedgerDebits)),
      `the depreciation credits in asset ledgers sum to ${money(totalBookCharge)} but the depreciation expense ledger carries ${money(input.depreciationLedgerDebits)}: the Particulars column misled the classifier somewhere, so no book figure is trustworthy`,
    );
  }

  // Step 9: each disposal-signal row with no matching sale credit.
  for (const { ledger, rows } of input.disposalSignals) {
    for (const r of rows) {
      const amount = Math.abs(r.amount);
      if (amount < 0.005) continue;
      movements.push({
        ledger, date: r.date, amount, kind: "disposal-signal", rule: "C3",
        counterparty: r.counterparty, nettedAgainst: "",
      });
      const matched = saleMatches.some(
        (s) => s.date === r.date && Math.abs(s.amount - amount) < 0.005,
      );
      if (!matched) {
        push(
          "dep_disposal_outside_block", ledger, "", amount,
          `a disposal credit of ${money(amount)} on ${displayDate(r.date)} has no matching credit in any asset ledger; the block it reduces is unknown, so none is reduced — name it in a creditClassifications row`,
        );
      }
    }
  }

  // Step 6: aggregate per block and compute.
  const computedBlocks = new Map<string, BlockResult>();
  for (const b of blocks.values()) {
    const seed = ctx.openingWdv(b.name);
    const carry = ctx.operator.additionalDepreciationCarryForward
      .filter((c) => c.block === b.name)
      .reduce((acc, c) => acc + c.amount, 0);
    const allAcquisitions = b.assets.flatMap((a) => a.acquisitions);

    // Sale and write-off credits in the block's ledgers are moneys payable
    // (design §8 C3/C4, §10's deduction pool).
    let deductions = 0;
    for (const a of b.assets) {
      for (const [r, k] of a.creditKinds) {
        if (k.kind === "sale" || k.kind === "writeoff") deductions += Math.abs(r.amount);
      }
    }

    // anyAssetLeft goes false only when the block had deductions AND every
    // one of its ledgers closes nil (step 6).
    // Block opening = the operator/file (or book-seeded) block opening plus
    // the rule-3 debit amounts, which join it at the full rate (§10 rule 3).
    // ownOpening deliberately also carries the per-ledger book seed for the
    // asset allocation below; computeBlock must not receive it twice.
    const anyAssetLeft = isNil(deductions)
      || b.assets.some((a) => !isNil(ctx.bookClosing(a.ledger)));
    const result = computeBlock(
      {
        block: b.name, rate: b.rate,
        openingWdv: round2(seed.amount + b.assets.reduce((acc, a) => acc + a.rule3Debits, 0)),
        acquisitions: allAcquisitions,
        deductions: round2(deductions),
        anyAssetLeft,
        carryForwardAdditional: carry,
      },
      ctx,
    );
    computedBlocks.set(b.name, result);

    if (result.status === "extinguished") {
      push(
        "dep_block_extinguished", "", b.name, result.shortTermLoss,
        `no asset is left in the block; the balance of ${money(result.shortTermLoss)} is a short-term capital loss under s.50 and no depreciation is due`,
      );
    }
    if (result.status === "nil-floor") {
      push(
        "dep_block_wdv_nil", "", b.name, result.shortTermGain,
        `moneys payable exceed opening plus additions by ${money(result.shortTermGain)}: the excess is a short-term capital gain and no depreciation is due`,
      );
    }

    // Step 10: each asset at its OWN rates (captain, 2026-09-30). The half-rate
    // test and the deduction order are per ACQUISITION and per LEDGER, so a
    // block's assets no longer blend one another's half-rate additions or
    // netted discounts.
    const perAssetOwn = b.assets.map((a) => {
      const ownDeductions = [...a.creditKinds.entries()]
        .filter(([, k]) => k.kind === "sale" || k.kind === "writeoff")
        .reduce((acc, [r]) => acc + Math.abs(r.amount), 0);
      const figure = computeAssetFigure({
        rate: b.rate, opening: a.ownOpening, acquisitions: a.acquisitions,
        deductions: ownDeductions,
        additionalEligible: ctx.additionalDepreciationEligible(a.ledger),
        toDate: ctx.toDate,
      });
      const first = a.acquisitions.length > 0
        ? a.acquisitions.reduce((m, acq) => (acq.firstUse < m ? acq.firstUse : m), a.acquisitions[0].firstUse)
        : null;
      return {
        a, figure, first,
        // "Every addition is short", not "the first one is": the pool columns
        // disambiguate a mixed asset, which this flag must not mis-summarise.
        short: figure.additionsHalf > 0 && figure.additionsFull === 0,
      };
    });
    const attributed = attributeBlockToAssets(
      result,
      perAssetOwn.map((p) => ({ ledger: p.a.ledger, own: p.figure.total })),
    );
    const assetsTotal = round2(perAssetOwn.reduce((acc, p) => acc + p.figure.total, 0));

    if (!isNil(attributed.residual)) {
      // Say what the difference IS, and in this order, so a reader can act on
      // it: a block-level item we can name exactly, then the honest remainder.
      const parts: string[] = [];
      let left = attributed.residual;
      if (!isNil(carry)) {
        parts.push(
          `a carried-forward additional depreciation of ${money(carry)} declared on the block belongs to no single ledger`,
        );
        left = round2(left - carry);
      }
      const openingGap = round2(result.openingWdv - b.assets.reduce((acc, a) => acc + a.ownOpening, 0));
      if (!isNil(openingGap)) {
        parts.push(
          `the block's opening written-down value of ${money(result.openingWdv)} differs from the sum of its assets' book seeds by ${money(openingGap)}`,
        );
        left = round2(left - openingGap);
      }
      if (!isNil(left)) {
        parts.push(
          `a sale or write-off credit that reached past the asset it was booked on, so that asset floors at nil, along with per-asset rounding`,
        );
      }
      const reason = parts.join("; ");
      blockResiduals.push({
        block: b.name, blockTotal: result.totalDepreciation,
        assetsTotal, residual: attributed.residual, reason,
      });
      push(
        "dep_block_residual_unattributed", "", b.name, Math.abs(attributed.residual),
        `the block's Act depreciation of ${money(result.totalDepreciation)} does not equal the ${money(assetsTotal)} its assets' own rates come to; the difference of ${money(attributed.residual)} is carried on its own line and spread across no asset because ${reason}`,
      );
    }

    for (const p of perAssetOwn) {
      const act = round2(attributed.shares.get(p.a.ledger) ?? 0);
      const difference = round2(act - p.a.bookCharge);
      const notes: string[] = [];
      if (p.a.rule3Debits > 0) {
        notes.push(`includes ${money(p.a.rule3Debits)} of cost joined to the opening value at the full rate`);
      }
      if (!isNil(p.figure.additionsHalf) && !isNil(p.figure.additionsFull)) {
        notes.push(
          `mixed put-to-use: ${money(p.figure.additionsFull)} at ${b.rate}% and ${money(p.figure.additionsHalf)} at half that rate`,
        );
      }
      assets.push({
        ledger: p.a.ledger, block: b.name, rate: b.rate,
        opening: p.a.ownOpening,
        additionsNet: round2(p.figure.additionsFull + p.figure.additionsHalf),
        additionsFull: p.figure.additionsFull, additionsHalf: p.figure.additionsHalf,
        deductions: p.figure.deductions, additionalDepreciation: p.figure.additionalDepreciation,
        firstUse: p.first, shortPeriod: p.short,
        actDepreciation: act, bookCharge: round2(p.a.bookCharge), difference,
        notes: notes.join("; "),
      });
      if (Math.abs(difference) > DEP_TOLERANCE) {
        push(
          "dep_book_charge_differs", p.a.ledger, b.name, Math.abs(difference),
          `the Act figure of ${money(act)} differs from the book charge of ${money(p.a.bookCharge)} by ${money(difference)}`,
        );
      }
      if (
        ctx.additionalDepreciationEligible(p.a.ledger)
        && !isNil(result.normalDepreciation)
        && isNil(p.a.bookCharge - result.normalDepreciation)
      ) {
        push(
          "dep_additional_depreciation_unclaimed", p.a.ledger, b.name, 0,
          "the operator declared additional-depreciation eligibility under s.32(1)(iia), but the books charged no more than the normal figure",
        );
      }
    }

    const blockBook = round2(b.assets.reduce((acc, a) => acc + a.bookCharge, 0));
    const blockDiff = round2(result.totalDepreciation - blockBook);
    if (Math.abs(blockDiff) > DEP_TOLERANCE) {
      push(
        "dep_block_charge_differs", "", b.name, Math.abs(blockDiff),
        `the block's Act depreciation of ${money(result.totalDepreciation)} differs from its book charges of ${money(blockBook)} by ${money(blockDiff)}`,
      );
    }
  }

  // Step 7, continued: checks 8 and 12 need the company-wide journal date.
  const companyLatestDep = [...blocks.values()].flatMap((b) => b.assets)
    .reduce<string | null>(
      (m, a) => (a.latestDepDate !== null && (m === null || a.latestDepDate > m) ? a.latestDepDate : m),
      null,
    );
  for (const a of assets) {
    const cost = round2(a.opening + a.additionsNet);
    if (!isNil(cost) && isNil(a.bookCharge)) {
      push(
        "dep_book_charge_missing", a.ledger, a.block, cost,
        `the ledger carries cost of ${money(cost)} but no book depreciation entry for the period`,
      );
    }
    if (
      a.firstUse !== null && companyLatestDep !== null
      && companyLatestDep < a.firstUse && isNil(a.bookCharge)
    ) {
      push(
        "dep_charge_predates_acquisition", a.ledger, a.block, 0,
        `the latest depreciation journal is dated ${displayDate(companyLatestDep)}, before this asset's acquisition of ${displayDate(a.firstUse)}; the asset got no charge at all`,
      );
    }
  }

  // Ordering by check ordinal then ledger happens here; ids are assigned
  // AFTER the sort so `n` counts from 1 within each check in report order.
  findings.sort((x, y) => {
    const byOrdinal = DEP_CHECK_ORDINAL[x.check] - DEP_CHECK_ORDINAL[y.check];
    return byOrdinal !== 0 ? byOrdinal : x.ledger.localeCompare(y.ledger);
  });
  const seqs = new Map<DepCheckId, number>();
  for (const f of findings) {
    const n = (seqs.get(f.check) ?? 0) + 1;
    seqs.set(f.check, n);
    f.id = depFindingId(f.check, n);
  }

  return {
    blocks: [...computedBlocks.values()],
    assets, blockResiduals, movements, excluded, findings,
    bookCharge: round2(totalBookCharge),
    seedSource,
  };
}
