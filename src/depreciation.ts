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

/**
 * The Act computes on the BLOCK; asset-wise is therefore an allocation and
 * the workbook says so (design §15). Basis: each asset's own Act-shaped
 * figure, normalised pro-rata so the asset column sums exactly to the
 * statutory block total — including where the block floors at nil or
 * extinguishes and the total is NOT the sum of the parts.
 */
export function allocateToAssets(
  block: BlockResult, perAsset: Array<{ ledger: string; own: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const total = perAsset.reduce((a, b) => a + b.own, 0);
  if (block.totalDepreciation === 0 || total <= 0) {
    for (const a of perAsset) out.set(a.ledger, 0);
    return out;
  }
  let assigned = 0;
  perAsset.forEach((a, i) => {
    const last = i === perAsset.length - 1;
    // The last asset absorbs the rounding so the column sums exactly.
    const share = last
      ? round2(block.totalDepreciation - assigned)
      : round2((a.own / total) * block.totalDepreciation);
    assigned = round2(assigned + share);
    out.set(a.ledger, share);
  });
  return out;
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
  additionsNet: number;
  /** YYYYMMDD, or null when the ledger had no acquisition this year. */
  firstUse: string | null;
  shortPeriod: boolean;
  actDepreciation: number;
  bookCharge: number;
  difference: number;
  notes: string;
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
};

const FIXED_ASSETS_ROOT = "fixed assets";

const isNil = (n: number): boolean => Math.abs(n) < 0.005;

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

    // Step 10: each asset's own Act-shaped figure, then the allocation.
    const perAssetOwn = b.assets.map((a) => {
      const netAdd = a.acquisitions.reduce((acc, acq) => acc + Math.max(0, acq.cost - acq.netted), 0);
      const first = a.acquisitions.length > 0
        ? a.acquisitions.reduce((m, acq) => (acq.firstUse < m ? acq.firstUse : m), a.acquisitions[0].firstUse)
        : null;
      const short = first !== null ? isShortPeriod(first, ctx.toDate) : false;
      const own = round2(
        a.ownOpening * (b.rate / 100) + netAdd * (b.rate / 100) * (short ? 0.5 : 1),
      );
      return { a, netAdd, first, short, own };
    });
    const allocated = allocateToAssets(
      result,
      perAssetOwn.map((p) => ({ ledger: p.a.ledger, own: p.own })),
    );

    for (const p of perAssetOwn) {
      const act = round2(allocated.get(p.a.ledger) ?? 0);
      const difference = round2(act - p.a.bookCharge);
      const notes: string[] = [];
      if (p.a.rule3Debits > 0) {
        notes.push(`includes ${money(p.a.rule3Debits)} of cost joined to the opening value at the full rate`);
      }
      assets.push({
        ledger: p.a.ledger, block: b.name, rate: b.rate,
        opening: p.a.ownOpening, additionsNet: round2(p.netAdd),
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
    assets, movements, excluded, findings,
    bookCharge: round2(totalBookCharge),
    seedSource,
  };
}
