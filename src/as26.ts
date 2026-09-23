import { readFileSync } from "node:fs";
import { canonicalKey } from "./key.js";
import type { As26File, As26Kind } from "./as26-file.js";

export interface BooksDeduction { ledgerKey: string; kind: As26Kind; date: string; tax: number; voucherType: string; }
export interface BooksSale { ledgerKey: string; date: string; ref: string | null; taxable: number; gross: number; }
export interface BooksFacts { deductions: BooksDeduction[]; sales: BooksSale[]; }

export interface PartyMatch {
  ledgerKey: string; ledgerName: string;
  as26NameKey: string; as26Name: string;
  kind: As26Kind; source: "operator";
}
export interface As26Gap { kind: As26Kind; nameKey: string; name: string; tax: number; ledger?: string; reason: "unmapped" | "ambiguous" | "ledger-absent" | "name-absent"; }

export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Stage-1 party matching — mapping-only policy (captain deviation): operator
 * entries join exactly; unmapped names and ledgers surface as gaps, never
 * auto-matched. Canonical collisions cannot arise where there is no fallback. */
export function matchParties(
  file: As26File, facts: BooksFacts, map: As26Map, ledgerNames: string[],
): { matches: PartyMatch[]; gaps: As26Gap[] } {
  const matches: PartyMatch[] = [];
  const gaps: As26Gap[] = [];
  const ledgerByKey = new Map(ledgerNames.map((n) => [canonicalKey(n), n]));
  const matchedLedgerKeys = new Set<string>();
  const matchedNameKeys = new Set<string>();

  const deductors = new Map<string, { kind: As26Kind; nameKey: string; name: string; tax: number }>();
  for (const s of file.summaries) {
    const k = `${s.kind}|${s.nameKey}`;
    const d = deductors.get(k);
    if (d) d.tax = round2(d.tax + s.taxTotal);
    else deductors.set(k, { kind: s.kind, nameKey: s.nameKey, name: s.name, tax: s.taxTotal });
  }

  for (const m of map.mappings) {
    const lk = canonicalKey(m.ledger), nk = canonicalKey(m.as26Name);
    const ledger = ledgerByKey.get(lk);
    const summary = file.summaries.find((s) => s.nameKey === nk);
    const kind: As26Kind = summary?.kind ?? "tds";
    if (!ledger) {
      gaps.push({ kind, nameKey: nk, name: m.as26Name, tax: summary?.taxTotal ?? 0, ledger: m.ledger, reason: "ledger-absent" });
      continue;
    }
    if (!summary) {
      gaps.push({ kind, nameKey: nk, name: m.as26Name, tax: 0, ledger: m.ledger, reason: "name-absent" });
      continue;
    }
    matchedLedgerKeys.add(lk);
    matchedNameKeys.add(`${summary.kind}|${nk}`);
    matches.push({ ledgerKey: lk, ledgerName: m.ledger, as26NameKey: nk, as26Name: m.as26Name, kind: summary.kind, source: "operator" });
  }

  for (const d of deductors.values()) {
    if (matchedNameKeys.has(`${d.kind}|${d.nameKey}`)) continue;
    gaps.push({ kind: d.kind, nameKey: d.nameKey, name: d.name, tax: d.tax, reason: "unmapped" });
  }
  const dedTax = new Map<string, { tax: number; kind: As26Kind }>();
  for (const e of facts.deductions) {
    if (matchedLedgerKeys.has(e.ledgerKey)) continue;
    const acc = dedTax.get(e.ledgerKey);
    if (acc) acc.tax = round2(acc.tax + e.tax);
    else dedTax.set(e.ledgerKey, { tax: e.tax, kind: e.kind });
  }
  for (const [ledgerKey, acc] of dedTax) {
    const name = ledgerByKey.get(ledgerKey) ?? ledgerKey;
    gaps.push({ kind: acc.kind, nameKey: ledgerKey, name, tax: acc.tax, ledger: name, reason: "unmapped" });
  }
  return { matches, gaps };
}

export interface As26MapEntry { ledger: string; as26Name: string; }
export interface As26Map { mappings: As26MapEntry[]; }
export const EMPTY_AS26_MAP: As26Map = { mappings: [] };

/**
 * The persistent operator party mapping — the overrides.json precedent: a
 * missing file is legitimate (matching proceeds mapping-only), malformed JSON
 * or a malformed entry throws, and every error cites the entry index because
 * a mapping the operator believes is in force must never be skipped quietly.
 * Values are never echoed: they are company names.
 */
export function loadAs26Map(path: string, warn?: (why: string) => void): As26Map {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: unknown) {
    warn?.((e as NodeJS.ErrnoException)?.code ?? "unreadable");
    return EMPTY_AS26_MAP;
  }
  let raw: { mappings?: Array<{ ledger?: unknown; as26Name?: unknown }> };
  try {
    raw = JSON.parse(text) as { mappings?: Array<{ ledger?: unknown; as26Name?: unknown }> };
  } catch {
    throw new Error("as26-map: malformed JSON");
  }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.mappings)) {
    throw new Error("as26-map: malformed JSON — expected an object with a mappings array");
  }
  const mappings: As26MapEntry[] = [];
  const seenLedger = new Set<string>();
  const seenName = new Set<string>();
  (raw.mappings ?? []).forEach((m, i) => {
    const ledger = typeof m.ledger === "string" ? m.ledger.trim() : "";
    const as26Name = typeof m.as26Name === "string" ? m.as26Name.trim() : "";
    if (!ledger || !as26Name) {
      throw new Error(`as26-map entry ${i + 1}: "ledger" and "as26Name" must both be non-empty strings`);
    }
    const lk = canonicalKey(ledger), nk = canonicalKey(as26Name);
    if (seenLedger.has(lk) || seenName.has(nk)) {
      throw new Error(`as26-map entry ${i + 1}: maps a ledger or 26AS name already mapped earlier in the file`);
    }
    seenLedger.add(lk); seenName.add(nk);
    mappings.push({ ledger, as26Name });
  });
  return { mappings };
}
