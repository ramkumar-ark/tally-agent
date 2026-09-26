import type { VoucherRow } from "./downstream.js";
import { counterpartyOf } from "./tds-daybook.js";
import { canonicalKey } from "./key.js";
import { count, displayDate, money } from "./format.js";
import {
  EXPENSE_ROOTS,
  INCOME_ROOTS,
  MONEY_ROOTS,
  SUPPLIER_ROOTS,
  DEPRECIATION_NAME,
  WRITEOFF_NAME,
  NETTING_WINDOW_DAYS,
} from "./depreciation.js";
import { isShortPeriod } from "./depreciation-law.js";
import {
  CASH_COST_LIMIT,
  PURCHASE_VOUCHER,
  REDUCTION_VOUCHER,
  SALE_PL_NAME,
  TAX_NAME,
  HALFADD_DEFAULT,
  DEPN_TEXT,
} from "./dep3cd-law.js";
import type { D3cdFinding } from "./types.js";

export interface Dep3cdCtx {
  fromDate: string; toDate: string;
  /** Canonical ancestry of a LEDGER: [parent, grandparent, …, primary]; canonical keys (lowercase). */
  chainOf(ledger: string): string[];
  isAssetLedger(ledger: string): boolean;
  /** Nearest fixed-asset group name (real case) of an asset ledger, "" when none. */
  assetGroupOf(ledger: string): string;
  blockLists: { additions: readonly string[]; deletions: readonly string[] };
  operator: Dep3cdOperator;
}

export interface Dep3cdAdjustment {
  ledger: string; date: string; voucherNumber: string;
  action: "New purchase" | "Merge into earlier purchase" | "Exclude" | "Consideration" | "Deduct from 2nd half";
  amount: number | null;
  /** Template row number (for error messages). */
  row: number;
}

export interface Dep3cdOperator {
  groupBlocks: Map<string, string>;   // canonicalKey(group) -> block text
  ledgerBlocks: Map<string, string>;  // canonicalKey(ledger) -> block text
  adjustments: Dep3cdAdjustment[];
}

export type MovementKind = "purchase" | "capitalised" | "reduction" | "consideration"
  | "sale_pl" | "depreciation" | "transfer" | "unclassified";

export interface AssetMovement {
  ledger: string; date: string; voucherType: string; voucherNumber: string;
  amount: number;              // positive = debit on the asset ledger
  kind: MovementKind; counter: string;
  basis?: "transfer" | "receipt";
  voucher: VoucherRow;         // the whole voucher (consideration/charges need it)
  index: number;               // entry index inside voucher
}

export interface AcquisitionPart {
  date: string; voucherNumber: string; amount: number;
  kind: "purchase" | "capitalised" | "reduction" | "charge";
}

export interface Dep3cdAddition {
  ledger: string; block: string | null; purchaseDate: string; putToUse: string;
  amount: number; voucherNumber: string; parts: AcquisitionPart[]; orphan: boolean; secondHalf: boolean;
}

const ZERO = 0.005;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const CASH_CHAIN = canonicalKey("Cash-in-Hand");
const CURRENT_ASSETS = canonicalKey("Current Assets");

const ymdMs = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
const daysBetween = (a: string, b: string): number => Math.round((ymdMs(b) - ymdMs(a)) / 86400000);

function chainHits(chain: string[], set: ReadonlySet<string>): boolean {
  return chain.some((g) => set.has(g));
}

