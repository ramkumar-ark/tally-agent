import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

function harness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _desc, _schema, handler) => {
    tools.set(name, handler);
  };
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "tally-agent-")) };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, session, cfg };
}

describe("tool surface", () => {
  it("exposes exactly the four approved tools", () => {
    const { tools } = harness();
    expect([...tools.keys()].sort()).toEqual([
      "tb_ledger_activity",
      "tb_list_companies",
      "tb_review",
      "tb_write_report",
    ]);
  });

  it("does not expose the ledger master tool that returns bank and address details", () => {
    const { tools } = harness();
    expect(tools.has("tally_get_ledger")).toBe(false);
  });
});

describe("tb_review", () => {
  it("returns masked findings as JSON", async () => {
    const { tools } = harness();
    const out = await tools.get("tb_review")!({ asOnDate: "20260331" });
    const parsed = JSON.parse(out);
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(out).not.toContain("50200012345678");
  });
});

describe("tb_write_report", () => {
  it("writes both artifacts and reports their paths", async () => {
    const { tools } = harness();
    await tools.get("tb_review")!({ asOnDate: "20260331", company: "Demo Traders Pvt Ltd" });
    const out = await tools.get("tb_write_report")!({
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: "# Review",
    });
    const parsed = JSON.parse(out);
    expect(parsed.markdownPath).toMatch(/\.md$/);
    expect(parsed.csvPath).toMatch(/\.csv$/);
  });

  it("refuses when no review has been run", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_write_report")!({
        company: "Demo",
        asOnDate: "20260331",
        markdown: "# Review",
      }),
    ).rejects.toThrow(/run tb_review first/i);
  });
});
