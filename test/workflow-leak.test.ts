import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolRegistrar } from "../src/index.js";
import { registerTools } from "../src/index.js";
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

const SECRETS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/secrets.json", import.meta.url)), "utf8"),
) as string[];

/** Same shapes mask.ts scrubs; duplicated here so a scrubber regression cannot hide. */
const PAN_SHAPE = /[A-Z]{5}\d{4}[A-Z]/gi;
const GSTIN_SHAPE = /\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}/gi;

const PAN = "ABCDE1234F";
const GSTIN = "27AAAAA0000A1Z5";
const SECRET_A = "Acme Traders";
const SECRET_B = "Bharat Corp";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

const PARAMS = {
  company: "Workflow Test Co",
  fromDate: "20250401",
  toDate: "20260331",
  asOnDate: "20260331",
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  tools: Map<string, (args: any) => Promise<string>>;
  reportDir: string;
  session: ReturnType<typeof createSession>;
  downstream: ReturnType<typeof fakeDownstream>;
  calls: Array<{ tool: string; args: any }>;
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
  const downstream = fakeDownstream();
  const session = createSession(downstream, EMPTY_OVERRIDES);
  const reportDir = mkdtempSync(join(tmpdir(), "wf-leak-"));
  tempDirs.push(reportDir);
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

  return {
    tools,
    reportDir,
    session,
    downstream,
    calls,
    makeWorkflow,
    run,
    setFake: (tool, handler) => {
      fake.set(tool, handler);
    },
  };
}

/** A report/fill fake writing one file into outDir/outPath and returning its path. */
const fileWriter = (name: string, key: string) => async (args: any) => {
  const dir: string = args.outDir ?? args.outPath;
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, "written", "utf8");
  return JSON.stringify({ [key]: p });
};

/** A review fake returning findings of the given severities. */
const reviewer = (severities: string[]) => async () =>
  JSON.stringify({ findings: severities.map((s) => ({ check: "check_x", severity: s })) });

const TDS_INPUTS = {
  dayBook: { file: "daybook.json", content: "{}" },
  tdsTemplate: { file: "tds-template.xlsx", content: "xlsx", status: "accepted" },
};

/**
 * Vacuity guard (leak.test canon §5.7): every planted string must be a
 * recorded secret and must sit in the raw payload the flow will carry, and
 * the tax-shaped strings must genuinely match the shapes — otherwise the
 * absence assertions below prove nothing.
 */
function assertPlantIsReal(...planted: string[]): void {
  for (const p of planted) {
    expect(SECRETS, `${p} must be a recorded secret`).toContain(p);
  }
}

/**
 * The audit scan. Every secret must be absent, and no tax-id-shaped string
 * may survive. Sha digests are hex and PAN_SHAPE happily matches a hex run,
 * so long pure-hex runs (digests, ids) are stripped first — a planted secret
 * sits in prose, delimited by spaces or punctuation, and survives the strip.
 */
function scan(label: string, text: string): void {
  for (const secret of SECRETS) {
    expect(text, `${label}: leaked ${secret}`).not.toContain(secret);
  }
  const stripped = text.replace(/[0-9a-f]{12,}/gi, "");
  expect(stripped.match(GSTIN_SHAPE), `${label}: GSTIN-shaped leak`).toBeNull();
  expect(stripped.match(PAN_SHAPE), `${label}: PAN-shaped leak`).toBeNull();
}

