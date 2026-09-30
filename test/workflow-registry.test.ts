import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import {
  WORKFLOW_INPUTS,
  WORKFLOW_STEPS,
  stepById,
  stepDirName,
} from "../src/workflow-registry.js";

function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  const registrar: ToolRegistrar = (name) => {
    names.add(name);
  };
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  registerTools(registrar, session, { reportDir: mkdtempSync(join(tmpdir(), "tally-agent-")) }, "20260331T100000Z");
  return names;
}

describe("workflow registry integrity", () => {
  const tools = registeredToolNames();

  it("registers every step input key in the input table", () => {
    for (const step of WORKFLOW_STEPS) {
      for (const si of step.inputs) {
        expect(WORKFLOW_INPUTS[si.key], `${step.id} input ${si.key}`).toBeDefined();
      }
    }
  });

  it("names only existing steps in after", () => {
    for (const step of WORKFLOW_STEPS) {
      for (const dep of step.after ?? []) {
        expect(stepById(dep), `${step.id} after ${dep}`).toBeDefined();
      }
    }
  });

  it("uses only registered tools in actions and generators", () => {
    for (const step of WORKFLOW_STEPS) {
      for (const action of step.actions) {
        expect(tools.has(action.tool), `${step.id} action ${action.tool}`).toBe(true);
      }
    }
    for (const input of Object.values(WORKFLOW_INPUTS)) {
      if (input.generator) {
        expect(tools.has(input.generator.tool), `${input.key} generator ${input.generator.tool}`).toBe(true);
      }
    }
  });

  it("has unique step ids and a 01..NN directory name", () => {
    const ids = WORKFLOW_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(stepDirName(WORKFLOW_STEPS[0], 0)).toBe("01-gst_working_sheet");
    expect(stepDirName(WORKFLOW_STEPS[WORKFLOW_STEPS.length - 1], WORKFLOW_STEPS.length - 1)).toBe(
      `${String(WORKFLOW_STEPS.length).padStart(2, "0")}-tds_payable`,
    );
  });

  it("keeps the steps of the plan in order", () => {
    expect(WORKFLOW_STEPS.map((s) => s.id)).toEqual([
      "gst_working_sheet",
      "gst44",
      "tds",
      "notds",
      "as26",
      "depreciation",
      "dep3cd",
      "fa_register",
      "pf_esi",
      "loans",
      "tds_payable",
    ]);
  });

  it("marks only the working sheet approvable and only the decision workbooks stepOnly", () => {
    const approvables = Object.values(WORKFLOW_INPUTS).filter((i) => i.approvable).map((i) => i.key);
    expect(approvables).toEqual(["gstWorkingSheet"]);
    const stepOnly = Object.values(WORKFLOW_INPUTS).filter((i) => i.generator?.stepOnly).map((i) => i.key);
    expect(stepOnly).toEqual(["notdsTemplate", "payableDecisions"]);
  });
});