export function classifyMovements(vouchers: VoucherRow[], ctx: Dep3cdCtx): AssetMovement[] {
  const out: AssetMovement[] = [];
  for (const v of vouchers) {
    if (v.cancelled) continue;
    v.entries.forEach((entry, index) => {
      if (Math.abs(entry.amount) <= ZERO) return;
      if (!ctx.isAssetLedger(entry.ledger)) return;
      const counter = counterpartyOf(v, index);
      const chain = counter ? ctx.chainOf(counter) : [];
      const counterIsAsset = counter !== "" && ctx.isAssetLedger(counter);
      const inExpense = chainHits(chain, EXPENSE_ROOTS);
      const inIncome = chainHits(chain, INCOME_ROOTS);
      const inSupplier = chainHits(chain, SUPPLIER_ROOTS);
      const inMoney = chainHits(chain, MONEY_ROOTS);
      const inCurrentAssets = chain.includes(CURRENT_ASSETS);
      let kind: MovementKind;
      let basis: "transfer" | "receipt" | undefined;
      if (entry.amount > 0) {
        if (SALE_PL_NAME.test(counter) || inIncome) kind = "sale_pl";
        else if (counterIsAsset) kind = "transfer";
        else if (PURCHASE_VOUCHER.test(String(v.voucherType ?? ""))) kind = "purchase";
        else kind = "capitalised";
      } else {
        if (inExpense && DEPRECIATION_NAME.test(counter)) kind = "depreciation";
        else if (SALE_PL_NAME.test(counter) || (inExpense && WRITEOFF_NAME.test(counter))) kind = "sale_pl";
        else if (counterIsAsset) kind = "transfer";
        else if (REDUCTION_VOUCHER.test(String(v.voucherType ?? "")) || inSupplier) kind = "reduction";
        else if (inIncome) { kind = "consideration"; basis = "transfer"; }
        else if (inMoney || inCurrentAssets) { kind = "consideration"; basis = "receipt"; }
        else kind = "unclassified";
      }
      out.push({
        ledger: entry.ledger,
        date: String(v.date ?? ""),
        voucherType: String(v.voucherType ?? ""),
        voucherNumber: String(v.voucherNumber ?? ""),
        amount: entry.amount,
        kind,
        counter,
        basis,
        voucher: v,
        index,
      });
    });
  }
  return out;
}

interface Work {
  row: Dep3cdAddition;
  counters: Set<string>;
}

function matchAdjustments(
  moves: AssetMovement[],
  adjustments: Dep3cdAdjustment[],
): Map<AssetMovement, Dep3cdAdjustment> {
  const map = new Map<AssetMovement, Dep3cdAdjustment>();
  for (const a of adjustments) {
    const hits = moves.filter(
      (m) =>
        canonicalKey(m.ledger) === canonicalKey(a.ledger) &&
        String(m.date) === String(a.date) &&
        String(m.voucherNumber) === String(a.voucherNumber),
    );
    if (hits.length === 0) {
      // A "Consideration" adjustment legitimately cites an asset the books never
      // relieved and creates the deletion itself (Task 5, D3CD-006 closure); every
      // other action must point at a real movement.
      if (a.action === "Consideration") continue;
      throw new Error(
        `Adjustments row ${a.row} matches no movement in the books for the ledger, date and voucher given; correct or remove the row`,
      );
    }
    for (const m of hits) map.set(m, a);
  }
  return map;
}

/** C11/Q9: a purchase or capitalised part settled on the cash-in-hand chain over
 *  Rs 10,000 is not part of the actual cost and is excluded from the amount. */
function cashExcluded(m: AssetMovement, ctx: Dep3cdCtx): boolean {
  if (m.kind !== "purchase" && m.kind !== "capitalised") return false;
  if (Math.abs(m.amount) <= CASH_COST_LIMIT) return false;
  return ctx.chainOf(m.counter).includes(CASH_CHAIN);
}

function recompute(w: Work): void {
  w.row.amount = round2(w.row.parts.reduce((s, p) => s + p.amount, 0));
  const purchases = w.row.parts.filter((p) => p.kind === "purchase").map((p) => p.date);
  const dates = purchases.length > 0 ? purchases : w.row.parts.map((p) => p.date);
  if (dates.length > 0) {
    w.row.purchaseDate = [...dates].sort()[0];
    w.row.putToUse = w.row.purchaseDate;
  }
}

function addPart(
  w: Work,
  m: AssetMovement,
  kind: AcquisitionPart["kind"],
  ctx: Dep3cdCtx,
  findings: Array<Omit<D3cdFinding, "id">>,
): void {
  const excluded = cashExcluded(m, ctx);
  w.row.parts.push({
    date: m.date,
    voucherNumber: m.voucherNumber,
    amount: excluded ? 0 : m.amount,
    kind,
  });
  if (m.counter !== "") w.counters.add(canonicalKey(m.counter));
  recompute(w);
  if (excluded) {
    findings.push({
      check: "d3cd_cash_payment_in_cost",
      severity: "warning",
      ledger: m.ledger,
      amount: Math.abs(m.amount),
      detail: `cash payment of ${money(Math.abs(m.amount))} on ${displayDate(m.date)} is over Rs 10,000 and is excluded from the actual cost (s.43(1))`,
    });
  }
}

function makeWork(
  m: AssetMovement,
  kind: AcquisitionPart["kind"],
  orphan: boolean,
  ctx: Dep3cdCtx,
  findings: Array<Omit<D3cdFinding, "id">>,
): Work {
  const w: Work = {
    row: {
      ledger: m.ledger,
      block: null,
      purchaseDate: m.date,
      putToUse: m.date,
      amount: 0,
      voucherNumber: m.voucherNumber,
      parts: [],
      orphan,
      secondHalf: false,
    },
    counters: new Set<string>(),
  };
  addPart(w, m, kind, ctx, findings);
  return w;
}

