import { readFileSync } from "node:fs";
import { EMPTY_OVERRIDES, type Overrides } from "./classify.js";

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
  const raw = JSON.parse(text) as Partial<Overrides>;
  return {
    forceMaskLedgers: raw.forceMaskLedgers ?? [],
    forceClearLedgers: raw.forceClearLedgers ?? [],
    forceMaskGroups: raw.forceMaskGroups ?? [],
    forceClearGroups: raw.forceClearGroups ?? [],
  };
}
