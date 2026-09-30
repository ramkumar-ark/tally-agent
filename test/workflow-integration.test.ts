import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import type { Downstream } from "../src/downstream.js";

/**
 * The workflow tools driven through the REAL handler map: start generates the
 * PF/ESI template into to-fill/, accept marks it filled-by-operator, and run
 * executes the pf_esi step end-to-end (review → report → Winman fill skipped)
 * packaging everything into the pass folder. Synthetic ledgers only.
 */
describe("audit workflow, real handlers, pf_esi lane", () => {
  it("start → accept → run packages the pass folder", async () => {
    const stub = Object.assign(fakeDownstream(), {
      groups: async () => [
        { name: "Current Liabilities", parent: "\u0004 Primary" },
        { name: "Indirect Expenses", parent: "\u0004 Primary" },
      ],
      ledgers: async () => [
        { name: "Staff PF Payable", parent: "Current Liabilities", openingBalance: 0, closingBalance: -1000 },
        { name: "Staff Wages", parent: "Indirect Expenses", openingBalance: 0, closingBalance: 1000 },
      ],
      vouchers: async () => [
        {
          date: "20250430", voucherType: "Jrnl", voucherNumber: "J-1", partyLedgerName: "", cancelled: false,
          entries: [{ ledger: "Staff Wages", amount: 2000 }, { ledger: "Staff PF Payable", amount: -2000 }],
        },
      ],
    } as never) as Downstream;

    const tools = new Map<string, (args: any) => Promise<string>>();
    const registrar: ToolRegistrar = (name, _d, _s, h) => tools.set(name, h);
    const reportDir = mkdtempSync(join(tmpdir(), "wf-int-"));
    registerTools(registrar, createSession(stub, EMPTY_OVERRIDES), { reportDir, dayBookMaxBytes: 64 * 1024 * 1024 }, "20260331T100000Z");

    const dayBookPath = join(reportDir, "daybook.json");
    writeFileSync(
      dayBookPath,
      JSON.stringify({
        company: "Workflow Test Co",
        groups: [
          { name: "Current Liabilities", parent: "\u0004 Primary" },
          { name: "Indirect Expenses", parent: "\u0004 Primary" },
        ],
        ledgers: [
          { name: "Staff PF Payable", parent: "Current Liabilities" },
          { name: "Staff Wages", parent: "Indirect Expenses" },
        ],
        vouchers: [
          {
            date: "20250430", voucherType: "Jrnl", voucherNumber: "J-1", partyLedgerName: "", isCancelled: false,
            entries: [{ LEDGERNAME: "Staff Wages", AMOUNT: 2000 }, { LEDGERNAME: "Staff PF Payable", AMOUNT: -2000 }],
          },
        ],
      }),
      "utf8",
    );

    const start = JSON.parse(
      await tools.get("tb_audit_workflow_start")!({
        company: "Workflow Test Co",
        fromDate: "20250401",
        toDate: "20260331",
        steps: ["pf_esi"],
        inputs: { dayBook: dayBookPath },
      }),
    );
    const pfTemplate = start.inputs.find((i: any) => i.key === "pfEsiTemplate");
    expect(pfTemplate.status).toBe("generated-unfilled");
    expect(existsSync(pfTemplate.path)).toBe(true);
    expect(start.inputs.find((i: any) => i.key === "dayBook").status).toBe("present");

    // The operator accepts the generated workbook AS IS (an empty PF/ESI
    // template needs no edits) — accepted lifts generated-unfilled.
    const accepted = JSON.parse(
      await tools.get("tb_audit_workflow_status")!({
        workflowId: start.workflowId,
        accept: ["pfEsiTemplate"],
      }),
    );
    expect(accepted.inputs.find((i: any) => i.key === "pfEsiTemplate").status).toBe("accepted");

    const run = JSON.parse(await tools.get("tb_audit_workflow_run")!({ workflowId: start.workflowId }));
    expect(run.step.id).toBe("pf_esi");
    expect(["done", "partial"]).toContain(run.step.status);
    expect(run.step.notes.join(" ")).toMatch(/Winman PF\/ESI workbook not given/);
    expect(run.passClosed).toBe(true);

    const stepDir = readdirSync(join(run.passDir, "09-pf_esi"));
    expect(stepDir.some((f) => f.endsWith(".xlsx"))).toBe(true);
    const inputsDir = readdirSync(join(run.passDir, "inputs"));
    expect(inputsDir).toContain("inputs.json");
    expect(inputsDir.some((f) => f.endsWith(".xlsx"))).toBe(true);
    expect(existsSync(join(run.passDir, "INDEX.md"))).toBe(true);
    expect(existsSync(join(reportDir, "audit-workflows", start.workflowId, "LATEST.txt"))).toBe(true);
  });
});
