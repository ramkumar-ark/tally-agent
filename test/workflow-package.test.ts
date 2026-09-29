import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVault } from "../src/vault.js";
import { newManifest, saveManifest } from "../src/workflow-state.js";
import {
  assertInside,
  autoNarrative,
  copyNoClobber,
  countFindings,
  renderIndex,
  summaryJson,
  uniquePath,
  workflowFindingsCsv,
} from "../src/workflow-package.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "wf-pkg-"));

describe("uniquePath", () => {
  it("returns the plain name when free, then (2), then (3), never an existing file", async () => {
    const dir = scratch();
    expect(await uniquePath(dir, "a.xlsx")).toBe(join(dir, "a.xlsx"));
    writeFileSync(join(dir, "a.xlsx"), "1", "utf8");
    expect(await uniquePath(dir, "a.xlsx")).toBe(join(dir, "a (2).xlsx"));
    writeFileSync(join(dir, "a (2).xlsx"), "2", "utf8");
    expect(await uniquePath(dir, "a.xlsx")).toBe(join(dir, "a (3).xlsx"));
  });
});

describe("copyNoClobber", () => {
  it("copies under the original name, then next to it as (2), never overwriting", async () => {
    const dir = scratch();
    const src = join(dir, "src.xlsx");
    writeFileSync(src, "content", "utf8");
    const outDir = scratch();
    const first = await copyNoClobber(src, outDir);
    expect(first).toBe(join(outDir, "src.xlsx"));
    const second = await copyNoClobber(src, outDir);
    expect(second).toBe(join(outDir, "src (2).xlsx"));
    expect(readFileSync(first, "utf8")).toBe("content");
    expect(readFileSync(second, "utf8")).toBe("content");
  });
});

describe("assertInside", () => {
  it("accepts paths under the root, including not-yet-created leaves", async () => {
    const root = scratch();
    const leaf = join(root, "pass-01-x", "01-step", "out.xlsx");
    await expect(assertInside(root, leaf)).resolves.toBe(leaf);
  });

  it("rejects ../ escapes and outside absolute paths", async () => {
    const root = scratch();
    const escape = join(root, "..", "evil.xlsx");
    await expect(assertInside(root, escape)).rejects.toThrow(/outside the workflow folder/);
    await expect(assertInside(root, join(scratch(), "other.xlsx"))).rejects.toThrow(
      /outside the workflow folder/,
    );
  });
});

