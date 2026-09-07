import { canonicalKey } from "./key.js";
import type { GroupRole } from "./types.js";

const ROLE_LABEL: Record<GroupRole, string> = {
  debtor: "Debtor",
  creditor: "Creditor",
  bank: "Bank",
  bank_od: "Bank OD",
  cash: "Cash",
  expense: "Ledger",
  income: "Ledger",
  stock: "Stock",
  suspense: "Suspense",
  capital: "Capital",
  duties: "Ledger",
  other: "Ledger",
};

export interface Vault {
  pseudonym(real: string, role: GroupRole): string;
  resolve(alias: string): string | undefined;
  entries(): Array<{ real: string; alias: string }>;
}

export function createVault(): Vault {
  const aliasByReal = new Map<string, string>();
  const realByAlias = new Map<string, string>();
  // realByAlias is keyed by lowercased alias for case-insensitive resolve();
  // this keeps the original-cased alias so entries() can reproduce the exact
  // text that appears in masked findings and report bodies.
  const aliasCaseByKey = new Map<string, string>();
  const counters = new Map<string, number>();

  function pseudonym(real: string, role: GroupRole): string {
    const key = canonicalKey(real);
    const existing = aliasByReal.get(key);
    if (existing) return existing;

    const label = ROLE_LABEL[role];
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    const alias = `${label} ${n}`;

    aliasByReal.set(key, alias);
    const aliasKey = canonicalKey(alias);
    realByAlias.set(aliasKey, real);
    aliasCaseByKey.set(aliasKey, alias);
    return alias;
  }

  return {
    pseudonym,
    resolve: (alias) => realByAlias.get(canonicalKey(alias)),
    entries: () =>
      [...realByAlias.entries()].map(([aliasKey, real]) => ({
        real,
        alias: aliasCaseByKey.get(aliasKey)!,
      })),
  };
}
