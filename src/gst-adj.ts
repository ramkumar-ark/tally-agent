import { canonicalKey } from "./key.js";
import type { VoucherEntry, VoucherRow } from "./downstream.js";
import type { GstAdjConfig } from "./gst-adj-config.js";
import type { ThreeBSummary } from "./gst-adj-3b.js";
import type { Itc2bEntry } from "./gst-adj-2b.js";

export type Role = string;
export type MonthMovements = Map<string, Map<Role, number>>;

export interface GadjEntry {
  kind: number; month: string; date: string; narration: string;
  legs: Array<{ dr: string; cr: string; amount: number }>;
}
export interface GadjFinding { id: string; severity: "warning" | "review"; detail: string; }
export interface GstAdjResult { entries: GadjEntry[]; findings: GadjFinding[]; }

export function booksMovements(
  vouchers: VoucherRow[],
  roleOf: (ledger: string) => Role | undefined,
  months?: string[],
): MonthMovements {
  const result: MonthMovements = new Map();
  if (months) {
    for (const m of months) result.set(m, new Map());
  }
  for (const v of vouchers) {
    const month = `${String(v.date).slice(0, 4)}-${String(v.date).slice(4, 6)}`;
    let monthMap = result.get(month);
    if (!monthMap) { monthMap = new Map(); result.set(month, monthMap); }
    for (const entry of v.entries) {
      const role = roleOf(entry.ledger);
      if (role !== undefined) {
        monthMap.set(role, (monthMap.get(role) ?? 0) + entry.amount);
      }
    }
  }
  return result;
}

export function roleResolver(config: GstAdjConfig): (ledger: string) => Role | undefined {
  const keyToRoles = new Map<string, string[]>();
  for (const [head, roles] of Object.entries(config.heads)) {
    for (const [role, ledgerName] of Object.entries(roles)) {
      const key = canonicalKey(ledgerName);
      if (!keyToRoles.has(key)) keyToRoles.set(key, []);
      keyToRoles.get(key)!.push(`${head}.${role}`);
    }
  }
  for (const [key, roles] of keyToRoles) {
    if (roles.length > 1) {
      throw new Error(`gst-adj roleResolver: ledger matches multiple roles — ${roles.join(", ")}`);
    }
  }
  const lookup = new Map<string, Role>();
  for (const [head, roles] of Object.entries(config.heads)) {
    for (const [role, ledgerName] of Object.entries(roles)) {
      lookup.set(canonicalKey(ledgerName), role);
    }
  }
  return (ledger: string): Role | undefined => lookup.get(canonicalKey(ledger));
}

const TOLERANCE = 1;
const HEAD_ORDER = ["igst", "cgst", "sgst", "cess"] as const;

function* monthIterator(months: string[]) {
  for (const m of months) {
    const year = Number(m.slice(0, 4));
    const monthIdx = Number(m.slice(5, 7)) - 1;
    const date = new Date(Date.UTC(year, monthIdx + 1, 0));
    const dateStr = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
    const monthName = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const yearStr = String(year);
    yield { month: m, date: dateStr, monthName, yearStr };
  }
}

function pushEntry(
  result: GadjEntry[], kind: number, month: string, date: string, narration: string,
  legs: Array<{ dr: string; cr: string; amount: number }>,
) {
  const merged = new Map<string, { dr: string; cr: string; amount: number }>();
  for (const leg of legs) {
    const key = `${leg.dr}|${leg.cr}`;
    const existing = merged.get(key);
    if (existing) { existing.amount += leg.amount; }
    else { merged.set(key, { ...leg }); }
  }
  const finalLegs = Array.from(merged.values()).filter((l) => Math.abs(l.amount) > TOLERANCE);
  if (finalLegs.length === 0) return;
  result.push({ kind, month, date, narration, legs: finalLegs });
}

export function analyzeGstAdj(input: {
  threeB: ThreeBSummary; movements: MonthMovements; config: GstAdjConfig;
  listDiffs?: Record<string, { newly: Itc2bEntry[]; dropped: Itc2bEntry[] }>;
  knownLedgers?: Set<string>;
}): GstAdjResult {
  const { threeB, movements, config } = input;
  const result: GstAdjResult = { entries: [], findings: [] };

  for (const { month, date, monthName, yearStr } of monthIterator(threeB.months)) {
    const kind1Legs: Array<{ dr: string; cr: string; amount: number }> = [];
    for (const h of HEAD_ORDER) {
      const amount = threeB.outwardTax[month]?.[h] ?? 0;
      if (amount > TOLERANCE) {
        const outputLedger = config.heads[h]?.output;
        const payableLedger = config.heads[h]?.payable;
        if (outputLedger && payableLedger) {
          kind1Legs.push({ dr: outputLedger, cr: payableLedger, amount });
          const mv = movements.get(month);
          const booksOut = mv ? -(mv.get(outputLedger) ?? 0) : 0;
          if (Math.abs(booksOut - amount) > TOLERANCE) {
            result.findings.push({
              id: "gadj_3b_ledger_mismatch", severity: "warning",
              detail: `${outputLedger}: books ${booksOut} vs 3B ${amount}`,
            });
          }
          if (booksOut > TOLERANCE) {
            result.findings.push({
              id: "gadj_3b_ledger_mismatch", severity: "review",
              detail: `${outputLedger}: books ${booksOut}`,
            });
          }
        }
      }
    }
    if (kind1Legs.length > 0) {
      pushEntry(result.entries, 1, month, date, `being output gst for the month ${monthName} ${yearStr}`, kind1Legs);
    }

    const kind2Legs: Array<{ dr: string; cr: string; amount: number }> = [];
    for (const h of HEAD_ORDER) {
      const amount = threeB.netItc[month]?.[h] ?? 0;
      if (amount > TOLERANCE) {
        const payableLedger = config.heads[h]?.payable;
        const inputLedger = config.heads[h]?.input;
        if (payableLedger && inputLedger) {
          kind2Legs.push({ dr: payableLedger, cr: inputLedger, amount });
        }
      }
    }
    if (kind2Legs.length > 0) {
      pushEntry(result.entries, 2, month, date, `being input gst for the month ${monthName} ${yearStr}`, kind2Legs);
    }
  }

  return result;
}
