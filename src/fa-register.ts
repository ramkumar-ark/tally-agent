import type { LedgerVoucherRow } from "./downstream.js";
import {
  classifyCredit, groupAcquisitions, netDiscounts, resolveRate, round2,
  type Acquisition, type DepCtx,
} from "./depreciation.js";
import { EMPTY_DEP_OPERATOR } from "./depreciation-file.js";
import { displayDate, money } from "./format.js";
import {
  faFindingId, FA_CHECK_ORDINAL, sideOf, ZERO_TOLERANCE,
  type FaCheckId, type FaFinding, type Severity,
} from "./types.js";

/**
 * The fixed asset purchase & sale register: a pure, Tally-free engine that
 * reuses the depreciation engine's exported acquisition grouping and credit
 * classification (design of record §3, D10). Its artifact is for auditors;
 * it recomputes nothing and changes no depreciation figure.
 */

/** Road-transport vocabulary, tested against the asset LEDGER name and its BLOCK GROUP name (D3). */
export const VEHICLE_NAME =
  /vehicle|motor ?cycle|two[- ]?wheeler|three[- ]?wheeler|auto ?rickshaw|\bcar\b|\blorry\b|\btruck\b|\btipper\b|\bbus\b|\bvan\b|\bjeep\b|\btempo\b|\btrailer\b|\bscooter\b|\bambulance\b/i;
export const INSURANCE_NAME = /insur/i;
export const RTO_NAME = /\brto\b|registrat|road tax|life tax|m\.?v\.? tax|motor vehicle tax/i;
export const ACCESSORY_NAME = /accessor|fitting|seat cover|music system|audio|gps|tracking device|fastag/i;

export type FaCostType = "insurance" | "rto" | "accessories";
export const COST_VOCAB: Record<FaCostType, RegExp> = {
  insurance: INSURANCE_NAME, rto: RTO_NAME, accessories: ACCESSORY_NAME,
};
export const COST_TYPES: readonly FaCostType[] = ["insurance", "rto", "accessories"];
/** Absence is flagged only for these: accessories are optional, insurance and registration are not (D4). */
export const ABSENCE_CHECKED: readonly FaCostType[] = ["insurance", "rto"];

export function isVehicleAsset(ledgerName: string, groupName: string): boolean {
  return VEHICLE_NAME.test(ledgerName) || VEHICLE_NAME.test(groupName);
}

export const VEHICLE_WINDOW_BEFORE_DAYS = 30;
export const VEHICLE_WINDOW_AFTER_DAYS = 90;

const at = (ymd: string): number =>
  Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));

/** True when `date` falls VEHICLE_WINDOW_BEFORE_DAYS before through VEHICLE_WINDOW_AFTER_DAYS after `firstUse`. */
export function inVehicleWindow(firstUse: string, date: string): boolean {
  const diff = (at(date) - at(firstUse)) / 86400000;
  return diff >= -VEHICLE_WINDOW_BEFORE_DAYS && diff <= VEHICLE_WINDOW_AFTER_DAYS;
}

const canon = (s: string): string => s.trim().toLowerCase();

const SEVERITY: Record<FaCheckId, Severity> = {
  fa_vehicle_incidental_expensed: "review",
  fa_vehicle_incidental_missing: "review",
  fa_vehicle_vendor_unsettled: "review",
  fa_disposal_unmatched: "review",
};

export interface FaCtx {
  fromDate: string;   // YYYYMMDD
  toDate: string;     // YYYYMMDD
  groupOf(ledger: string): string;
  groupRootOf(ledger: string): string;
  isAssetLedger(ledger: string): boolean;
  /** Period-start book balance (positive = debit), for acquisition grouping's opening test. */
  bookOpening(ledger: string): number;
  /** Period-end trial-balance balance (positive = debit), for the vendor squared-off check. */
  closingBalanceOf(ledger: string): number;
}

export interface FaLedgerRows { ledger: string; rows: LedgerVoucherRow[]; }

export interface FaAnalyzeInput {
  /** Every asset ledger's voucher rows, month-chunked and range-refiltered upstream (D5). */
  ledgerRows: FaLedgerRows[];
  /** Incidental-pattern EXPENSE ledgers' rows (name matches a cost vocabulary, root is an expense root). */
  incidentalExpenseRows: FaLedgerRows[];
  /** Disposal-signal ledgers' rows (depreciation design §9). */
  disposalSignals: FaLedgerRows[];
}

export interface FaPurchaseRow {
  date: string;
  asset: string;
  block: string;
  rate: number | null;
  /** This debit's counterparty (supplier, bank, ...). */
  counterparty: string;
  /** The acquisition's supplier — the vendor whose statement the accountant pulls. Every instalment of the acquisition carries it. */
  vendor: string;
  amount: number;
  voucherType: string;
  voucherNumber: string;
  reference: string;
  /** First-use date of the acquisition this debit belongs to; "" on R3 rows. */
  acquisitionDate: string;
  instalment: number;       // 1-based; 0 on R3 rows
  instalments: number;      // 0 on R3 rows
  /** Net cost after discount netting; first instalment only. */
  acquisitionCost: number;
  /** Discount netted against the acquisition; first instalment only. */
  netted: number;
  rule: string;             // "acquisition" | "R3"
  isVehicle: boolean;
  /** Vehicle acquisitions only, first instalment only; filled by the vehicle pass. */
  incidentalSummary: string;
}

