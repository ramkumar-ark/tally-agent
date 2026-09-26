import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { writeD3Bundle } from "./fixtures/dep3cd-fixture.js";

// Whole-name-only rule (AGENTS.md, check 8): a finding may quote a ledger's
// whole name, never a fragment of it. These secrets are asset/party ledgers
// that must appear masked; the fragments catch a partial leak.
const SECRETS = [
  "Mixer Unit",
  "Site Van",
  "Store Box",
  "Pump Set",
  "Old Loader",
  "Old Tractor",
  "Notebook PC",
  "Desk Set",
  "Buyer One",
  "Mixer",
  "Tractor",
  "Buyer",
];

const rejectWith = (why: string) => async () => {
  throw new Error(why);
};

function offlineHarness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _d, _s, handler) => tools.set(name, handler);
  const stub = Object.assign(fakeDownstream(), {
    groups: rejectWith("no live tally"),
    ledgers: rejectWith("no live tally"),
  } as never);
  const session = createSession(stub, EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "dep3cd-leak-")), dayBookMaxBytes: 64 * 1_048_576 };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, cfg };
}

describe("dep3cd review never leaks a real ledger name", () => {
  it("keeps every asset and party ledger (and fragment) out of the result JSON", async () => {
    const h = offlineHarness();
    const dir = await mkdtemp(join(tmpdir(), "dep3cd-leak-bundle-"));
    const dp = writeD3Bundle(dir);
    const out = await h.tools.get("tb_dep3cd_review")!({
      company: "Demo Co",
      fromDate: "20250401",
      toDate: "20260331",
      dayBookPath: dp,
    });
    for (const secret of SECRETS) {
      expect(out).not.toContain(secret);
    }
    const result = JSON.parse(out);
    for (const f of result.findings) {
      expect(typeof f.detail).toBe("string");
      for (const secret of SECRETS) {
        expect(f.detail).not.toContain(secret);
      }
    }
  });
});