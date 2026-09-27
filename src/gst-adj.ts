import { canonicalKey } from "./key.js";
import type { VoucherEntry, VoucherRow } from "./downstream.js";
import type { GstAdjConfig } from "./gst-adj-config.js";

export type Role = string;
export type MonthMovements = Map<string, Map<Role, number>>;

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
