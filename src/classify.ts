import { canonicalKey } from "./key.js";
import type { GroupNode, GroupRole, MaskPolicy } from "./types.js";

export interface Overrides {
  forceMaskLedgers: string[];
  forceClearLedgers: string[];
  forceMaskGroups: string[];
  forceClearGroups: string[];
}

export const EMPTY_OVERRIDES: Overrides = {
  forceMaskLedgers: [],
  forceClearLedgers: [],
  forceMaskGroups: [],
  forceClearGroups: [],
};

/** Tally's predefined primary groups. */
export const PRIMARY_GROUPS = [
  "Branch / Divisions",
  "Capital Account",
  "Current Assets",
  "Current Liabilities",
  "Direct Expenses",
  "Direct Incomes",
  "Fixed Assets",
  "Indirect Expenses",
  "Indirect Incomes",
  "Investments",
  "Loans (Liability)",
  "Misc. Expenses (ASSET)",
  "Purchase Accounts",
  "Sales Accounts",
  "Suspense A/c",
] as const;

/**
 * Tally's internal "root of primaries" node: the PARENT field on a real
 * primary group (e.g. Current Liabilities) is not empty, it is this literal
 * control character followed by " Primary" — verified against a live
 * company. Treated as a root terminator exactly like an empty parent, so a
 * primary group's ancestry does not grow a phantom trailing node.
 */
const ROOT_OF_PRIMARIES = " Primary";

/**
 * Groups whose descendants are left unmasked. Everything else masks,
 * including anything not listed here at all. See design doc section 4.2.
 *
 * Real-data note: a live company was seen parking operational sub-groups
 * (SALARY, Wages, SITE EXPENSES, MATERIAL PURCHASES, SUB CONTRACTORS, ...)
 * directly under Sundry Creditors. None of those names are in this list, so
 * they mask correctly by ancestry with no special-casing needed — exactly
 * the case default-mask exists for.
 */
export const CLEAR_ROOTS = [
  "Sales Accounts",
  "Purchase Accounts",
  "Direct Expenses",
  "Indirect Expenses",
  "Direct Incomes",
  "Indirect Incomes",
  "Duties & Taxes",
  "Stock-in-Hand",
  "Cash-in-Hand",
  "Reserves & Surplus",
  "Provisions",
  "Suspense A/c",
  "Misc. Expenses (ASSET)",
] as const;

const ROLE_BY_GROUP: ReadonlyArray<readonly [string, GroupRole]> = [
  ["Sundry Debtors", "debtor"],
  ["Sundry Creditors", "creditor"],
  ["Bank Accounts", "bank"],
  ["Bank OD A/c", "bank_od"],
  ["Cash-in-Hand", "cash"],
  ["Direct Expenses", "expense"],
  ["Indirect Expenses", "expense"],
  ["Purchase Accounts", "expense"],
  ["Direct Incomes", "income"],
  ["Indirect Incomes", "income"],
  ["Sales Accounts", "income"],
  ["Stock-in-Hand", "stock"],
  ["Suspense A/c", "suspense"],
  ["Capital Account", "capital"],
  ["Duties & Taxes", "duties"],
];

const norm = canonicalKey;

export interface Classifier {
  ancestry(group: string): string[];
  rootOf(group: string): string | null;
  maskPolicy(group: string): MaskPolicy;
  role(group: string): GroupRole;
  isPrimaryGroup(group: string): boolean;
  /** Mask policy for one ledger, applying ledger-level overrides first. */
  ledgerPolicy(ledger: string, group: string): MaskPolicy;
}

export function buildClassifier(
  groups: GroupNode[],
  overrides: Overrides = EMPTY_OVERRIDES,
): Classifier {
  const parentOf = new Map<string, string>();
  for (const g of groups) {
    parentOf.set(norm(g.name), g.parent === ROOT_OF_PRIMARIES ? "" : g.parent);
  }

  const primary = new Set(PRIMARY_GROUPS.map(norm));
  const clearRoots = new Set(CLEAR_ROOTS.map(norm));
  const roleByGroup = new Map(ROLE_BY_GROUP.map(([g, r]) => [norm(g), r]));

  const fmGroups = new Set(overrides.forceMaskGroups.map(norm));
  const fcGroups = new Set(overrides.forceClearGroups.map(norm));
  const fmLedgers = new Set(overrides.forceMaskLedgers.map(norm));
  const fcLedgers = new Set(overrides.forceClearLedgers.map(norm));

  function ancestry(group: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = group;
    while (cur && !seen.has(norm(cur))) {
      seen.add(norm(cur));
      chain.push(cur);
      cur = parentOf.get(norm(cur)) ?? "";
    }
    return chain;
  }

  function rootOf(group: string): string | null {
    for (const g of ancestry(group)) {
      if (primary.has(norm(g))) return g;
    }
    return null;
  }

  function maskPolicy(group: string): MaskPolicy {
    for (const g of ancestry(group)) {
      if (fcGroups.has(norm(g))) return "clear";
      if (fmGroups.has(norm(g))) return "mask";
    }
    for (const g of ancestry(group)) {
      if (clearRoots.has(norm(g))) return "clear";
    }
    return "mask";
  }

  function ledgerPolicy(ledger: string, group: string): MaskPolicy {
    if (fcLedgers.has(norm(ledger))) return "clear";
    if (fmLedgers.has(norm(ledger))) return "mask";
    return maskPolicy(group);
  }

  function role(group: string): GroupRole {
    for (const g of ancestry(group)) {
      const r = roleByGroup.get(norm(g));
      if (r) return r;
    }
    return "other";
  }

  function isPrimaryGroup(group: string): boolean {
    return primary.has(norm(group));
  }

  return { ancestry, rootOf, maskPolicy, role, isPrimaryGroup, ledgerPolicy };
}
