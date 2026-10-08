import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { registerWorkflowTools } from "../src/workflow.js";
import {
  newManifest,
  saveManifest,
  type WorkflowInputEntry,
  type WorkflowPass,
} from "../src/workflow-state.js";

/**
 * The derived latest/ folder: the newest copy of every step's outputs, taken
 * from the most recent pass folder that produced it, rebuilt when a pass
 * closes and backfilled by one status call. The pass folders themselves are
 * only ever read.
 */

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

const PARAMS = {
  company: "Workflow Test Co",
  fromDate: "20250401",
  toDate: "20260331",
  asOnDate: "20260331",
};

const DAY_BOOK = JSON.stringify({
  company: "Workflow Test Co",
  groups: [],
  ledgers: [],
  vouchers: [],
});

interface Harness {
  tools: Map<string, (args: any) => Promise<string>>;
  reportDir: string;
  setFake(tool: string, handler: (args: any) => Promise<string>): void;
  makeWorkflow(opts: {
    selectedSteps: string[];
    inputs?: Record<string, Partial<WorkflowInputEntry> & { file?: string; content?: string }>;
    steps?: Record<string, object>;
    passes?: WorkflowPass[];
  }): Promise<string>;
  run: (args: object) => Promise<any>;
  status: (args: object) => Promise<any>;
}

function harness(): Harness {
  const fake = new Map<string, (args: any) => Promise<string>>();
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _d, _s, h) => tools.set(name, h);
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  const reportDir = mkdtempSync(join(tmpdir(), "wf-latest-"));
  registerWorkflowTools(registrar, {
    call: async (name, args) => {
      const handler = fake.get(name);
      if (!handler) throw new Error(`fake harness: no handler for ${name}`);
      return handler(args);
    },
    session,
    cfg: { reportDir, dayBookMaxBytes: 64 * 1024 * 1024 },
    sessionId: "20260331T100000Z",
    audit: async () => {},
  });

  const makeWorkflow = async ({
    selectedSteps,
    inputs = {},
    steps = {},
    passes = [],
  }: {
    selectedSteps: string[];
    inputs?: Record<string, Partial<WorkflowInputEntry> & { file?: string; content?: string }>;
    steps?: Record<string, object>;
    passes?: WorkflowPass[];
  }): Promise<string> => {
    const wfDir = join(reportDir, "audit-workflows", "wf-test");
    await mkdir(join(wfDir, "to-fill"), { recursive: true });
    const entries: Record<string, WorkflowInputEntry> = {};
    for (const [key, spec] of Object.entries(inputs)) {
      const { file, content, ...entry } = spec;
      const path = file ? join(wfDir, "in", `${key}-${file}`) : undefined;
      if (path) {
        await mkdir(join(wfDir, "in"), { recursive: true });
        await writeFile(path, content ?? "content", "utf8");
        entries[key] = { status: "present", path, digest: sha256(content ?? "content"), ...entry } as WorkflowInputEntry;
      } else {
        entries[key] = { status: "missing", ...entry } as WorkflowInputEntry;
      }
    }
    const m = newManifest(PARAMS, entries, selectedSteps, "wf-test");
    for (const [id, patch] of Object.entries(steps)) {
      m.steps[id] = { ...m.steps[id], ...patch } as (typeof m.steps)[string];
    }
    m.passes.push(...passes);
    await saveManifest(wfDir, m);
    return wfDir;
  };

  const status = async (args: object) =>
    JSON.parse(await tools.get("tb_audit_workflow_status")!(args));

  return {
    tools,
    reportDir,
    makeWorkflow,
    status,
    run: async (args: object) => JSON.parse(await tools.get("tb_audit_workflow_run")!(args)),
    setFake: (tool, handler) => {
      fake.set(tool, handler);
    },
  };
}

const reviewer = (severities: string[]) => async () =>
  JSON.stringify({ findings: severities.map((s) => ({ check: "check_x", severity: s })) });

const fileWriter = (name: string, key: string) => async (args: any) => {
  const dir: string = args.outDir ?? args.outPath;
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, name, "utf8");
  return JSON.stringify({ [key]: p });
};

const TDS_INPUTS = {
  dayBook: { file: "daybook.json", content: DAY_BOOK },
  tdsTemplate: { file: "tds-template.xlsx", content: "xlsx", status: "accepted" },
};

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map((f) => String(f))
    .sort();

