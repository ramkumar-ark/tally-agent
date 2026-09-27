import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDayBook } from "../src/tds-daybook.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { make3bWorkbook } from "./helpers/gst-adj-3b.js";
import { make2bWorkbook } from "./helpers/gst-adj-2b.js";

describe("gstAdjReview", () => {
  const threeB = make3bWorkbook({
    companyName: "Test Constructions",
    gstin: "33AAAAA0000A0Z0",
    state: "Tamil Nadu",
    months: ["April ", "May", "June"],
    rows: [
      { label: "Sales summary", values: [1000, 1000, 1000] },
      { label: "Tax on outward supply", values: [0, 0, 0] },
      { label: "IGST on outward supply", values: [0, 309.09, 0] },
      { label: "CGST on outward supply", values: [0, 303.03, 0] },
      { label: "SGST on outward supply", values: [0, 303.03, 0] },
      { label: "Cess on outward supply", values: [0, 0, 0] },
      { label: "Net ITC available (a-b)", values: [0, 0, 0] },
      { label: "IGST net ITC", values: [0, 0, 100] },
      { label: "CGST net ITC", values: [0, 0, 100] },
      { label: "SGST net ITC", values: [0, 0, 100] },
      { label: "Cess net ITC", values: [0, 0, 100] },
      { label: "Table 12", values: [0, 0, 0] },
    ],
  });

  const dayBook = readDayBook(
    JSON.stringify({
      tallyAgentExport: 1,
      company: "Test Constructions",
      fromDate: "20250401",
      toDate: "20260331",
      groups: [{ name: "Indirect Expenses", parent: "" }],
      ledgers: [
        { name: "Input CGST A/c", parent: "Indirect Expenses" },
        { name: "Output CGST A/c", parent: "Indirect Expenses" },
        { name: "Input SGST A/c", parent: "Indirect Expenses" },
        { name: "Output SGST A/c", parent: "Indirect Expenses" },
        { name: "Input CGST To Be Booked A/c", parent: "Indirect Expenses" },
      ],
      vouchers: [
        {
          date: "20250501",
          voucherType: "Journal",
          voucherNumber: "1",
          partyLedgerName: "",
          entries: [
            { ledger: "Input CGST A/c", amount: -100 },
            { ledger: "Output CGST A/c", amount: 400 },
          ],
        },
        {
          date: "20250531",
          voucherType: "Journal",
          voucherNumber: "2",
          partyLedgerName: "",
          entries: [
            { ledger: "Input CGST A/c", amount: -50 },
            { ledger: "Output SGST A/c", amount: 300 },
          ],
        },
      ],
    }),
    { fromDate: "20250401", toDate: "20260331" },
  );

  const itc2bDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "gst-adj-2b-"));
    await writeFile(
      join(dir, "apr.xlsx"),
      make2bWorkbook({
        period: "1-Apr-25 to 30-Apr-25",
        layout: "v2",
        sheetName: "Not Reflected",
        rows: [{ date: 45741, party: "P1", igst: 50, cgst: 25, sgst: 25, cess: 0 }],
      }),
    );
    await writeFile(
      join(dir, "may.xlsx"),
      make2bWorkbook({
        period: "1-May-25 to 31-May-25",
        layout: "v2",
        sheetName: "Other Sheet",
        rows: [{ date: 45772, party: "P2", igst: 30, cgst: 15, sgst: 15, cess: 0 }],
      }),
    );
    return dir;
  };

  it("writes both files and returns a masked summary from the day book", async () => {
    const d = fakeDownstream({});
    const s = createSession(d, EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const dir = await mkdtemp(join(tmpdir(), "gst-adj-out-"));
    const threeBPath = join(dir, "gst-adjustments-2025.xlsx");
    await writeFile(threeBPath, threeB);
    const idb2 = await itc2bDir();

    const result = await s.gstAdjReview({
      company: "Test Constructions",
      threeBPath,
      itc2bPath: idb2,
      dayBook,
    });

    expect(result.fy).toBe("2025");
    expect(result.months).toEqual(["2025-04", "2025-05", "2025-06"]);
    expect(result.paperPath).toContain("gst-adjustments-2025-working-paper.md");
    expect(result.importPath).toContain("gst-adjustments-2025.json");

    for (const s of result.summary) {
      expect(s).not.toHaveProperty("companyName");
      expect(s).not.toHaveProperty("gstin");
      for (const h of s.heads) {
        expect(typeof h.amount).toBe("number");
      }
    }

    for (const f of result.findings) {
      expect(f.detail).not.toContain("Test Constructions");
      expect(f.detail).not.toContain("33AAAAA0000A0Z0");
    }

    const paper = await readFile(result.paperPath, "utf8");
    expect(paper).toContain("Month × Kind × Head");
    const importBuf = await readFile(result.importPath);
    expect(importBuf.length).toBeGreaterThan(0);
  });

  it("surfaces a degrade warning instead of throwing when 2B is absent", async () => {
    const d = fakeDownstream({});
    const s = createSession(d, EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const dir = await mkdtemp(join(tmpdir(), "gst-adj-out-"));
    const threeBPath = join(dir, "gst-adjustments-2025.xlsx");
    await writeFile(threeBPath, threeB);

    const result = await s.gstAdjReview({
      company: "Test Constructions",
      threeBPath,
      dayBook,
    });

    expect(result.paperPath).toContain("gst-adjustments-2025-working-paper.md");
    expect(result.importPath).toContain("gst-adjustments-2025.json");
  });

  it("ABORTS with gadj_registration_mismatch when config disagrees with workbook", async () => {
    const d = fakeDownstream({});
    const s = createSession(d, EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
    const dir = await mkdtemp(join(tmpdir(), "gst-adj-out-"));
    const threeBPath = join(dir, "gst-adjustments-2025.xlsx");
    await writeFile(threeBPath, threeB);

    await writeFile(
      join(dir, "cfg.json"),
      JSON.stringify({ registration: "27ABCDE1234F1Z0", heads: {} }),
    );

    const result = await s.gstAdjReview({
      company: "Test Constructions",
      threeBPath,
      dayBook,
      gstAdjConfigPath: join(dir, "cfg.json"),
    });

    expect(result.findings.some((f) => f.id === "gadj_registration_mismatch")).toBe(true);
    expect(result.paperPath).toBeFalsy();
    expect(result.importPath).toBeFalsy();
  });
});