describe("countFindings and autoNarrative", () => {
  it("counts severities", () => {
    expect(
      countFindings({
        findings: [
          { severity: "critical" },
          { severity: "warning" },
          { severity: "warning" },
          { severity: "review" },
          { severity: "junk" },
        ],
      }),
    ).toEqual({ critical: 1, warning: 2, review: 1 });
  });

  it("keeps every number grouped so no bare 6+-digit run appears", () => {
    const findings = Array.from({ length: 1234567 }, (_, i) => ({
      check: `check_${i % 3}`,
      severity: "warning",
    }));
    const text = autoNarrative("TDS review", { findings });
    expect(text).toMatch(/^# TDS review\n/);
    expect(text).not.toMatch(/\d{6,}/);
    expect(text).toContain("12,34,567 findings");
  });

  it("renders per (check, severity) rows sorted by count descending", () => {
    const text = autoNarrative("Review", {
      findings: [
        { check: "tds_not_deducted", severity: "critical" },
        { check: "tds_not_deducted", severity: "critical" },
        { check: "tds_not_deducted", severity: "critical" },
        { check: "tds_master_gap", severity: "warning" },
      ],
    });
    expect(text).toContain("| tds_not_deducted | critical | 3 |");
    expect(text).toContain("| tds_master_gap | warning | 1 |");
    expect(text.indexOf("tds_not_deducted")).toBeLessThan(text.indexOf("tds_master_gap"));
  });
});

describe("workflowFindingsCsv", () => {
  it("de-masks party and detail through the vault", () => {
    const v = createVault();
    const alias = v.pseudonym("Acme Traders", "debtor");
    const csv = workflowFindingsCsv(
      [
        {
          id: "TDS-001-1",
          check: "tds_not_deducted",
          severity: "critical",
          party: alias,
          amount: 1234.5,
          detail: `shortfall for ${alias} in Dec`,
        },
      ],
      v,
    );
    expect(csv).toContain("Acme Traders");
    expect(csv).not.toContain(alias);
    expect(csv).toContain("1234.50");
    expect(csv.split("\n")[0]).toBe("id,check,severity,party,amount,detail");
  });
});

describe("renderIndex", () => {
  it("prints basenames and digest prefixes only, and leaks no secret value", () => {
    const dir = scratch();
    const fixturePath = fileURLToPath(new URL("./fixtures/secrets.json", import.meta.url));
    const secrets = JSON.parse(readFileSync(fixturePath, "utf8")) as string[];
    const m = newManifest(
      { company: "Workflow Test Co", fromDate: "20250401", toDate: "20260331", asOnDate: "20260331" },
      {
        dayBook: { status: "present", path: join(dir, "daybook.json"), digest: "d".repeat(64) },
        tdsTemplate: { status: "accepted", path: join(fixturePath), digest: "e".repeat(64) },
      },
      ["tds"],
      "wf-1",
    );
    m.steps.tds = {
      status: "done",
      outputs: [join(dir, "pass-01-x", "03-tds", "tds-report.md")],
      findings: { critical: 1, warning: 0, review: 2 },
    };
    m.passes.push({
      n: 1,
      dir: join(dir, "pass-01-x"),
      startedAt: "2026-09-30T10:00:00Z",
      closedAt: "2026-09-30T10:05:00Z",
      plan: ["tds"],
      recorded: [{ id: "as26", state: "needs-input", missing: ["as26Export", "as26Map"] }],
    });
    const text = renderIndex(m, 1);
    expect(text).toContain("Workflow Test Co");
    expect(text).toContain("`daybook.json`");
    expect(text).toContain("dddddddddddd");
    expect(text).not.toContain(dir); // full paths never render, basenames do
    expect(text).not.toContain(fixturePath);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).toContain("## Needs your input");
    expect(text).toContain("blocks step `as26`");
  });

  it("lists skipped reasons, failures and carried-forward steps", () => {
    const m = newManifest(
      { company: "C", fromDate: "20250401", toDate: "20260331", asOnDate: "20260331" },
      undefined,
      undefined,
      "wf-2",
    );
    m.tallyReachable = false;
    m.steps.loans = { status: "done", outputs: [], notes: ["skipped: Winman loans workbook not given"] };
    m.steps.tds = { status: "failed", error: "boom" };
    m.passes.push({
      n: 1,
      dir: "pass-01-x",
      startedAt: "2026-09-30T10:00:00Z",
      plan: ["tds", "loans"],
      recorded: [{ id: "depreciation", state: "needs-tally" }],
    });
    const text = renderIndex(m, 1);
    expect(text).toContain("Tally is not reachable");
    expect(text).toContain("Winman loans workbook not given");
    expect(text).toContain("## Failed");
    expect(text).toContain("boom");
  });
});

describe("summaryJson", () => {
  it("summarises the pass steps, needs-input list and inputs", async () => {
    const dir = scratch();
    const m = newManifest(
      { company: "C", fromDate: "20250401", toDate: "20260331", asOnDate: "20260331" },
      { pfEsiTemplate: { status: "accepted", path: join(dir, "p.xlsx"), digest: "a".repeat(64) } },
      ["pf_esi"],
      "wf-3",
    );
    m.inputs.dayBook = { status: "present", path: join(dir, "d.json"), digest: "b".repeat(64) };
    m.steps.pf_esi = { status: "done", outputs: [join(dir, "out.xlsx")], findings: { critical: 0, warning: 1, review: 0 } };
    await saveManifest(dir, m);
    m.passes.push({ n: 1, dir: "pass-01-x", startedAt: "s", closedAt: "c", plan: ["pf_esi"], recorded: [] });
    const summary = summaryJson(m, 1) as Record<string, any>;
    expect(summary.company).toBe("C");
    expect(summary.closedAt).toBe("c");
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0].status).toBe("done");
    expect(summary.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "pfEsiTemplate", file: "p.xlsx", digest12: "a".repeat(12) }),
      ]),
    );
    expect(existsSync(join(dir, "workflow.json"))).toBe(true);
  });
});