function latestOnOrBefore(acq: Work[], date: string): Work | undefined {
  let best: Work | undefined;
  for (const w of acq) {
    if (w.row.purchaseDate > date) continue;
    if (!best || w.row.purchaseDate >= best.row.purchaseDate) best = w;
  }
  return best;
}

function attach(
  m: AssetMovement,
  acq: Work[],
  ctx: Dep3cdCtx,
  findings: Array<Omit<D3cdFinding, "id">>,
): void {
  if (m.kind === "reduction") {
    const within = acq.filter(
      (w) => w.row.purchaseDate <= m.date && daysBetween(w.row.purchaseDate, m.date) <= NETTING_WINDOW_DAYS,
    );
    const ck = canonicalKey(m.counter);
    const sameCounter = within.filter((w) => w.counters.has(ck));
    const pool = sameCounter.length > 0 ? sameCounter : within;
    let target: Work | undefined;
    for (const w of pool) if (!target || w.row.purchaseDate >= target.row.purchaseDate) target = w;
    if (target) {
      addPart(target, m, "reduction", ctx, findings);
      return;
    }
    findings.push({
      check: "d3cd_reduction_unattributed",
      severity: "warning",
      ledger: m.ledger,
      amount: Math.abs(m.amount),
      detail: `a reduction of ${money(Math.abs(m.amount))} on ${displayDate(m.date)} could not be matched to an earlier acquisition and is not applied`,
    });
    return;
  }

  const kind: AcquisitionPart["kind"] = m.kind === "purchase" ? "purchase" : "capitalised";
  const before = latestOnOrBefore(acq, m.date);
  if (before) {
    addPart(before, m, kind, ctx, findings);
    return;
  }
  const after = acq
    .filter((w) => w.row.purchaseDate > m.date && daysBetween(m.date, w.row.purchaseDate) <= NETTING_WINDOW_DAYS)
    .sort((a, b) => a.row.purchaseDate.localeCompare(b.row.purchaseDate))[0];
  if (after) {
    addPart(after, m, kind, ctx, findings);
    return;
  }
  const w = makeWork(m, kind, true, ctx, findings);
  acq.push(w);
  findings.push({
    check: "d3cd_addition_to_existing_asset",
    severity: "review",
    ledger: m.ledger,
    amount: Math.abs(m.amount),
    detail: `a capitalised debit of ${money(Math.abs(m.amount))} on ${displayDate(m.date)} has no purchase this year and is treated as its own addition`,
  });
}

export function buildAcquisitions(
  moves: AssetMovement[],
  ctx: Dep3cdCtx,
): { additions: Dep3cdAddition[]; findings: Array<Omit<D3cdFinding, "id">> } {
  const findings: Array<Omit<D3cdFinding, "id">> = [];
  const adj = matchAdjustments(moves, ctx.operator.adjustments);
  for (const m of moves) {
    if (m.kind === "unclassified") {
      findings.push({
        check: "d3cd_credit_unclassified",
        severity: "critical",
        ledger: m.ledger,
        amount: Math.abs(m.amount),
        detail: `a credit of ${money(Math.abs(m.amount))} on ${displayDate(m.date)} has no recognisable counter and is not treated as a deletion`,
      });
    }
  }

  const byLedger = new Map<string, AssetMovement[]>();
  for (const m of moves) {
    if (adj.get(m)?.action === "Exclude") continue;
    if (m.kind !== "purchase" && m.kind !== "capitalised" && m.kind !== "reduction") continue;
    const k = canonicalKey(m.ledger);
    const arr = byLedger.get(k) ?? [];
    arr.push(m);
    byLedger.set(k, arr);
  }

  const additions: Dep3cdAddition[] = [];
  for (const list of byLedger.values()) {
    list.sort(
      (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.voucherNumber).localeCompare(String(b.voucherNumber)),
    );
    const acq: Work[] = [];
    const byVoucher = new Map<string, Work>();
    const deferred: AssetMovement[] = [];
    for (const m of list) {
      const action = adj.get(m)?.action;
      const starts = (m.kind === "purchase" && action !== "Merge into earlier purchase") || action === "New purchase";
      const vKey = `${m.date}|${m.voucherType}|${m.voucherNumber}`;
      if (starts) {
        const same = byVoucher.get(vKey);
        if (same) {
          addPart(same, m, "purchase", ctx, findings);
          continue;
        }
        const w = makeWork(m, "purchase", false, ctx, findings);
        acq.push(w);
        byVoucher.set(vKey, w);
        continue;
      }
      deferred.push(m);
    }
    for (const m of deferred) attach(m, acq, ctx, findings);

    const real = acq.filter((w) => !w.row.orphan);
    if (real.length >= 2) {
      findings.push({
        check: "d3cd_multiple_purchases_in_ledger",
        severity: "review",
        ledger: real[0].row.ledger,
        amount: round2(real.reduce((s, w) => s + w.row.amount, 0)),
        detail: `${count(real.length)} purchases on ${real.map((w) => displayDate(w.row.purchaseDate)).join(", ")}`,
      });
    }

    for (const w of acq) {
      w.row.secondHalf = isShortPeriod(w.row.purchaseDate, ctx.toDate);
      additions.push(w.row);
    }
  }

  additions.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.ledger.localeCompare(b.ledger));
  return { additions, findings };
}