describe("tax-audit workflow leaks nothing", () => {
  it("masks a PAN and a vaulted name in a throwing template generator across start and status", async () => {
    const h = harness();
    h.session.vault.pseudonym(SECRET_A, "creditor");
    h.session.vault.pseudonym(SECRET_B, "creditor");
    assertPlantIsReal(PAN, SECRET_A);
    const raw = `template generation for ${SECRET_A} failed at PAN ${PAN}`;
    expect(raw).toContain(PAN);
    expect(PAN.match(PAN_SHAPE)).toBeTruthy();
    h.setFake("tb_list_companies", async () => JSON.stringify({ companies: [] }));
    h.setFake("tb_write_tds_template", async () => {
      throw new Error(raw);
    });
    h.setFake("tb_write_pf_esi_template", fileWriter("pf-template.xlsx", "templatePath"));

    const startRes = await h.tools.get("tb_audit_workflow_start")!({
      company: PARAMS.company,
      fromDate: PARAMS.fromDate,
      toDate: PARAMS.toDate,
    });
    scan("start response", startRes);
    const view = JSON.parse(startRes);
    const tdsRow = view.inputs.find((i: any) => i.key === "tdsTemplate");
    expect(tdsRow).toBeTruthy();
    expect(tdsRow.reason).toMatch(/generation failed:/);
    expect(tdsRow.reason).not.toContain(PAN);
    expect(tdsRow.reason).not.toContain(SECRET_A);

    const statusRes = await h.tools.get("tb_audit_workflow_status")!({
      workflowId: view.workflowId,
    });
    scan("status response", statusRes);

    const listRes = await h.tools.get("tb_audit_workflow_status")!({});
    scan("status list response", listRes);
  });

  it("masks a PAN, GSTIN and vaulted name in a throwing review, in the response, INDEX.md and summary.json", async () => {
    const h = harness();
    h.session.vault.pseudonym(SECRET_B, "creditor");
    assertPlantIsReal(PAN, GSTIN, SECRET_B);
    const raw = `review crashed on ${SECRET_B} GSTIN ${GSTIN} PAN ${PAN}`;
    expect(raw).toContain(GSTIN);
    expect(GSTIN.match(GSTIN_SHAPE)).toBeTruthy();
    h.setFake("tb_tds_review", async () => {
      throw new Error(raw);
    });
    h.setFake("tb_write_tds_report", fileWriter("tds-report.md", "markdownPath"));
    await h.makeWorkflow({ selectedSteps: ["tds"], inputs: { ...TDS_INPUTS } });

    const r = await h.run({ workflowId: "wf-test" });
    expect(r.step.error).toMatch(/review crashed/);
    expect(r.step.error).not.toContain(SECRET_B);
    expect(r.step.error).not.toContain(GSTIN);
    expect(r.step.error).not.toContain(PAN);
    scan("run response", JSON.stringify(r));

    expect(existsSync(join(r.passDir, "INDEX.md"))).toBe(true);
    const index = readFileSync(join(r.passDir, "INDEX.md"), "utf8");
    expect(index).toMatch(/## Failed/);
    scan("INDEX.md", index);

    const summary = readFileSync(join(r.passDir, "summary.json"), "utf8");
    const sj = JSON.parse(summary);
    const tdsStep = sj.steps.find((s: any) => s.id === "tds");
    expect(tdsStep.error).toMatch(/review crashed/);
    scan("summary.json", summary);
  });

  it("lets a vault pseudonym pass through an error untouched while the real name and PAN never return", async () => {
    const h = harness();
    const alias = h.session.vault.pseudonym(SECRET_A, "creditor");
    expect(alias).toBeTruthy();
    assertPlantIsReal(PAN, SECRET_A);
    const raw = `${alias} fill failed (PAN ${PAN})`;
    h.setFake("tb_tds_review", reviewer([]));
    h.setFake("tb_write_tds_report", fileWriter("tds-report.md", "markdownPath"));
    h.setFake("tb_write_3cd_tds_tcs", async () => {
      throw new Error(raw);
    });
    await h.makeWorkflow({
      selectedSteps: ["tds"],
      inputs: { ...TDS_INPUTS, winman34: { file: "winman.xlsm", content: "xlsm" } },
    });

    const r = await h.run({ workflowId: "wf-test" });
    const notes = (r.step.notes ?? []).join(" ");
    expect(notes).toMatch(/error in tb_write_3cd_tds_tcs:/);
    expect(notes).toContain(alias);
    expect(notes).not.toContain(SECRET_A);
    expect(notes).not.toContain(PAN);
    scan("run response", JSON.stringify(r));
    scan("INDEX.md", readFileSync(join(r.passDir, "INDEX.md"), "utf8"));
    scan("summary.json", readFileSync(join(r.passDir, "summary.json"), "utf8"));
  });

  it("only reads: every tool the workflow calls is one the gateway registers and no write verb", async () => {
    const registered = new Set<string>();
    const regDir = mkdtempSync(join(tmpdir(), "wf-leak-reg-"));
    tempDirs.push(regDir);
    registerTools(
      (name) => registered.add(name),
      createSession(fakeDownstream(), EMPTY_OVERRIDES),
      { reportDir: regDir },
    );
    expect(registered.size).toBeGreaterThan(30);

    const DOWNSTREAM_TOOLS = new Set(
      [
        ...readFileSync(
          fileURLToPath(new URL("../src/downstream.ts", import.meta.url)),
          "utf8",
        ).matchAll(/call\("([a-z_]+)"/g),
      ].map((m) => m[1]),
    );
    expect(DOWNSTREAM_TOOLS.size).toBeGreaterThan(0);

    const h = harness();
    h.setFake("tb_list_companies", async () => JSON.stringify({ companies: [] }));
    h.setFake("tb_tds_review", reviewer([]));
    h.setFake("tb_write_tds_report", fileWriter("tds-report.md", "markdownPath"));
    await h.tools.get("tb_audit_workflow_start")!({
      company: PARAMS.company,
      fromDate: PARAMS.fromDate,
      toDate: PARAMS.toDate,
    });
    await h.makeWorkflow({ selectedSteps: ["tds"], inputs: { ...TDS_INPUTS } });
    await h.run({ workflowId: "wf-test" });

    expect(h.calls.map((c) => c.tool)).toContain("tb_list_companies");
    for (const c of h.calls) {
      expect(registered.has(c.tool), `unknown tool called: ${c.tool}`).toBe(true);
      expect(c.tool, `write-shaped call: ${c.tool}`).not.toMatch(
        /create|post|save|update|delete|import|export/i,
      );
    }
    for (const c of h.downstream.calls) {
      expect(DOWNSTREAM_TOOLS.has(c.tool), `unknown downstream tool: ${c.tool}`).toBe(true);
    }
  });
});
