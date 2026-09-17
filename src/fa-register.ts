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
    // Incidental-cost debits (insurer / RTO / accessory counterparty) never seed
    // acquisitions — s.43(1) makes them cost of the asset they sit against — so
    // they are split out before grouping and attached to the acquisition whose
    // first-use window contains them (nearest first use wins).
    const isCostDebit = (r: LedgerVoucherRow): boolean =>
      r.amount > 0 && COST_TYPES.some((t) => COST_VOCAB[t].test(r.counterparty));
    const seedRows = rows.filter((r) => !isCostDebit(r));
    const grouped = groupAcquisitions(ledger, seedRows, depCtx);
    for (const c of rows.filter(isCostDebit)) {
      const target = grouped
        .filter((a) => inVehicleWindow(a.firstUse, c.date))
        .sort((a, b) => (at(c.date) - at(a.firstUse)) ** 2 - (at(c.date) - at(b.firstUse)) ** 2)[0];
      if (target) {
        target.debits.push(c);
        target.cost += c.amount;
      }
      // No window-matching acquisition: the debit stays unattached. It can only
      // become an R3 row (in-use ledger); Direction A never capitalises it and
      // Directions B/C never see it either — consistent by construction.
    }
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

  // saleCredits feeds the disposal-signal pass below.

  // ---- Vehicle incidental-cost pass (D4) ----
  interface VehicleAcq { ledger: string; group: string; rows: LedgerVoucherRow[]; acq: Acquisition; }
  const vehicleAcqs: VehicleAcq[] = [];
  for (const p of perLedger) {
    if (!isVehicleAsset(p.ledger, p.group)) continue;
    for (const a of p.acquisitions) vehicleAcqs.push({ ledger: p.ledger, group: p.group, rows: p.rows, acq: a });
  }

  // B hits: debits on incidental-pattern expense ledgers inside some vehicle's window.
  // A ledger maps to exactly ONE cost type (first matching vocabulary, in COST_TYPES
  // order) so a dual-named ledger cannot double-count one debit.
  interface BHit { row: LedgerVoucherRow; ledger: string; costType: FaCostType; vehicles: VehicleAcq[]; finding?: FaFinding; }
  const bHits = new Map<string, BHit>();
  for (const { ledger, rows } of input.incidentalExpenseRows) {
    const costType = COST_TYPES.find((t) => COST_VOCAB[t].test(ledger));
    if (!costType) continue;
    for (const r of rows) {
      if (r.amount <= 0) continue;
      const vehicles = vehicleAcqs.filter((v) => inVehicleWindow(v.acq.firstUse, r.date));
      if (vehicles.length === 0) continue;
      const key = `${canon(ledger)}|${r.date}|${r.voucherNumber}|${r.amount}`;
      const existing = bHits.get(key);
      if (existing) {
        for (const v of vehicles) if (!existing.vehicles.includes(v)) existing.vehicles.push(v);
      } else {
        bHits.set(key, { row: r, ledger, costType, vehicles: [...vehicles] });
      }
    }
  }

  const push = (check: FaCheckId, ledger: string, block: string, amount: number, detail: string): void => {
    findings.push({ id: "", check, severity: SEVERITY[check], ledger, block, amount, detail });
  };

  const windowText = `${VEHICLE_WINDOW_BEFORE_DAYS} days before to ${VEHICLE_WINDOW_AFTER_DAYS} days after`;

  interface CostResolution {
    v: VehicleAcq; costType: FaCostType;
    status: "capitalised" | "expensed" | "not-found" | "none";
    amount: number; date: string | null; where: string;
    row: LedgerVoucherRow | null; ambiguous: boolean; finding?: FaFinding;
  }
  const resolutions: CostResolution[] = [];
  const emittedHits = new Set<BHit>();

  for (const v of vehicleAcqs) {
    for (const t of COST_TYPES) {
      // Direction A: capitalised — a debit on the vehicle ledger, in window, whose
      // counterparty names the cost (insurer, RTO office, accessory vendor, or an
      // expense ledger a journal transferred from).
      const aRow = v.rows.find(
        (d) => d.amount > 0 && COST_VOCAB[t].test(d.counterparty) && inVehicleWindow(v.acq.firstUse, d.date),
      ) ?? null;
      let res: CostResolution;
      if (aRow) {
        res = {
          v, costType: t, status: "capitalised", amount: aRow.amount, date: aRow.date,
          where: aRow.counterparty, row: aRow, ambiguous: false,
        };
      } else {
        // Direction B: the cost sits in an expense ledger.
        const hit = [...bHits.values()].find((h) => h.costType === t && h.vehicles.includes(v)) ?? null;
        if (hit) {
          if (!emittedHits.has(hit)) {
            emittedHits.add(hit);
            const names = [...new Set(hit.vehicles.map((x) => x.ledger))];
            const ambiguity = hit.vehicles.length > 1
              ? ` (attribution ambiguous: the window covers ${hit.vehicles.length} vehicle acquisitions — ${names.join("; ")})`
              : "";
            const f: FaFinding = {
              id: "", check: "fa_vehicle_incidental_expensed", severity: SEVERITY.fa_vehicle_incidental_expensed,
              ledger: v.ledger, block: v.group, amount: Math.abs(hit.row.amount),
              detail:
                `${t} cost of first use appears as a debit of ${money(Math.abs(hit.row.amount))} on ` +
                `${displayDate(hit.row.date)} in expense ledger ${hit.ledger}, within ${windowText} the first use on ` +
                `${displayDate(hit.vehicles[0].acq.firstUse)}: costs incidental to putting a vehicle to its first use ` +
                `form part of its actual cost under s.43(1) and belong in the vehicle's own asset ledger — ` +
                `verify and capitalise if confirmed${ambiguity}`,
            };
            findings.push(f);
            hit.finding = f;
          }
          res = {
            v, costType: t, status: "expensed", amount: Math.abs(hit.row.amount), date: hit.row.date,
            where: hit.ledger, row: hit.row, ambiguous: hit.vehicles.length > 1, finding: hit.finding,
          };
        } else if (ABSENCE_CHECKED.includes(t)) {
          // Direction C: nowhere to be found (insurance and RTO only).
          const f: FaFinding = {
            id: "", check: "fa_vehicle_incidental_missing", severity: SEVERITY.fa_vehicle_incidental_missing,
            ledger: v.ledger, block: v.group, amount: 0,
            detail:
              `no ${t} cost of first use appears in either the vehicle ledger or any ${t}-pattern expense ledger ` +
              `within ${windowText} the first use on ${displayDate(v.acq.firstUse)}: either the cost was included ` +
              `in the supplier's invoice — verify against the purchase invoice — or it was never booked`,
          };
          findings.push(f);
          res = { v, costType: t, status: "not-found", amount: 0, date: null, where: "", row: null, ambiguous: false, finding: f };
        } else {
          res = { v, costType: t, status: "none", amount: 0, date: null, where: "", row: null, ambiguous: false };
        }
      }
      resolutions.push(res);
    }
  }

  // Incidental summaries on the acquisition's first instalment. Interim form
  // here: finding ids land in the ordering pass at the end of the engine.
  const resByAcquisition = new Map<string, CostResolution[]>();
  for (const r of resolutions) {
    const key = `${canon(r.v.ledger)}|${r.v.acq.firstUse}`;
    resByAcquisition.set(key, [...(resByAcquisition.get(key) ?? []), r]);
  }
  for (const p of purchases) {
    if (p.rule !== "acquisition" || p.instalment !== 1 || !p.isVehicle) continue;
    const rs = resByAcquisition.get(`${canon(p.asset)}|${p.acquisitionDate}`) ?? [];
    if (rs.length === 0) continue;
    p.incidentalSummary = COST_TYPES.map((t) => {
      const r = rs.find((x) => x.costType === t);
      return `${t}: ${r ? r.status : "none"}`;
    }).join("; ");
  }

  // ---- Vehicle vendor pass (D7) ----
  const vendors: FaResult["vendors"] = [];
  const vendorAgg = new Map<string, { vendor: string; vehicles: string[]; total: number }>();
  for (const v of vehicleAcqs) {
    const name = v.acq.counterparty.trim();
    if (!name) continue;
    const key = canon(name);
    const e = vendorAgg.get(key) ?? { vendor: name, vehicles: [], total: 0 };
    if (!e.vehicles.some((n) => canon(n) === canon(v.ledger))) e.vehicles.push(v.ledger);
    e.total = round2(e.total + Math.max(0, v.acq.cost - v.acq.netted));
    vendorAgg.set(key, e);
  }
  for (const e of vendorAgg.values()) {
    const closing = ctx.closingBalanceOf(e.vendor);
    const side = sideOf(closing);
    const squaredOff = Math.abs(closing) <= ZERO_TOLERANCE;
    if (!squaredOff) {
      push(
        "fa_vehicle_vendor_unsettled", e.vendor, "", Math.abs(closing),
        `the supplier's ledger closes the period on ${displayDate(ctx.toDate)} with a ${side} balance of ` +
          `${money(Math.abs(closing))} (acquisitions of ${money(e.total)} for ${e.vehicles.join("; ")}): ` +
          `obtain the vendor's ledger statement and reconcile`,
      );
    }
    vendors.push({
      vendor: e.vendor, vehicles: e.vehicles, acquisitionsTotal: e.total,
      closingBalance: closing, side, squaredOff, findingId: "",
    });
  }

  // ---- Disposal-signal pass (depreciation design §9) ----
  for (const { ledger, rows } of input.disposalSignals) {
    for (const r of rows) {
      const amount = Math.abs(r.amount);
      if (amount < 0.005) continue;
      const matched = saleCredits.some((s) => s.date === r.date && Math.abs(s.amount - amount) < 0.005);
      disposals.push({
        date: r.date, asset: "", block: "", counterparty: ledger, amount,
        voucherType: r.voucherType, voucherNumber: r.voucherNumber, reference: r.reference,
        kind: "disposal-signal", rule: "§9",
        note: matched ? "matched to an asset-ledger credit" : "no matching credit in any asset ledger",
      });
      if (!matched) {
        push(
          "fa_disposal_unmatched", ledger, "", amount,
          `disposal proceeds of ${money(amount)} on ${displayDate(r.date)} credited to this ledger have no ` +
            `matching credit in any asset ledger: the asset removed cannot be identified from the books — ` +
            `verify against the disposal proof`,
        );
      }
    }
  }

  return { purchases, disposals, vehicleCosts: [], vendors, findings };
}