export interface Dep3cdDeletion {
  ledger: string; block: string | null; date: string; amount: number; voucherNumber: string;
  basis: "transfer" | "receipt" | "operator"; halfAdd: "Yes" | "No"; depn: "No";
  /** Asset-ledger credit, for the report's "books vs consideration" column only. */
  bookCredit: number;
}

const DUTIES_TAXES = canonicalKey("Duties & Taxes");
const SALES_ACCOUNTS = canonicalKey("Sales Accounts");
const DISPOSAL_NAME = /sale of (fixed )?asset|asset sale|disposal/i;

function isMoneyOrPartyLine(ledger: string, ctx: Dep3cdCtx): boolean {
  const chain = ctx.chainOf(ledger);
  return chainHits(chain, MONEY_ROOTS) || chain.includes(CURRENT_ASSETS);
}

function isTaxLine(ledger: string, ctx: Dep3cdCtx): boolean {
  return TAX_NAME.test(ledger) || ctx.chainOf(ledger).includes(DUTIES_TAXES);
}

function isSalesAccountsLine(ledger: string, ctx: Dep3cdCtx): boolean {
  return ctx.chainOf(ledger).includes(SALES_ACCOUNTS);
}

/** Q6: the consideration is gross of selling expenses and excludes GST. The receipt
 *  pool is the money/party debits of the voucher less any tax credits on it. */
function receiptPool(v: VoucherRow, ctx: Dep3cdCtx): number {
  let debits = 0;
  let taxes = 0;
  for (const e of v.entries) {
    if (e.amount > ZERO && !ctx.isAssetLedger(e.ledger) && isMoneyOrPartyLine(e.ledger, ctx)) debits += e.amount;
    if (e.amount < -ZERO && isTaxLine(e.ledger, ctx)) taxes += -e.amount;
  }
  return round2(debits - taxes);
}

function makeDeletion(
  ledger: string, v: VoucherRow, amount: number, basis: Dep3cdDeletion["basis"], bookCredit: number,
): Dep3cdDeletion {
  return {
    ledger, block: null, date: String(v.date), amount: round2(amount), voucherNumber: String(v.voucherNumber),
    basis, halfAdd: HALFADD_DEFAULT, depn: DEPN_TEXT, bookCredit: round2(bookCredit),
  };
}

