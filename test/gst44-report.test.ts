import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Gst44Row } from "../src/gst44.js";
import { GST44_BUCKETS, type Gst44Bucket } from "../src/gst44-law.js";
import {
  gst44Sheets,
  writeGst44Report,
  type Gst44ReportResult,
} from "../src/report.js";
import type { Gst44MaskedFinding, Gst44MaskedParty } from "../src/review.js";
import { createVault } from "../src/vault.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { entry } from "./xlsx.test.js";

// Synthetic pseudonyms and invented figures only: the real operator's party
// names and spend never appear in the repo (captain ruling 2026-09-23, the
// pf-esi.test.ts convention). All sums stay under six digits.
const zeroBuckets = (): Record<Gst44Bucket, number> => ({
  exempt: 0,
  composition: 0,
  others: 0,
  unregistered: 0,
});

const rows: Gst44Row[] = [
  {
    key: "capital",
    label: "Capital Expenditure",
    total: 6700,
    exempt: 2300,
    composition: 1100,
    others: 2100,
    unregistered: 1200,
  },
  {
    key: "revenue",
    label: "Revenue Expenditure",
    total: 9500,
    exempt: 3500,
    composition: 1500,
    others: 3400,
    unregistered: 1100,
  },
];

const finding: Gst44MaskedFinding = {
  id: "GST44-004-1",
  check: "gst44_unattributed_expenditure",
  severity: "warning",
  ledger: "Site Materials",
  group: "Purchase Accounts",
  amount: 900,
  side: null,
  expected: null,
  detail:
    "Site Materials; the entry names no supplier and cannot be attributed to a party or bucket",
};

const party = (over: Partial<Gst44MaskedParty>): Gst44MaskedParty => ({
  party: "Ledger 1",
  override: false,
  ambiguous: false,
  capital: zeroBuckets(),
  revenue: zeroBuckets(),
  ...over,
});

const sampleResult = (): Gst44ReportResult => ({
  company: "Sample Co",
  fromDate: "20250401",
  toDate: "20260331",
  findings: [finding],
  rows,
  parties: [
    party({
      party: "Ledger 1",
      revenue: { ...zeroBuckets(), exempt: 3500, others: 3400 },
    }),
    party({
      party: "Ledger 2",
      capital: { ...zeroBuckets(), composition: 1100 },
    }),
    // all-zero party: must not appear on the long-format Parties sheet
    party({ party: "Ledger 3" }),
  ],
});

describe("gst44Sheets", () => {
  it("builds Findings, Clause 44 and Parties sheets in that order", () => {
    const sheets = gst44Sheets(sampleResult());
    expect(sheets.map((s) => s.name)).toEqual([
      "Findings",
      "Clause 44",
      "Parties",
    ]);
  });

  it("the Clause 44 sheet carries both labels and the bucket columns", () => {
    const sheets = gst44Sheets(sampleResult());
    const clause = sheets[1];
    expect(clause.columns.map((c) => c.header)).toEqual([
      "Row",
      "Total expenditure",
      "Exempt (registered)",
      "Composition",
      "Others (registered)",
      "Unregistered",
    ]);
    expect(clause.rows).toEqual([
      ["Capital Expenditure", 6700, 2300, 1100, 2100, 1200],
      ["Revenue Expenditure", 9500, 3500, 1500, 3400, 1100],
    ]);
    expect(clause.title?.some((t) => t.includes("C5"))).toBe(true);
  });

  it("formats the bucket figures as money", () => {
    const clause = gst44Sheets(sampleResult())[1];
    for (const col of clause.columns.slice(1)) expect(col.format).toBe("money");
  });

  it("the Parties sheet is long-format with only non-zero rows", () => {
    const sheets = gst44Sheets(sampleResult());
    const parties = sheets[2];
    expect(parties.columns.map((c) => c.header)).toEqual([
      "Party",
      "Bucket",
      "Capital",
      "Revenue",
    ]);
    // Ledger 1's revenue exempt+others; Ledger 2's capital composition;
    // Ledger 3 is all zero and must be absent.
    expect(parties.rows).toEqual([
      ["Ledger 1", "exempt", 0, 3500],
      ["Ledger 1", "others", 0, 3400],
      ["Ledger 2", "composition", 1100, 0],
    ]);
    expect(parties.title?.some((t) => t.includes("C6"))).toBe(true);
  });

  it("carries a party's capital and revenue spend in the same bucket row", () => {
    const result = sampleResult();
    result.parties = [
      party({
        party: "Ledger 1",
        revenue: { ...zeroBuckets(), unregistered: 2100 },
        capital: { ...zeroBuckets(), unregistered: 2100 },
      }),
    ];
    const parties = gst44Sheets(result)[2];
    expect(parties.rows).toEqual([["Ledger 1", "unregistered", 2100, 2100]]);
  });
});

