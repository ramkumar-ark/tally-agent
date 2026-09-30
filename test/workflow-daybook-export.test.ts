import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import {
  registerWorkflowTools,
  resolveUpstreamScript,
  type SpawnDayBookExport,
} from "../src/workflow.js";

const PARAMS = {
  company: "Workflow Test Co",
  fromDate: "20250401",
  toDate: "20260331",
  asOnDate: "20260331",
};

const GOOD_DAYBOOK = JSON.stringify({
  company: "Workflow Test Co",
  fromDate: "20250401",
  toDate: "20260331",
  vouchers: [
    {
      date: "20250415",
      voucherType: "Receipt",
      voucherNumber: "1",
      partyLedgerName: "Cash",
      entries: [],
    },
  ],
});

interface Harness {
  tools: Map<string, (args: any) => Promise<string>>;
  cfg: { reportDir: string; dayBookMaxBytes: number; downstreamArgs?: string[] };
  calls: Array<{ tool: string; args: any }>;
  spawnCalls: Array<Record<string, string>>;
  setSpawn(fn: SpawnDayBookExport): void;
  start: () => Promise<any>;
  exportDaybook: (workflowId: string) => Promise<any>;
}

function harness(): Harness {
  const calls: Array<{ tool: string; args: any }> = [];
  const fake = new Map<string, (args: any) => Promise<string>>();
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _d, _s, h) => tools.set(name, h);
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  const reportDir = mkdtempSync(join(tmpdir(), "wf-dbx-"));
  const cfg = { reportDir, dayBookMaxBytes: 64 * 1024 * 1024 };
  const spawnCalls: Array<Record<string, string>> = [];
  const spawnCallsSpy: SpawnDayBookExport = async (spec) => {
    spawnCalls.push({ ...spec });
    writeFileSync(spec.out, GOOD_DAYBOOK, "utf8");
    return { code: 0, stderr: "" };
  };
  let spawnImpl: SpawnDayBookExport = spawnCallsSpy;
  registerWorkflowTools(
    registrar,
    {
      call: async (name, args) => {
        const handler = fake.get(name);
        if (!handler) throw new Error(`fake harness: no handler for ${name}`);
        calls.push({ tool: name, args });
        return handler(args);
      },
      session,
      cfg,
      sessionId: "20260331T100000Z",
      audit: async () => {},
    },
    { spawnDayBookExport: (spec) => spawnImpl(spec) },
  );

  // A generated template fake: writes a file and returns its path.
  const templateFake = (name: string) => async (args: any) => {
    const dir: string = args.outDir ?? args.outPath;
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${name}.xlsx`);
    await writeFile(p, "template", "utf8");
    return JSON.stringify({ templatePath: p });
  };
  fake.set("tb_write_tds_template", templateFake("tds-template"));
  fake.set("tb_write_pf_esi_template", templateFake("pf-esi-template"));
  fake.set("tb_list_companies", async () => JSON.stringify([]));

  return {
    tools,
    cfg,
    calls,
    spawnCalls,
    setSpawn: (fn) => {
      spawnImpl = fn;
    },
    start: async () =>
      JSON.parse(
        await tools.get("tb_audit_workflow_start")!({
          company: PARAMS.company,
          fromDate: PARAMS.fromDate,
          toDate: PARAMS.toDate,
        }),
      ),
    exportDaybook: async (workflowId: string) =>
      JSON.parse(await tools.get("tb_audit_workflow_export_daybook")!({ workflowId })),
  };
}

const inputRow = (parsed: any, key: string) => parsed.inputs.find((i: any) => i.key === key);

describe("resolveUpstreamScript", () => {
  it("picks the .js entry among the downstream args", () => {
    expect(resolveUpstreamScript(["node", "F:\\upstream\\dist\\index.js", "--verbose"])).toBe(
      "F:\\upstream\\dist\\index.js",
    );
    expect(resolveUpstreamScript(["/opt/upstream/dist/index.js"])).toBe("/opt/upstream/dist/index.js");
  });

  it("returns undefined when no .js argument exists", () => {
    expect(resolveUpstreamScript([])).toBeUndefined();
    expect(resolveUpstreamScript(["node", "--experimental-vm-modules"])).toBeUndefined();
  });
});

describe("tb_audit_workflow_export_daybook", () => {
  it("exports, validates and records the day book as present", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["node", "/opt/tally_prime_mcp_server/dist/index.js"];
    const wf = await h.start();
    expect(inputRow(wf, "dayBook").status).toBe("missing");

    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(true);
    const row = inputRow(out, "dayBook");
    expect(row.status).toBe("present");
    expect(row.path).toBe(join(out.workflowDir, "daybook.json"));
    expect(existsSync(row.path)).toBe(true);
    expect(readFileSync(row.path, "utf8")).toBe(GOOD_DAYBOOK);
    expect(h.spawnCalls).toHaveLength(1);
    const spec = h.spawnCalls[0];
    expect(spec.upstream).toBe("/opt/tally_prime_mcp_server/dist/index.js");
    expect(spec.company).toBe(PARAMS.company);
    expect(spec.from).toBe(PARAMS.fromDate);
    expect(spec.to).toBe(PARAMS.toDate);
    expect(spec.out).toBe(row.path);
    expect(spec.script.endsWith(`export-daybook.mjs`)).toBe(true);
  });

  it("never exports when a day-book path is already set (user-supplied wins)", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["/opt/tally_prime_mcp_server/dist/index.js"];
    const wf = await h.start();
    const dir = join(wf.workflowDir, "in");
    await mkdir(dir, { recursive: true });
    const supplied = join(dir, "operator-daybook.json");
    await writeFile(supplied, GOOD_DAYBOOK, "utf8");
    const patched = JSON.parse(
      await h.tools.get("tb_audit_workflow_status")!({
        workflowId: wf.workflowId,
        setInputs: { dayBook: supplied },
      }),
    );
    expect(inputRow(patched, "dayBook").status).toBe("present");

    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(false);
    expect(out.note).toMatch(/already supplied/);
    expect(h.spawnCalls).toHaveLength(0);
    expect(inputRow(out, "dayBook").path).toBe(supplied);
  });

  it("marks the day book missing with the configuration hint when no upstream path resolves", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["node", "--no-warnings"];
    const wf = await h.start();
    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(false);
    const row = inputRow(out, "dayBook");
    expect(row.status).toBe("missing");
    expect(row.reason).toMatch(/TALLY_MCP_ARGS/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("records a non-zero exit as a failed export, not a thrown error", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["/opt/upstream/dist/index.js"];
    h.setSpawn(async () => ({ code: 1, stderr: "connect ECONNREFUSED 127.0.0.1:9000\nat exports" }));
    const wf = await h.start();
    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(false);
    const row = inputRow(out, "dayBook");
    expect(row.status).toBe("missing");
    expect(row.reason).toContain("day-book export failed");
    expect(row.reason).toContain("ECONNREFUSED");
  });

  it("records a spawn failure as a failed export", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["/opt/upstream/dist/index.js"];
    h.setSpawn(async () => {
      throw new Error("spawn node ENOENT");
    });
    const wf = await h.start();
    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(false);
    expect(inputRow(out, "dayBook").reason).toContain("spawn node ENOENT");
  });

  it("validates the exported file and refuses a bad one", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["/opt/upstream/dist/index.js"];
    h.setSpawn(async (spec) => {
      writeFileSync(spec.out, "{not json at all", "utf8");
      return { code: 0, stderr: "" };
    });
    const wf = await h.start();
    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(false);
    const row = inputRow(out, "dayBook");
    expect(row.status).toBe("missing");
    expect(row.reason).toContain("day book failed validation");
  });

  it("refuses an export for the wrong period or company", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["/opt/upstream/dist/index.js"];
    h.setSpawn(async (spec) => {
      writeFileSync(spec.out, GOOD_DAYBOOK.replace("Workflow Test Co", "Other Company Pvt Ltd"), "utf8");
      return { code: 0, stderr: "" };
    });
    const wf = await h.start();
    const out = await h.exportDaybook(wf.workflowId);
    expect(out.exported).toBe(false);
    expect(inputRow(out, "dayBook").reason).toContain("different company");
  });

  it("moves a previous export aside instead of clobbering it", async () => {
    const h = harness();
    h.cfg.downstreamArgs = ["/opt/upstream/dist/index.js"];
    const wf = await h.start();
    const first = await h.exportDaybook(wf.workflowId);
    expect(first.exported).toBe(true);
    h.setSpawn(async (spec) => {
      writeFileSync(spec.out, GOOD_DAYBOOK.replace('"voucherNumber": "1"', '"voucherNumber": "2"'), "utf8");
      return { code: 0, stderr: "" };
    });
    const second = await h.exportDaybook(wf.workflowId);
    expect(second.exported).toBe(true);
    const aside = join(second.workflowDir, "daybook.json.old");
    expect(existsSync(aside)).toBe(true);
    expect(readFileSync(aside, "utf8")).toBe(GOOD_DAYBOOK);
  });

  it("errors honestly on an unknown workflow id", async () => {
    const h = harness();
    await expect(h.exportDaybook("no-such-workflow")).rejects.toThrow(/no workflow/);
  });
});
