import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { writeD3Bundle, D3_GROUPS, D3_LEDGERS } from "./fixtures/dep3cd-fixture.js";

const rejectWith = (why: string) => async () => {
  throw new Error(why);
};

/** A session whose live calls reject (offline day-book runs). */
function offlineHarness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const schemas = new Map<string, Record<string, unknown>>();
  const registrar: ToolRegistrar = (name, _d, schema, handler) => {
    tools.set(name, handler);
    schemas.set(name, schema);
  };
  const stub = Object.assign(fakeDownstream(), {
    groups: rejectWith("no live tally"),
    ledgers: rejectWith("no live tally"),
  } as never);
  const session = createSession(stub, EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "dep3cd-tools-")), dayBookMaxBytes: 64 * 1_048_576 };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, schemas, session, cfg };
}

describe("dep3cd tool surface", () => {
  it("registers the clause-18 quadruple", () => {
    const { tools } = offlineHarness();
    for (const name of [
      "tb_write_dep3cd_template",
      "tb_dep3cd_review",
      "tb_write_3cd_depreciation",
      "tb_write_dep3cd_report",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("tb_write_3cd_depreciation requires a sourcePath and leaves outPath optional", () => {
    const { schemas } = offlineHarness();
    const s = schemas.get("tb_write_3cd_depreciation")!;
    expect(s.sourcePath).toBeDefined();
    expect((s.sourcePath as any).safeParse(undefined).success).toBe(false);
    expect((s.sourcePath as any).safeParse("/tmp/book.xlsm").success).toBe(true);
    expect((s.outPath as any).safeParse(undefined).success).toBe(true);
  });
});

describe("tb_write_dep3cd_template", () => {
  it("refuses a run with no day-book path", async () => {
    const { tools } = offlineHarness();
    await expect(tools.get("tb_write_dep3cd_template")!({})).rejects.toThrow(/pass dayBookPath/);
  });

  it("writes the template into outDir and reports group and ledger counts", async () => {
    const h = offlineHarness();
    const dir = await mkdtemp(join(tmpdir(), "dep3cd-bundle-"));
    const dp = writeD3Bundle(dir);
    const out = JSON.parse(
      await h.tools.get("tb_write_dep3cd_template")!({
        company: "Demo Co",
        dayBookPath: dp,
        outDir: h.cfg.reportDir,
      }),
    );
    expect(out.templatePath).toMatch(/dep3cd-operator-template-demo-co-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(existsSync(out.templatePath)).toBe(true);
    expect(out.groups).toBe(D3_GROUPS.length);
    expect(out.ledgers).toBe(D3_LEDGERS.length);
    // Ledger names never ride the model envelope.
    expect(out.templatePath).not.toContain("Site Van");
  });
});