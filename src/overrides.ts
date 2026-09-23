import { readFileSync } from "node:fs";
import { EMPTY_OVERRIDES, type Overrides } from "./classify.js";
import { canonicalKey } from "./key.js";
import { EMPTY_WRONG_GROUP, type WrongGroupConfig } from "./types.js";

/**
 * A missing overrides file is legitimate — most companies need none — so it
 * is not fatal. It is reported through `warn` all the same: the file is the
 * only escape hatch for a group name the classifier's allowlist has never
 * seen, and an unreadable path silently degrading to "no overrides" is how a
 * Windows path bug hid for a whole milestone. Malformed JSON still throws:
 * an override the operator wrote and believes is in force must never be
 * skipped quietly.
 */
export function loadOverrides(path: string, warn?: (why: string) => void): Overrides {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: unknown) {
    warn?.((e as NodeJS.ErrnoException)?.code ?? "unreadable");
    return EMPTY_OVERRIDES;
  }
  const raw = JSON.parse(text) as Partial<Overrides> & { pfEsiLedgers?: unknown };
  return {
    forceMaskLedgers: raw.forceMaskLedgers ?? [],
    forceClearLedgers: raw.forceClearLedgers ?? [],
    forceMaskGroups: raw.forceMaskGroups ?? [],
    forceClearGroups: raw.forceClearGroups ?? [],
    ...(pfEsiLedgers(raw.pfEsiLedgers) ?? {}),
  };
}

/**
 * The `pfEsiLedgers` key: `{ "pf": [...ledger names], "esi": [...] }`.
 * Per design Q4, an explicit entry replaces the fund-ledger heuristic for
 * that fund — an explicit empty array (e.g. `{"PF": []}`) means "this fund
 * has no payable ledger" and REPLACES the heuristic wholesale; only a
 * MISSING key is "unset" for its fund, and only the whole key absent, its
 * value `null`, or an empty `{}` (no pf/esi keys at all) is unset overall.
 * An operator override believed in force must never be skipped quietly, so
 * a malformed entry throws — and never echoes a ledger name, which may be
 * company-internal.
 */
function pfEsiLedgers(
  raw: unknown,
): { pfEsiLedgers: { pf: string[]; esi: string[] } } | null {
  if (raw === undefined || raw === null) return null;
  const out: { pf?: string[]; esi?: string[] } = {};
  const bad = (list: string): Error =>
    new Error(`overrides: pfEsiLedgers.${list} must be a list of ledger names from the company's books`);
  if (typeof raw !== "object") throw bad("pf/esi");
  for (const list of ["pf", "esi"] as const) {
    const value = (raw as Record<string, unknown>)[list];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw bad(list);
    const names = value.map((n) => String(n ?? "").trim()).filter((n) => n !== "");
    if (names.length !== value.length) throw bad(list);
    out[list] = names;
  }
  return out.pf === undefined && out.esi === undefined
    ? null
    : { pfEsiLedgers: out as { pf: string[]; esi: string[] } };
}

/**
 * The same key read by path, for tb_pf_esi_review's optional per-call
 * overrides channel: an unreadable path fades out (already warned about via
 * `warn`), like loadOverrides; malformed JSON throws, like loadWrongGroup.
 */
export function loadPfEsiLedgers(
  path: string,
  warn?: (why: string) => void,
): { pf: string[]; esi: string[] } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: unknown) {
    warn?.((e as NodeJS.ErrnoException)?.code ?? "unreadable");
    return undefined;
  }
  const raw = JSON.parse(text) as { pfEsiLedgers?: unknown };
  return pfEsiLedgers(raw.pfEsiLedgers)?.pfEsiLedgers;
}

const KEYWORD_LISTS = ["expense", "income", "party", "bank", "capital", "loan", "neutral"] as const;

/**
 * The "wrongGroup" key of the same overrides file: operator tuning for the
 * ledger_in_wrong_group check. An unreadable file yields no tuning without a
 * second warning — loadOverrides has already reported that path. Malformed
 * JSON throws, and so does a keyword that could never match one name token:
 * tuning the operator believes is in force must never be skipped quietly.
 * Errors never echo a keyword, which may be a company-internal name.
 */
export function loadWrongGroup(path: string): WrongGroupConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return EMPTY_WRONG_GROUP;
  }
  const raw = (JSON.parse(text) as { wrongGroup?: Partial<WrongGroupConfig> }).wrongGroup ?? {};
  const keywords: WrongGroupConfig["keywords"] = {};
  for (const [list, words] of Object.entries(raw.keywords ?? {})) {
    if (!(KEYWORD_LISTS as readonly string[]).includes(list)) {
      throw new Error(`overrides: wrongGroup.keywords has an unknown list "${list}"`);
    }
    const canonical = (words ?? []).map(canonicalKey);
    if (canonical.some((w) => !/^[a-z0-9]+$/.test(w))) {
      throw new Error(`overrides: every wrongGroup.keywords.${list} entry must be one word of letters and digits`);
    }
    keywords[list as keyof WrongGroupConfig["keywords"]] = canonical;
  }
  return { ignoreLedgers: raw.ignoreLedgers ?? [], keywords };
}