describe("writeGst44Report", () => {
  it("writes gst44-review-<slug>-<from>-<to>.xlsx into the report dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gst44-wb-"));
    const vault = createVault();
    const { workbookPath } = await writeGst44Report({
      reportDir: dir,
      result: sampleResult(),
      vault,
    });
    expect(workbookPath).toMatch(
      /gst44-review-sample-co-20250401-20260331\.xlsx$/,
    );
  });

  it("the workbook round-trips: Clause 44 and Parties sheets on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gst44-wb-"));
    const { workbookPath } = await writeGst44Report({
      reportDir: dir,
      result: sampleResult(),
      vault: createVault(),
    });
    const wb = readWorkbook(await readFile(workbookPath));
    expect(wb.map((s) => s.name)).toEqual(["Findings", "Clause 44", "Parties"]);
    const clause = wb.find((s) => s.name === "Clause 44")!;
    // Three title lines ride in rows 1-3, so the header row is row 4.
    const headerRow = clause.rows.find((r) => r.row === 4)!;
    expect(
      [...headerRow.cells.values()].slice(0, 6).map((c) => c.value),
    ).toEqual([
      "Row",
      "Total expenditure",
      "Exempt (registered)",
      "Composition",
      "Others (registered)",
      "Unregistered",
    ]);
    const parties = wb.find((s) => s.name === "Parties")!;
    const partyCells = parties.rows
      .filter((r) => r.row >= 3)
      .flatMap((r) => [...r.cells.values()].map((c) => String(c.value)));
    expect(partyCells.join("|")).toContain("Ledger 1|exempt|0|3500");
    expect(partyCells.join("|")).not.toContain("Ledger 3");
  });

  it("is money-formatted on disk (moneyCol style, Indian grouping)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gst44-wb-"));
    const { workbookPath } = await writeGst44Report({
      reportDir: dir,
      result: sampleResult(),
      vault: createVault(),
    });
    const xml = entry(await readFile(workbookPath), "xl/styles.xml");
    expect(xml).toContain("#,##,##0.00");
  });

  it("writeWorkbook de-masks the party pseudonyms on disk, both sheets", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sample Contractor & Co", "other");
    const result = sampleResult();
    result.parties = [
      party({ party: alias, revenue: { ...zeroBuckets(), others: 900 } }),
    ];
    result.findings = [
      {
        ...finding,
        ledger: alias,
        detail: `${alias}: monthly hire was recorded but no operator status covers the party`,
      },
    ];
    const dir = await mkdtemp(join(tmpdir(), "gst44-demask-"));
    const { workbookPath } = await writeGst44Report({
      reportDir: dir,
      result,
      vault,
    });
    const wb = readWorkbook(await readFile(workbookPath));
    const partiesXml = entry(
      await readFile(workbookPath),
      "xl/worksheets/sheet3.xml",
    );
    expect(partiesXml).not.toContain(alias);
    // The raw XML escapes the ampersand; the reader further down un-escapes it.
    expect(partiesXml).toContain("Sample Contractor &amp; Co");
    const findXml = entry(
      await readFile(workbookPath),
      "xl/worksheets/sheet1.xml",
    );
    expect(findXml).toContain("Sample Contractor &amp; Co");
    expect(findXml).not.toContain(alias);
    const clauseXml = entry(
      await readFile(workbookPath),
      "xl/worksheets/sheet2.xml",
    );
    expect(clauseXml).not.toContain("Ledger");
    // The reader un-escapes, so the real name must appear in the grid too.
    const joined = wb
      .map((s) =>
        [...s.rows.values()]
          .flatMap((r) => [...r.cells.values()].map((c) => String(c.value)))
          .join("|"),
      )
      .join("|");
    expect(joined).toContain("Sample Contractor & Co");
    expect(joined).not.toContain(alias);
  });
});
