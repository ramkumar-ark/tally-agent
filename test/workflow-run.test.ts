import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { registerWorkflowTools } from "../src/workflow.js";
import { newManifest, saveManifest, type WorkflowInputEntry, type WorkflowManifest, type WorkflowPass } from "../src/workflow-state.js";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

const PARAMS = {
  company: "Workflow Test Co",
  fromDate: "20250401",
  toDate: "20260331",
  asOnDate: "20260331",
};

interface Harness {
  tools: Map<string, (args: any) => Promise<string>>;
  reportDir: string;
  calls: Array<{ tool: string; args: any }>;
  used: (tool: string) => boolean;
  setFake(tool: string, handler: (args: any) => Promise<string>): void;
  makeWorkflow(opts: {
    selectedSteps: string[];
    inputs?: Record<string, Partial<WorkflowInputEntry> & { file?: string; content?: string }>;
    steps?: Record<string, object>;
    passes?: WorkflowPass[];
  }): Promise<string>;
  run: (args: object) => Promise<any>;
}

function harness(): Harness {
  const calls: Array<{ tool: string; args: any }> = [];
  const fake = new Map<string, (args: any) => Promise<string>>();
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _d, _s, h) => tools.set(name, h);
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  const reportDir = mkdtempSync(join(tmpdir(), "wf-run-"));
  registerWorkflowTools(registrar, {
    call: async (name, args) => {
      const handler = fake.get(name);
      if (!handler) throw new Error(`fake harness: no handler for ${name}`);
      calls.push({ tool: name, args });
      return handler(args);
    },
    session,
    cfg: { reportDir, dayBookMaxBytes: 64 * 1024 * 1024 },
    sessionId: "20260331T100000Z",
    audit: async () => {},
  });
  const used = (tool: string) => calls.some((c) => c.tool === tool);

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
        entries[key] = {
          status: "present",
          path,
          digest: sha256(content ?? "content"),
          ...entry,
        } as WorkflowInputEntry;
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

  const run = async (args: object) =>
    JSON.parse(await tools.get("tb_audit_workflow_run")!(args));

  return { tools, reportDir, calls, used, makeWorkflow, run, setFake: (tool, handler) => { fake.set(tool, handler); } };
}

/** A review fake returning findings of the given severities. */
const reviewer = (severities: string[]) => async () =>
  JSON.stringify({ findings: severities.map((s) => ({ check: "check_x", severity: s })) });

/** A report/fill fake writing one file into outDir/outPath and returning its path. */
const fileWriter = (name: string, key: string) => async (args: any) => {
  const dir: string = args.outDir ?? args.outPath;
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, "written", "utf8");
  return JSON.stringify({ [key]: p });
};

function standardTdsFakes(h: Harness, opts: { tdsThrows?: boolean; fillThrows?: boolean } = {}) {
  h.setFake("tb_tds_review", opts.tdsThrows ? async () => { throw new Error("review blew up"); } : reviewer(["critical"]));
  h.setFake("tb_write_tds_report", fileWriter("tds-report.md", "markdownPath"));
  h.setFake("tb_write_3cd_tds_tcs", opts.fillThrows ? async () => { throw new Error("fill blew up"); } : fileWriter("3cd-filled.xlsm", "workbookPath"));
}

const TDS_INPUTS = {
  dayBook: { file: "daybook.json", content: "{}" },
  tdsTemplate: { file: "tds-template.xlsx", content: "xlsx", status: "accepted" },
};

