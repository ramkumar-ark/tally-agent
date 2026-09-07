import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Downstream } from "../../src/downstream.js";
import {
  makeDownstream,
  type RawCaller,
} from "../../src/downstream.js";

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL("./tally-responses.json", import.meta.url)), "utf8"),
) as Record<string, string>;

export function fakeDownstream(
  overrides: Record<string, string> = {},
): Downstream & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const caller: RawCaller = async (tool, args) => {
    calls.push({ tool, args });
    const body = overrides[tool] ?? raw[tool];
    if (body === undefined) throw new Error(`fake downstream has no fixture for ${tool}`);
    return body;
  };
  return Object.assign(makeDownstream(caller, async () => {}), { calls });
}