export function buildDisposals(
  moves: AssetMovement[], vouchers: VoucherRow[], ctx: Dep3cdCtx,
): { deletions: Dep3cdDeletion[]; findings: Omit<D3cdFinding, "id">[] } {
  const deletions: Dep3cdDeletion[] = [];
  const findings: Omit<D3cdFinding, "id">[] = [];

  const byVoucher = new Map<VoucherRow, AssetMovement[]>();
  for (const m of moves) {
    if (m.kind !== "consideration") continue;
    const list = byVoucher.get(m.voucher) ?? [];
    list.push(m);
    byVoucher.set(m.voucher, list);
  }

  for (const [v, ms] of byVoucher) {
    const transfers = ms.filter((m) => m.basis === "transfer");
    const receipts = ms.filter((m) => m.basis === "receipt");
    for (const m of transfers) {
      deletions.push(makeDeletion(m.ledger, v, Math.abs(m.amount), "transfer", Math.abs(m.amount)));
    }
    if (receipts.length === 0) continue;
    const pool = receiptPool(v, ctx);
    if (receipts.length === 1) {
      const m = receipts[0];
      deletions.push(makeDeletion(m.ledger, v, pool, "receipt", Math.abs(m.amount)));
      continue;
    }
    const total = receipts.reduce((s, m) => s + Math.abs(m.amount), 0);
    let allocated = 0;
    receipts.forEach((m, i) => {
      const share = i === receipts.length - 1
        ? round2(pool - allocated)
        : round2((pool * Math.abs(m.amount)) / total);
      allocated = round2(allocated + share);
      deletions.push(makeDeletion(m.ledger, v, share, "receipt", Math.abs(m.amount)));
    });
    findings.push({
      check: "d3cd_consideration_apportioned", severity: "review", ledger: "", amount: pool,
      detail: `one receipt of ${money(pool)} on ${displayDate(String(v.date))} was apportioned across ${count(receipts.length)} assets`,
    });
  }

  for (const a of ctx.operator.adjustments) {
    const key = canonicalKey(a.ledger);
    const existing = deletions.find(
      (d) => canonicalKey(d.ledger) === key && d.date === String(a.date) && d.voucherNumber === String(a.voucherNumber),
    );
    if (a.action === "Consideration") {
      if (existing) {
        if (a.amount !== null) existing.amount = round2(a.amount);
        existing.basis = "operator";
      } else if (a.amount !== null) {
        const v = vouchers.find((x) => String(x.voucherNumber) === String(a.voucherNumber) && String(x.date) === String(a.date));
        const stub: VoucherRow = v ?? {
          date: a.date, voucherType: "", voucherNumber: a.voucherNumber, partyLedgerName: "", cancelled: false, entries: [],
        };
        deletions.push(makeDeletion(a.ledger, stub, a.amount, "operator", 0));
      }
    } else if (a.action === "Deduct from 2nd half" && existing) {
      existing.halfAdd = "Yes";
    }
  }

  const transfersOut = new Map<string, number>();
  for (const m of moves) {
    if (m.kind !== "consideration" || m.basis !== "transfer") continue;
    const k = canonicalKey(m.counter);
    if (!k) continue;
    transfersOut.set(k, round2((transfersOut.get(k) ?? 0) + Math.abs(m.amount)));
  }

  const credits = new Map<string, { name: string; amount: number }>();
  for (const v of vouchers) {
    if (v.cancelled) continue;
    for (const e of v.entries) {
      if (e.amount >= -ZERO || !isSalesAccountsLine(e.ledger, ctx) || !DISPOSAL_NAME.test(e.ledger)) continue;
      const k = canonicalKey(e.ledger);
      const hit = credits.get(k) ?? { name: e.ledger, amount: 0 };
      hit.amount = round2(hit.amount + -e.amount);
      credits.set(k, hit);
    }
  }

  for (const [k, hit] of credits) {
    if (!transfersOut.has(k)) {
      findings.push({
        check: "d3cd_disposal_unmatched", severity: "critical", ledger: hit.name, amount: hit.amount,
        detail: `${money(hit.amount)} of asset sales were booked with no asset relieved; add a Consideration adjustment for the asset sold`,
      });
    }
  }
  for (const [k, out] of transfersOut) {
    const hit = credits.get(k);
    const diff = round2(out - (hit?.amount ?? 0));
    if (Math.abs(diff) > 1) {
      findings.push({
        check: "d3cd_disposal_ledger_unreconciled", severity: "warning", ledger: hit?.name ?? k, amount: Math.abs(diff),
        detail: `asset transfers out of ${money(out)} do not reconcile with the sales booked there (${money(hit?.amount ?? 0)})`,
      });
    }
  }

  for (const d of deletions) {
    if (d.basis !== "receipt") continue;
    const split = vouchers.some(
      (v) => !v.cancelled && String(v.date) === d.date && String(v.voucherNumber) !== d.voucherNumber
        && v.entries.some((e) => e.amount < -ZERO && SALE_PL_NAME.test(e.ledger))
        && v.entries.some((e) => e.amount > ZERO && isMoneyOrPartyLine(e.ledger, ctx)),
    );
    if (split) {
      findings.push({
        check: "d3cd_consideration_split_voucher", severity: "review", ledger: d.ledger, amount: d.amount,
        detail: `another voucher on ${displayDate(d.date)} posts a profit or loss on sale against a receipt; the consideration may be split across vouchers`,
      });
    }
  }

  deletions.sort((a, b) => a.date.localeCompare(b.date) || a.ledger.localeCompare(b.ledger));
  return { deletions, findings };
}