describe("tb_audit_workflow_run", () => {
  it("runs one step per call, advances next, closes the pass and writes LATEST.txt", async () => {
    const h = harness();
    standardTdsFakes(h);
    await h.makeWorkflow({ selectedSteps: ["tds"], inputs: { ...TDS_INPUTS } });
    const r1 = await h.run({ workflowId: "wf-test" });
    expect(r1.step.id).toBe("tds");
    expect(r1.pass).toBe(1);
    expect(r1.step.status).toBe("partial"); // winman34 absent → fill skipped
    expect(r1.step.notes.join(" ")).toMatch(/Winman clause-34 workbook not given/);
    expect(r1.passClosed).toBe(true);
    expect(r1.next).toBeNull();
    const passDir = r1.passDir;
    expect(existsSync(join(passDir, "03-tds", "tds-report.md"))).toBe(true);
    const latest = readFileSync(join(passDir, "..", "LATEST.txt"), "utf8");
    expect(latest).toContain("pass-01-");
    expect(existsSync(join(passDir, "INDEX.md"))).toBe(true);
    expect(existsSync(join(passDir, "summary.json"))).toBe(true);
    expect(existsSync(join(passDir, "inputs", "tdsTemplate-tds-template.xlsx"))).toBe(true);
  });

  it("writes LATEST.txt after the first run step, while the pass is still open", async () => {
    const h = harness();
    standardTdsFakes(h);
    h.setFake("tb_pf_esi_review", reviewer(["warning"]));
    h.setFake("tb_write_pf_esi_report", fileWriter("pf-report.xlsx", "markdownPath"));
    h.setFake("tb_write_3cd_pf_esi", fileWriter("pf-filled.xlsm", "workbookPath"));
    await h.makeWorkflow({
      selectedSteps: ["tds", "pf_esi"],
      inputs: { ...TDS_INPUTS, pfEsiTemplate: { file: "pf.xlsx", content: "x", status: "accepted" } },
    });
    const r1 = await h.run({ workflowId: "wf-test" });
    expect(r1.step.id).toBe("tds");
    expect(r1.passClosed).toBe(false); // pf_esi still pending
    const wfDir = join(h.reportDir, "audit-workflows", "wf-test");
    const latest = readFileSync(join(wfDir, "LATEST.txt"), "utf8");
    expect(latest.trim()).toBe(basename(r1.passDir));
    expect(latest).toContain("pass-01-");
    expect(existsSync(join(r1.passDir, "INDEX.md"))).toBe(true);
  });

  it("LATEST.txt names the newest pass folder once a second pass opens", async () => {
    const h = harness();
    standardTdsFakes(h);
    h.setFake("tb_pf_esi_review", reviewer(["warning"]));
    h.setFake("tb_write_pf_esi_report", fileWriter("pf-report.xlsx", "markdownPath"));
    h.setFake("tb_write_3cd_pf_esi", fileWriter("pf-filled.xlsm", "workbookPath"));
    await h.makeWorkflow({
      selectedSteps: ["tds", "pf_esi"],
      inputs: { ...TDS_INPUTS, pfEsiTemplate: { file: "pf.xlsx", content: "x", status: "accepted" } },
    });
    await h.run({ workflowId: "wf-test" }); // tds
    await h.run({ workflowId: "wf-test" }); // pf_esi, pass 1 closes
    const wfDir = join(h.reportDir, "audit-workflows", "wf-test");
    expect(readFileSync(join(wfDir, "LATEST.txt"), "utf8")).toContain("pass-01-");
    const r3 = await h.run({ workflowId: "wf-test", rerun: ["tds"] });
    expect(r3.pass).toBe(2);
    const latest = readFileSync(join(wfDir, "LATEST.txt"), "utf8");
    expect(latest.trim()).toBe(basename(r3.passDir));
    expect(latest).toContain("pass-02-");
  });

  it("a review throw fails the step and the next run runs the next step", async () => {
    const h = harness();
    standardTdsFakes(h, { tdsThrows: true });
    h.setFake("tb_pf_esi_review", reviewer(["warning"]));
    h.setFake("tb_write_pf_esi_report", fileWriter("pf-report.xlsx", "workbookPath"));
    h.setFake("tb_write_3cd_pf_esi", fileWriter("pf-filled.xlsm", "workbookPath"));
    await h.makeWorkflow({
      selectedSteps: ["tds", "pf_esi"],
      inputs: {
        ...TDS_INPUTS,
        pfEsiTemplate: { file: "pf-template.xlsx", content: "xlsx", status: "accepted" },
      },
    });
    const r1 = await h.run({ workflowId: "wf-test" });
    expect(r1.step.status).toBe("failed");
    expect(r1.step.error).toMatch(/review blew up/);
    expect(r1.next).toBe("pf_esi");
    expect(r1.passClosed).toBe(false);
    const r2 = await h.run({ workflowId: "wf-test" });
    expect(r2.step.id).toBe("pf_esi");
    expect(r2.step.status).toBe("partial");
    expect(r2.passClosed).toBe(true);
    expect(h.used("tb_write_pf_esi_report")).toBe(true);
  });

  it("a throwing filler leaves the step partial, not failed", async () => {
    const h = harness();
    standardTdsFakes(h, { fillThrows: true });
    await h.makeWorkflow({
      selectedSteps: ["tds"],
      inputs: { ...TDS_INPUTS, winman34: { file: "winman.xlsm", content: "xlsm" } },
    });
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.status).toBe("partial");
    expect(r.step.notes.join(" ")).toMatch(/error in tb_write_3cd_tds_tcs: fill blew up/);
    expect(r.passClosed).toBe(true);
  });

  it("holds the gst44 Winman write until the working sheet is approved", async () => {
    const h = harness();
    h.setFake("tb_gst44_review", reviewer(["review"]));
    h.setFake("tb_write_gst44_report", fileWriter("gst44.xlsx", "workbookPath"));
    h.setFake("tb_write_3cd_gst44", fileWriter("gst44-filled.xlsm", "workbookPath"));
    const inputs = {
      dayBook: { file: "daybook.json", content: "{}" },
      gstWorkingSheet: { file: "sheet.xlsx", content: "sheet", status: "filled" },
      winmanGst44: { file: "winman.xlsm", content: "xlsm" },
    };
    await h.makeWorkflow({ selectedSteps: ["gst44"], inputs });
    const r1 = await h.run({ workflowId: "wf-test" });
    expect(r1.step.status).toBe("partial");
    expect(r1.step.notes.join(" ")).toMatch(/not approved/);
    expect(h.used("tb_write_3cd_gst44")).toBe(false);

    // approve and re-run: the changed fingerprint plans the step again
    const manifest: WorkflowManifest = JSON.parse(
      readFileSync(join(h.reportDir, "audit-workflows", "wf-test", "workflow.json"), "utf8"),
    );
    manifest.inputs.gstWorkingSheet.status = "approved";
    await writeFile(
      join(h.reportDir, "audit-workflows", "wf-test", "workflow.json"),
      JSON.stringify(manifest),
      "utf8",
    );
    const r2 = await h.run({ workflowId: "wf-test" });
    expect(h.used("tb_write_3cd_gst44")).toBe(true);
    expect(r2.pass).toBe(2);
    expect(r2.step.status).toBe("done"); // review + report + Winman fill all ran
  });

  it("packages the generated working sheet and awaits approval", async () => {
    const h = harness();
    const findings = [{ id: "WS-1", check: "ws_rule_conflict", severity: "warning", ledger: "Ledger 1", amount: null, detail: "check the rule" }];
    await h.makeWorkflow({
      selectedSteps: ["gst_working_sheet"],
      inputs: { dayBook: { file: "d.json", content: "{}" }, gstWorkingSheet: { file: "sheet.xlsx", content: "SHEET" } },
      steps: { gst_working_sheet: { gstWorksheetFindings: JSON.stringify(findings) } },
    });
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.status).toBe("done");
    expect(r.step.notes).toEqual(["awaiting approval"]);
    expect(r.step.outputs).toHaveLength(2);
    const csv = r.step.outputs.find((o: string) => o.endsWith(".csv"));
    expect(readFileSync(csv, "utf8")).toContain("ws_rule_conflict");
  });

  it("notds without a template generates it into to-fill and ends needs-input", async () => {
    const h = harness();
    h.setFake("tb_tds_review", reviewer([]));
    h.setFake("tb_write_notds_template", fileWriter("notds-template.xlsx", "templatePath"));
    h.setFake("tb_notds_review", reviewer([]));
    await h.makeWorkflow({
      selectedSteps: ["tds", "notds"],
      inputs: { ...TDS_INPUTS },
    });
    await h.run({ workflowId: "wf-test" }); // tds first
    const r = await h.run({ workflowId: "wf-test" }); // then notds
    expect(r.step.id).toBe("notds");
    expect(r.step.status).toBe("needs-input");
    expect(h.used("tb_tds_review")).toBe(true);
    expect(h.used("tb_notds_review")).toBe(false);
    const toFill = join(h.reportDir, "audit-workflows", "wf-test", "to-fill");
    expect(readdirSync(toFill)).toContain("notds-template.xlsx");
    const manifest: WorkflowManifest = JSON.parse(
      readFileSync(join(toFill, "..", "workflow.json"), "utf8"),
    );
    expect(manifest.inputs.notdsTemplate.status).toBe("generated-unfilled");
  });

  it("notds with a filled template reviews, fills the Winman copy and writes findings.csv", async () => {
    const h = harness();
    h.setFake("tb_tds_review", reviewer([]));
    h.setFake("tb_notds_review", reviewer(["critical", "review"]));
    h.setFake("tb_write_3cd_notds", fileWriter("notds-filled.xlsm", "workbookPath"));
    await h.makeWorkflow({
      selectedSteps: ["notds"],
      inputs: {
        dayBook: { file: "d.json", content: "{}" },
        tdsTemplate: { file: "t.xlsx", content: "x", status: "accepted" },
        notdsTemplate: { file: "notds.xlsx", content: "filled", status: "filled", generatedDigest: sha256("generated") },
        winmanNotds: { file: "winman.xlsm", content: "xlsm" },
      },
    });
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.status).toBe("done");
    expect(h.used("tb_notds_review")).toBe(true);
    expect(h.used("tb_write_3cd_notds")).toBe(true);
    expect(r.step.findings).toEqual({ critical: 1, warning: 0, review: 1 });
    const csv = r.step.outputs.find((o: string) => o.endsWith("notds-findings.csv"));
    expect(existsSync(csv)).toBe(true);
  });

  it("reuses this process's TDS cache when the fingerprint is unchanged", async () => {
    const h = harness();
    h.setFake("tb_tds_review", reviewer([]));
    h.setFake("tb_notds_review", reviewer([]));
    h.setFake("tb_write_3cd_notds", fileWriter("notds-filled.xlsm", "workbookPath"));
    const inputs = {
      dayBook: { file: "d.json", content: "{}" },
      tdsTemplate: { file: "t.xlsx", content: "x", status: "accepted" },
      notdsTemplate: { file: "notds.xlsx", content: "filled", status: "filled" },
    };
    await h.makeWorkflow({ selectedSteps: ["tds", "notds"], inputs });
    await h.run({ workflowId: "wf-test" }); // tds runs, cache set
    // second pass: notds is planned (needs-input never done) — wait, it ended done? notds without winman → partial
    const r2 = await h.run({ workflowId: "wf-test" });
    const tdsCallsAfterPass1 = 1;
    expect(h.calls.filter((c) => c.tool === "tb_tds_review")).toHaveLength(tdsCallsAfterPass1 + 0);
    expect(r2.step.id).toBe("notds");
    expect(r2.step.notes.join(" ")).toMatch(/reused this process's TDS review/);
  });

  it("second pass re-runs only the changed-fingerprint step and carries the rest forward", async () => {
    const h = harness();
    standardTdsFakes(h);
    h.setFake("tb_pf_esi_review", reviewer(["warning"]));
    h.setFake("tb_write_pf_esi_report", fileWriter("pf-report.xlsx", "workbookPath"));
    h.setFake("tb_write_3cd_pf_esi", fileWriter("pf-filled.xlsm", "workbookPath"));
    const inputs = {
      ...TDS_INPUTS,
      pfEsiTemplate: { file: "pf.xlsx", content: "x", status: "accepted" },
    };
    await h.makeWorkflow({ selectedSteps: ["tds", "pf_esi"], inputs });
    await h.run({ workflowId: "wf-test" }); // tds
    await h.run({ workflowId: "wf-test" }); // pf_esi, pass 1 closes
    // operator edits the tds template
    const manifestPath = join(h.reportDir, "audit-workflows", "wf-test", "workflow.json");
    const m: WorkflowManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    appendFileSync(m.inputs.tdsTemplate.path as string, "edited", "utf8");
    m.inputs.tdsTemplate.status = "filled";
    m.inputs.tdsTemplate.digest = sha256(await readFile(m.inputs.tdsTemplate.path as string));
    await writeFile(manifestPath, JSON.stringify(m), "utf8");
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.pass).toBe(2);
    expect(r.passDir).toContain("pass-02-");
    const passDir = r.passDir;
    expect(existsSync(join(passDir, "09-pf_esi", "pf-report.xlsx"))).toBe(true);
    expect(existsSync(join(passDir, "03-tds", "tds-report.md"))).toBe(true);
    const index = readFileSync(join(passDir, "INDEX.md"), "utf8");
    expect(index).toMatch(/carried forward from pass-01/);
  });

  it("resets a step left running by a foreign process and re-runs it in a fresh dir", async () => {
    const h = harness();
    standardTdsFakes(h);
    const wfDir = await h.makeWorkflow({
      selectedSteps: ["tds"],
      inputs: { ...TDS_INPUTS },
      steps: {
        tds: { status: "running", runningProcess: "another-session", outputs: ["/gone/old.md"], runningSince: "earlier" },
      },
      passes: [{ n: 1, dir: "pass-01-x", startedAt: "earlier", plan: ["tds"], recorded: [] }],
    });
    await mkdir(join(wfDir, "pass-01-x", "03-tds"), { recursive: true });
    await writeFile(join(wfDir, "pass-01-x", "03-tds", "stale.md"), "old", "utf8");
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.status).toBe("partial");
    expect(r.passDir).toContain("pass-01-x");
    expect(r.step.outputs[0]).toContain("03-tds (2)");
    expect(r.step.notes.join(" ")).toMatch(/interrupted — re-run/);
  });

  it("copies a tool output written outside the step dir into it, original untouched", async () => {
    const h = harness();
    const wfDirPromise = h.makeWorkflow({ selectedSteps: ["tds"], inputs: { ...TDS_INPUTS } });
    const wfDir = await wfDirPromise;
    h.setFake("tb_tds_review", reviewer(["critical"]));
    h.setFake("tb_write_tds_report", async (args: any) => {
      const outside = join(wfDir, "stray-report.md");
      await writeFile(outside, "stray", "utf8");
      return JSON.stringify({ markdownPath: outside });
    });
    h.setFake("tb_write_3cd_tds_tcs", fileWriter("3cd.xlsm", "workbookPath"));
    const r = await h.run({ workflowId: "wf-test" });
    const stepFiles = readdirSync(join(r.passDir, "03-tds"));
    expect(stepFiles).toContain("stray-report.md");
    expect(existsSync(join(wfDir, "stray-report.md"))).toBe(true);
    expect(r.step.notes.join(" ")).toMatch(/wrote outside the run folder/);
  });

  it("uses a fresh step-dir name when the plain one is taken", async () => {
    const h = harness();
    standardTdsFakes(h);
    const wfDir = await h.makeWorkflow({
      selectedSteps: ["tds"],
      inputs: { ...TDS_INPUTS },
      passes: [{ n: 1, dir: "pass-01-x", startedAt: "earlier", plan: ["tds"], recorded: [] }],
    });
    await mkdir(join(wfDir, "pass-01-x", "03-tds"), { recursive: true });
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.outputs[0]).toContain("03-tds (2)");
  });

  it("closes an all-needs-input pass immediately and lists the fill paths in INDEX", async () => {
    const h = harness();
    await h.makeWorkflow({
      selectedSteps: ["as26"],
      inputs: { dayBook: { file: "d.json", content: "{}" } },
    });
    const r = await h.run({ workflowId: "wf-test" });
    expect(r.passClosed).toBe(true);
    expect(r.step).toBeNull();
    expect(r.progress.needsInput).toBe(1);
    const index = readFileSync(join(r.passDir, "INDEX.md"), "utf8");
    expect(index).toContain("## Needs your input");
    expect(index).toContain("as26Export");
    expect(index).toContain("as26Map");
  });

  it("refuses to run a step that the pass recorded, naming its state", async () => {
    const h = harness();
    await h.makeWorkflow({
      selectedSteps: ["as26"],
      inputs: { dayBook: { file: "d.json", content: "{}" } },
    });
    await h.run({ workflowId: "wf-test" });
    await expect(h.run({ workflowId: "wf-test", step: "as26" })).rejects.toThrow(/recorded: needs-input/);
  });
});
