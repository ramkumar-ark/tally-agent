import { readFileSync } from "node:fs";
import { EMPTY_OVERRIDES, type Overrides } from "./classify.js";

export function loadOverrides(path: string): Overrides {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
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