export interface FaDisposalRow {
  date: string;
  asset: string;            // "" on disposal-signal rows
  block: string;            // "" on disposal-signal rows
  counterparty: string;     // buyer/payer; the signal ledger on disposal-signal rows
  amount: number;
  voucherType: string;
  voucherNumber: string;
  reference: string;
  kind: "sale" | "writeoff" | "disposal-signal";
  rule: string;             // "C3" | "C4" | "§9"
  note: string;
}

export interface FaResult {
  purchases: FaPurchaseRow[];
  disposals: FaDisposalRow[];
  vehicleCosts: Array<{
    vehicle: string; block: string; firstUse: string; costType: FaCostType;
    status: "capitalised" | "expensed" | "not-found" | "none";
    amount: number; date: string | null; where: string;
    voucherType: string; voucherNumber: string; reference: string;
    ambiguous: boolean; findingId: string;
  }>;
  vendors: Array<{
    vendor: string; vehicles: string[]; acquisitionsTotal: number;
    closingBalance: number; side: "Dr" | "Cr" | null; squaredOff: boolean; findingId: string;
  }>;
  findings: FaFinding[];
}

const depCtxOf = (ctx: FaCtx): DepCtx => ({
  fromDate: ctx.fromDate, toDate: ctx.toDate,
  operator: EMPTY_DEP_OPERATOR,
  groupOf: ctx.groupOf, groupRootOf: ctx.groupRootOf, isAssetLedger: ctx.isAssetLedger,
  openingWdv: () => ({ amount: 0, source: "book-seed" }),
  bookOpening: ctx.bookOpening,
  bookClosing: () => 0,
  additionalDepreciationEligible: () => false,
});

export function analyzeFaRegister(input: FaAnalyzeInput, ctx: FaCtx): FaResult {
  const depCtx = depCtxOf(ctx);
  const purchases: FaPurchaseRow[] = [];
  const disposals: FaDisposalRow[] = [];
  const findings: FaFinding[] = [];
  const saleCredits: Array<{ date: string; amount: number }> = [];
  const perLedger: Array<{ ledger: string; group: string; rows: LedgerVoucherRow[]; acquisitions: Acquisition[] }> = [];

  for (const { ledger, rows } of input.ledgerRows) {
    const group = ctx.groupOf(ledger);
    const rate = resolveRate(ledger, depCtx).rate;

    const creditKinds = new Map<LedgerVoucherRow, { kind: string; rule: string }>();
    for (const r of rows) {
      if (r.amount >= 0) continue;
      const cls = classifyCredit(ledger, r, depCtx);
      // Depreciation, transfers and unclassified credits are not register rows (D2);
      // the depreciation review's Excluded sheet owns them.
      if (cls.kind === null || cls.kind === "transfer" || cls.kind === "depreciation") continue;
      creditKinds.set(r, { kind: cls.kind, rule: cls.rule });
      if (cls.kind === "sale") saleCredits.push({ date: r.date, amount: Math.abs(r.amount) });
    }

    const discountRows = [...creditKinds.entries()]
      .filter(([, k]) => k.kind === "discount")
      .map(([r]) => ({ row: r }));
    const grouped = groupAcquisitions(ledger, rows, depCtx);
    const { netted } = netDiscounts(grouped, discountRows, depCtx);

    for (const a of netted) {
      const sorted = a.debits.slice().sort((x, y) => x.date.localeCompare(y.date));
      sorted.forEach((d, i) => {
        purchases.push({
          date: d.date, asset: ledger, block: group, rate,
          counterparty: d.counterparty, vendor: a.counterparty,
          amount: d.amount,
          voucherType: d.voucherType, voucherNumber: d.voucherNumber, reference: d.reference,
          acquisitionDate: a.firstUse,
          instalment: i + 1, instalments: sorted.length,
          acquisitionCost: i === 0 ? round2(Math.max(0, a.cost - a.netted)) : 0,
          netted: i === 0 ? a.netted : 0,
          rule: "acquisition",
          isVehicle: isVehicleAsset(ledger, group),
          incidentalSummary: "",
        });
      });
    }

    // Rule-3 debits: cost of an asset already in use (design §10 rule 3) — still
    // additions an auditor must see, so they are register rows too.
    const acquisitionDebits = new Set(netted.flatMap((a) => a.debits));
    if (Math.abs(ctx.bookOpening(ledger)) >= 0.005) {
      for (const r of rows) {
        if (r.amount <= 0 || acquisitionDebits.has(r)) continue;
        purchases.push({
          date: r.date, asset: ledger, block: group, rate,
          counterparty: r.counterparty, vendor: "",
          amount: r.amount,
          voucherType: r.voucherType, voucherNumber: r.voucherNumber, reference: r.reference,
          acquisitionDate: "", instalment: 0, instalments: 0,
          acquisitionCost: 0, netted: 0,
          rule: "R3", isVehicle: isVehicleAsset(ledger, group), incidentalSummary: "",
        });
      }
    }

    for (const [r, k] of creditKinds) {
      if (k.kind !== "sale" && k.kind !== "writeoff") continue;
      disposals.push({
        date: r.date, asset: ledger, block: group,
        counterparty: r.counterparty, amount: Math.abs(r.amount),
        voucherType: r.voucherType, voucherNumber: r.voucherNumber, reference: r.reference,
        kind: k.kind as "sale" | "writeoff", rule: k.rule, note: "",
      });
    }

    perLedger.push({ ledger, group, rows, acquisitions: netted });
  }

  void saleCredits; // the disposal-signal pass consumes this
  void findings;

  return { purchases, disposals, vehicleCosts: [], vendors: [], findings };
}
