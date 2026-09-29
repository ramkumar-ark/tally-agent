import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import type { Downstream } from "../src/downstream.js";

function harness(downstream?: Downstream) {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _desc, _schema, handler) => {
    tools.set(name, handler);
  };
  const session = createSession(downstream ?? fakeDownstream(), EMPTY_OVERRIDES);
  const cfg = {
    reportDir: mkdtempSync(join(tmpdir(), "tally-agent-")),
    dayBookMaxBytes: 64 * 1024 * 1024,
  };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, cfg };
}

const secrets = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/secrets.json", import.meta.url)), "utf8"),
) as string[];

const start = async (tools: Map<string, (args: any) => Promise<string>>, args: object) =>
  JSON.parse(await tools.get("tb_audit_workflow_start")!(args));

const inputRow = (parsed: any, key: string) =>
  parsed.inputs.find((i: any) => i.key === key);

describe("tb_audit_workflow_start", () => {
  it("creates the workflow folder and manifest, generating the dependency-free templates", async () => {
    const { tools } = harness();
    const parsed = await start(tools, {
      company: "Workflow Test Co",
      fromDate: "20250401",
      toDate: "20260331",
      asOnDate: "20260331",
    });
    expect(parsed.workflowId).toMatch(/^workflow-test-co-20250401-20260331-/);
    expect(existsSync(join(parsed.workflowDir, "workflow.json"))).toBe(true);
    expect(existsSync(join(parsed.workflowDir, "to-fill"))).toBe(true);
    expect(parsed.tallyReachable).toBe(true);

    const tds = inputRow(parsed, "tdsTemplate");
    expect(tds.status).toBe("generated-unfilled");
    expect(existsSync(tds.path)).toBe(true);
    expect(tds.path.startsWith(join(parsed.workflowDir, "to-fill"))).toBe(true);
    const pfEsi = inputRow(parsed, "pfEsiTemplate");
    expect(pfEsi.status).toBe("generated-unfilled");
    expect(existsSync(pfEsi.path)).toBe(true);

    expect(parsed.steps).toHaveLength(10);
    expect(parsed.steps.every((s: any) => s.status === "pending")).toBe(true);
    expect(parsed.nextAction).toMatch(/tb_audit_workflow_run/);
  });

  it("reports dayBook-dependent generators as waiting for the day book", async () => {
    const { tools } = harness();
    const parsed = await start(tools, {
      company: "Workflow Test Co",
      fromDate: "20250401",
      toDate: "20260331",
    });
    const gst44 = inputRow(parsed, "gst44Template");
    expect(gst44.status).toBe("missing");
    expect(gst44.reason).toMatch(/dayBook/);
    const loans = inputRow(parsed, "loansTemplate");
    expect(loans.status).toBe("missing");
    expect(loans.reason).toMatch(/dayBook/);
    const as26Map = inputRow(parsed, "as26Map");
    expect(as26Map.reason).toMatch(/as26Export/);
    expect(inputRow(parsed, "dayBook").blocks.length).toBeGreaterThan(0);
  });

  it("marks a missing or malformed day book invalid/missing without throwing", async () => {
    const { tools } = harness();
    const dir = mkdtempSync(join(tmpdir(), "wf-db-"));
    const missingPath = join(dir, "absent.json");
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "{not json", "utf8");
    const bad = await start(tools, {
      company: "Workflow Test Co",
      fromDate: "20250401",
      toDate: "20260331",
      inputs: { dayBook: badPath },
    });
    expect(bad.inputs.find((i: any) => i.key === "dayBook").status).toBe("invalid");
    const absent = await start(tools, {
      company: "Workflow Test Co",
      fromDate: "20250401",
      toDate: "20260331",
      inputs: { dayBook: missingPath },
    });
    expect(absent.inputs.find((i: any) => i.key === "dayBook").status).toBe("missing");
  });

  it("refuses unknown step ids and unknown input keys", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_audit_workflow_start")!({
        company: "C", fromDate: "20250401", toDate: "20260331", steps: ["nope"],
      }),
    ).rejects.toThrow(/unknown step id/);
    await expect(
      tools.get("tb_audit_workflow_start")!({
        company: "C", fromDate: "20250401", toDate: "20260331", inputs: { notAKey: "/x" },
      }),
    ).rejects.toThrow(/unknown input key/);
  });

  it("carries no secret value in the response", async () => {
    const { tools } = harness();
    const parsed = await start(tools, {
      company: "Workflow Test Co",
      fromDate: "20250401",
      toDate: "20260331",
    });
    const text = JSON.stringify(parsed);
    for (const s of secrets) expect(text).not.toContain(s);
  });
});

describe("tb_audit_workflow_status", () => {
  const startWorkflow = async (tools: Map<string, (args: any) => Promise<string>>) =>
    start(tools, {
      company: "Workflow Test Co",
      fromDate: "20250401",
      toDate: "20260331",
    });

  it("reads a generated file edited in place as filled", async () => {
    const { tools } = harness();
    const first = await startWorkflow(tools);
    const tdsPath = inputRow(first, "tdsTemplate").path as string;
    appendFileSync(tdsPath, "operator edit", "utf8");
    const second = JSON.parse(
      await tools.get("tb_audit_workflow_status")!({ workflowId: first.workflowId }),
    );
    expect(inputRow(second, "tdsTemplate").status).toBe("filled");
    expect(second.steps.every((s: any) => s.status === "pending")).toBe(true);
  });

  it("lists every workflow when no id is given", async () => {
    const { tools } = harness();
    const first = await startWorkflow(tools);
    const listed = JSON.parse(await tools.get("tb_audit_workflow_status")!({}));
    expect(listed.workflows.map((w: any) => w.workflowId)).toContain(first.workflowId);
  });

  it("accepts a filled template and refuses to approve non-approvable inputs", async () => {
    const { tools } = harness();
    const first = await startWorkflow(tools);
    const tdsPath = inputRow(first, "tdsTemplate").path as string;
    appendFileSync(tdsPath, "checked", "utf8");
    const accepted = JSON.parse(
      await tools.get("tb_audit_workflow_status")!({ workflowId: first.workflowId, accept: ["tdsTemplate"] }),
    );
    expect(inputRow(accepted, "tdsTemplate").status).toBe("accepted");
    await expect(
      tools.get("tb_audit_workflow_status")!({ workflowId: first.workflowId, approve: ["tdsTemplate"] }),
    ).rejects.toThrow(/refused/);
    await expect(
      tools.get("tb_audit_workflow_status")!({ workflowId: first.workflowId, approve: ["gstWorkingSheet"] }),
    ).rejects.toThrow(/refused/);
  });

  it("errors honestly on an unknown workflow id", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_audit_workflow_status")!({ workflowId: "no-such-workflow" }),
    ).rejects.toThrow(/no workflow/);
  });

  it("keeps secret values out of the status response", async () => {
    const { tools } = harness();
    const first = await startWorkflow(tools);
    const text = await tools.get("tb_audit_workflow_status")!({ workflowId: first.workflowId });
    for (const s of secrets) expect(text).not.toContain(s);
  });
});
