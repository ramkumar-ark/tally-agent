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
  it("exposes exactly the seven approved tools", () => {
    const { tools } = harness();
    expect([...tools.keys()].sort()).toEqual([
      "tb_gst_mismatch",
      "tb_gst_summary",
      "tb_ledger_activity",
      "tb_list_companies",
      "tb_review",
      "tb_write_gst_report",
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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

describe("tb_gst_summary", () => {
  it("returns the aggregate tax picture with no party data and no GSTIN", async () => {
    const { tools } = harness();
    const out = await tools.get("tb_gst_summary")!({ fromDate: "20250401", toDate: "20260331" });
    const parsed = JSON.parse(out);
    expect(parsed.heads).toHaveLength(5);
    expect(parsed.totals.netLiability).toBe(11700);
    // Duties & Taxes is a clear root: recognized tax ledger names pass.
    expect(parsed.taxLedgers.some((r: any) => r.ledger === "Output CGST")).toBe(true);
    expect(out).not.toContain("27AAAAA0000A1Z5");
    expect(out).not.toContain("Acme Traders");
  });

  it("skips the prior-year voucher (range re-filter) in the scan counts", async () => {
    const { tools } = harness();
    const parsed = JSON.parse(
      await tools.get("tb_gst_summary")!({ fromDate: "20250401", toDate: "20260331" }),
    );
    // 7 fixture vouchers: 1 out-of-period dropped, 1 cancelled skipped.
    expect(parsed.vouchersScanned).toBe(5);
    expect(parsed.cancelledSkipped).toBe(1);
  });
});

describe("tb_gst_mismatch", () => {
  it("compares books against a returns file by path, with masked findings only", async () => {
    const { tools } = harness();
    const returnsPath = join(mkdtempSync(join(tmpdir(), "gst-returns-")), "returns.json");
    writeFileSync(
      returnsPath,
      readFileSync(new URL("./fixtures/gst-returns.json", import.meta.url), "utf8"),
    );
    const out = await tools.get("tb_gst_mismatch")!({
      fromDate: "20250401",
      toDate: "20260331",
      returnsPath,
    });
    const parsed = JSON.parse(out);
    expect(parsed.counts).toEqual({ critical: 0, warning: 3, review: 1 });
    const ids = parsed.findings.map((f: any) => f.id);
    expect(ids.some((id: string) => id.startsWith("GST-"))).toBe(true);
    // Masked: alias pseudonyms in, raw identities and file contents out.
    expect(out).not.toContain("27AAAAA0000A1Z5");
    expect(out).not.toContain("Acme Traders");
    expect(out).not.toContain("Ghost Supplies");
    expect(parsed.findings.map((f: any) => f.ledger)).toContain("Creditor 1");
    expect(parsed.findings.map((f: any) => f.detail).join("\n")).toContain("TaxId 1");
  });

  it("rejects a malformed returns file citing the row, never echoing the value", async () => {
    const { tools } = harness();
    const returnsPath = join(mkdtempSync(join(tmpdir(), "gst-bad-")), "returns.json");
    writeFileSync(
      returnsPath,
      JSON.stringify({
        returns: [
          { gstin: "27AAAAA0000A1Z5", kind: "outward", taxableValue: 1 },
          { gstin: "not-a-gstin", kind: "inward" },
        ],
      }),
    );
    await expect(
      tools.get("tb_gst_mismatch")!({ fromDate: "20250401", toDate: "20260331", returnsPath }),
    ).rejects.toThrow(/row 2: gstin/);
  });

  it("refuses a missing returns file path", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_gst_mismatch")!({
        fromDate: "20250401",
        toDate: "20260331",
        returnsPath: join(mkdtempSync(join(tmpdir(), "gst-none-")), "missing.json"),
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("tb_write_gst_report", () => {
  it("refuses when no GST mismatch has been run", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_write_gst_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        markdown: "# GST",
      }),
    ).rejects.toThrow(/run tb_gst_mismatch first/i);
  });

  it("writes both artifacts with real names and GSTINs restored on disk only", async () => {
    const { tools } = harness();
    const returnsPath = join(mkdtempSync(join(tmpdir(), "gst-returns-")), "returns.json");
    writeFileSync(
      returnsPath,
      readFileSync(new URL("./fixtures/gst-returns.json", import.meta.url), "utf8"),
    );
    await tools.get("tb_gst_mismatch")!({
      fromDate: "20250401",
      toDate: "20260331",
      returnsPath,
    });
    // The narrative composes in masked terms; the writer de-masks downward.
    const out = await tools.get("tb_write_gst_report")!({
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "# GST review\n\nSee Creditor 1 under TaxId 1.",
    });
    const parsed = JSON.parse(out);
    expect(parsed.markdownPath).toMatch(/gst-review-.*\.md$/);
    expect(parsed.csvPath).toMatch(/gst-findings-.*\.csv$/);
    const md = await readFile(parsed.markdownPath, "utf8");
    const csv = await readFile(parsed.csvPath, "utf8");
    // De-masked on disk: party names restored, and the TaxId alias replaced
    // by a real 15-char GSTIN (alias number↔party mapping is session-minted,
    // so assert the shape and the absence of aliases, not a specific pair).
    expect(md).toContain("Acme Traders");
    expect(md).toMatch(/\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}/);
    expect(md).not.toContain("TaxId");
    expect(md).not.toContain("Creditor 1");
    expect(csv).toContain("Acme Traders");
    expect(csv).not.toContain("Creditor 1");
    expect(out).not.toContain("27AAAAA0000A1Z5");
  });

  it("the findings CSV keeps the M1 columns with side/expected empty for GST rows", async () => {
    const { tools } = harness();
    const returnsPath = join(mkdtempSync(join(tmpdir(), "gst-returns-")), "returns.json");
    writeFileSync(
      returnsPath,
      readFileSync(new URL("./fixtures/gst-returns.json", import.meta.url), "utf8"),
    );
    await tools.get("tb_gst_mismatch")!({ fromDate: "20250401", toDate: "20260331", returnsPath });
    const out = await tools.get("tb_write_gst_report")!({
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "# GST",
    });
    const csv = await readFile(JSON.parse(out).csvPath, "utf8");
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "id,check,severity,ledger,group,amount,side,expected,detail",
    );
    for (const row of lines.slice(1)) {
      const cols = row.split(",");
      expect(cols[6]).toBe("");
      expect(cols[7]).toBe("");
    }
  });
});

describe("tb_ledger_activity on GST findings", () => {
  it("drills into a book-party GST finding by id, returning masked rows", async () => {
    const { tools } = harness();
    const returnsPath = join(mkdtempSync(join(tmpdir(), "gst-returns-")), "returns.json");
    writeFileSync(
      returnsPath,
      readFileSync(new URL("./fixtures/gst-returns.json", import.meta.url), "utf8"),
    );
    const out = await tools.get("tb_gst_mismatch")!({
      fromDate: "20250401",
      toDate: "20260331",
      returnsPath,
    });
    const parsed = JSON.parse(out);
    // Pick a book-party finding (registered for drill-down).
    const f = parsed.findings.find(
      (x: any) => x.id.startsWith("GST-") && x.group !== "GST Return",
    );
    expect(f).toBeTruthy();
    const rows = JSON.parse(
      await tools.get("tb_ledger_activity")!({
        findingId: f.id,
        fromDate: "20250401",
        toDate: "20260331",
      }),
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("27AAAAA0000A1Z5");
    // Returns-only findings are not drillable: no book ledger exists to walk.
    const ro = parsed.findings.find((x: any) => x.group === "GST Return");
    expect(ro).toBeTruthy();
    await expect(
      tools.get("tb_ledger_activity")!({ findingId: ro.id, fromDate: "20250401", toDate: "20260331" }),
    ).rejects.toThrow(/unknown finding id/i);
  });
});