describe("latest/ folder", () => {
  it("takes each step's newest pass folder, keeping an older pass for a step that did not re-run", async () => {
    const h = harness();
    const wfDir = join(h.reportDir, "audit-workflows", "wf-test");
    await h.makeWorkflow({
      selectedSteps: ["tds", "pf_esi"],
      inputs: { ...TDS_INPUTS, pfEsiTemplate: { file: "pf.xlsx", content: "x", status: "accepted" } },
      steps: {
        tds: { status: "done", lastPass: "pass-02-a", outputs: [join(wfDir, "pass-02-a", "03-tds", "report.md")] },
        pf_esi: { status: "done", lastPass: "pass-01-a", outputs: [join(wfDir, "pass-01-a", "09-pf_esi", "pf-report.xlsx")] },
      },
      passes: [
        { n: 1, dir: "pass-01-a", startedAt: "earlier", closedAt: "earlier", plan: ["tds", "pf_esi"], recorded: [] },
        { n: 2, dir: "pass-02-a", startedAt: "later", closedAt: "later", plan: ["tds"], recorded: [] },
      ],
    });
    // pass 01 ran both steps; pass 02 ran tds only (pf_esi's files were never
    // carried into it — the captain's clause-44 case).
    await mkdir(join(wfDir, "pass-01-a", "03-tds"), { recursive: true });
    await writeFile(join(wfDir, "pass-01-a", "03-tds", "report.md"), "first", "utf8");
    await mkdir(join(wfDir, "pass-01-a", "09-pf_esi"), { recursive: true });
    await writeFile(join(wfDir, "pass-01-a", "09-pf_esi", "pf-report.xlsx"), "pf first", "utf8");
    await mkdir(join(wfDir, "pass-02-a", "03-tds"), { recursive: true });
    await writeFile(join(wfDir, "pass-02-a", "03-tds", "report.md"), "second", "utf8");

    const passTrees = [tree(join(wfDir, "pass-01-a")), tree(join(wfDir, "pass-02-a"))];
    expect(existsSync(join(wfDir, "latest"))).toBe(false);

    const res = await h.status({ workflowId: "wf-test" });

    const latest = join(wfDir, "latest");
    expect(readFileSync(join(latest, "03-tds", "report.md"), "utf8")).toBe("second");
    expect(readFileSync(join(latest, "09-pf_esi", "pf-report.xlsx"), "utf8")).toBe("pf first");
    expect(existsSync(join(latest, "README.md"))).toBe(true);

    const step = (id: string) => res.latest.steps.find((s: any) => s.id === id);
    expect(step("tds")).toMatchObject({ fromPass: "pass-02-a", dirName: "03-tds" });
    expect(step("pf_esi")).toMatchObject({ fromPass: "pass-01-a", dirName: "09-pf_esi" });
    expect(step("gst44").fromPass).toBeNull(); // never ran anywhere
    const readme = readFileSync(join(latest, "README.md"), "utf8");
    const row = (title: string) => readme.split("\n").find((l) => l.startsWith(`| ${title} `)) ?? "";
    expect(row("TDS review, report and clause 34 filler")).toContain("pass-02-a");
    expect(row("PF/ESI clause 20(b)")).toContain("pass-01-a");
    expect(readme).toContain("not produced yet");

    // derived output only: the pass folders are byte-identical afterwards
    expect(tree(join(wfDir, "pass-01-a"))).toEqual(passTrees[0]);
    expect(tree(join(wfDir, "pass-02-a"))).toEqual(passTrees[1]);
    expect(existsSync(join(wfDir, "latest.build"))).toBe(false);
    expect(existsSync(join(wfDir, "latest.old"))).toBe(false);
  });

  it("replaces a step's stale files instead of leaving them behind", async () => {
    const h = harness();
    const wfDir = join(h.reportDir, "audit-workflows", "wf-test");
    await h.makeWorkflow({
      selectedSteps: ["tds"],
      inputs: { ...TDS_INPUTS },
      steps: {
        tds: { status: "done", lastPass: "pass-01-a", outputs: [join(wfDir, "pass-01-a", "03-tds", "report.md")] },
      },
      passes: [{ n: 1, dir: "pass-01-a", startedAt: "earlier", closedAt: "earlier", plan: ["tds"], recorded: [] }],
    });
    await mkdir(join(wfDir, "pass-01-a", "03-tds"), { recursive: true });
    await writeFile(join(wfDir, "pass-01-a", "03-tds", "report.md"), "one", "utf8");
    await writeFile(join(wfDir, "pass-01-a", "03-tds", "stale.md"), "old", "utf8");

    await h.status({ workflowId: "wf-test" });
    const latest = join(wfDir, "latest");
    expect(tree(join(latest, "03-tds"))).toEqual(["report.md", "stale.md"].sort());
    expect(readFileSync(join(latest, "03-tds", "report.md"), "utf8")).toBe("one");

    // a later pass re-ran the step and wrote a different set of files
    await mkdir(join(wfDir, "pass-02-a", "03-tds"), { recursive: true });
    await writeFile(join(wfDir, "pass-02-a", "03-tds", "report.md"), "two", "utf8");
    const manifestPath = join(wfDir, "workflow.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.passes.push({ n: 2, dir: "pass-02-a", startedAt: "later", closedAt: "later", plan: ["tds"], recorded: [] });
    m.steps.tds = {
      ...m.steps.tds,
      lastPass: "pass-02-a",
      outputs: [join(wfDir, "pass-02-a", "03-tds", "report.md")],
    };
    await writeFile(manifestPath, JSON.stringify(m), "utf8");

    await h.status({ workflowId: "wf-test" });
    expect(tree(join(latest, "03-tds"))).toEqual(["report.md"]);
    expect(readFileSync(join(latest, "03-tds", "report.md"), "utf8")).toBe("two");
    // the superseded file still exists where it belongs — in its own pass
    expect(readFileSync(join(wfDir, "pass-01-a", "03-tds", "stale.md"), "utf8")).toBe("old");
    expect(existsSync(join(wfDir, "latest.build"))).toBe(false);
    expect(existsSync(join(wfDir, "latest.old"))).toBe(false);
  });

  it("backfills latest/ for a workflow created before the folder existed, in one status call", async () => {
    const h = harness();
    const wfDir = await h.makeWorkflow({
      selectedSteps: ["gst44"],
      inputs: { dayBook: { file: "d.json", content: DAY_BOOK } },
      steps: { gst44: { status: "done", lastPass: "pass-01-a" } },
      passes: [{ n: 1, dir: "pass-01-a", startedAt: "earlier", closedAt: "earlier", plan: ["gst44"], recorded: [] }],
    });
    await mkdir(join(wfDir, "pass-01-a", "02-gst44"), { recursive: true });
    await writeFile(join(wfDir, "pass-01-a", "02-gst44", "gst44-filled.xlsm"), "winman", "utf8");
    expect(existsSync(join(wfDir, "latest"))).toBe(false);

    const res = await h.status({ workflowId: "wf-test" });

    const filled = join(wfDir, "latest", "02-gst44", "gst44-filled.xlsm");
    expect(readFileSync(filled, "utf8")).toBe("winman");
    expect(res.latest.steps.find((s: any) => s.id === "gst44").fromPass).toBe("pass-01-a");
    // listing workflows (no id) does not touch the folder
    const before = tree(join(wfDir, "latest"));
    await h.status({});
    expect(tree(join(wfDir, "latest"))).toEqual(before);
  });

  it("rebuilds latest/ when a pass closes during a run", async () => {
    const h = harness();
    h.setFake("tb_tds_review", reviewer(["critical"]));
    h.setFake("tb_write_tds_report", fileWriter("tds-report.md", "markdownPath"));
    h.setFake("tb_write_3cd_tds_tcs", fileWriter("3cd-filled.xlsm", "workbookPath"));
    await h.makeWorkflow({
      selectedSteps: ["tds"],
      inputs: { ...TDS_INPUTS, winman34: { file: "winman.xlsm", content: "xlsm" } },
    });

    expect(existsSync(join(h.reportDir, "audit-workflows", "wf-test", "latest"))).toBe(false);
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.status).toBe("done");
    expect(r.passClosed).toBe(true);

    const wfDir = join(h.reportDir, "audit-workflows", "wf-test");
    const latest = join(wfDir, "latest");
    expect(readFileSync(join(latest, "03-tds", "tds-report.md"), "utf8")).toBe("tds-report.md");
    expect(readFileSync(join(latest, "03-tds", "3cd-filled.xlsm"), "utf8")).toBe("3cd-filled.xlsm");
    const readme = readFileSync(join(latest, "README.md"), "utf8");
    const tdsRow = readme.split("\n").find((l) => l.startsWith("| TDS review")) ?? "";
    expect(tdsRow).toContain(basename(r.passDir));
    expect(tdsRow).toContain("`03-tds`");
    expect(existsSync(join(wfDir, "latest.build"))).toBe(false);
    expect(existsSync(join(wfDir, "latest.old"))).toBe(false);
    // the pass folder still holds the originals
    expect(readFileSync(join(r.passDir, "03-tds", "tds-report.md"), "utf8")).toBe("tds-report.md");
  });
});
