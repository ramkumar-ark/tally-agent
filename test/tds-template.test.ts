import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildTemplateWorkbook, SECTION_KEYS, templateFileName } from "../src/tds-template.js";

const build = () => readWorkbook(buildTemplateWorkbook("Sample Company"));
const sheetOf = (sheets: ReturnType<typeof build>, name: string) => {
  const s = sheets.find((x) => x.name === name);
  if (!s) throw new Error(`missing sheet ${name}`);
  return s;
};

/** The template's preamble is one Instructions row block; data sheets have none. */
const headerCells = (sheet: ReturnType<typeof build>[number]): string[] => {
  const row = sheet.rows[0];
  return [...row.cells.entries()].sort(([a], [b]) => a - b).map(([, c]) => String(c.value));
};

describe("the generated TDS template", () => {
  it("carries exactly seven sheets by name", () => {
    expect(build().map((s) => s.name)).toEqual([
      "Instructions", "Settings", "Sections", "Parties", "Certificates", "Challans", "Statements",
    ]);
  });

  it("gives Parties six headers with TDS Applicable at B and no Section column", () => {
    const parties = build().find((s) => s.name === "Parties")!;
    expect(headerCells(parties)).toEqual([
      "Tally Ledger Name",
      "TDS Applicable",
      "PAN",
      "Transporter Declaration 194C(6)",
      "Deductee Filed Return s.201(1)",
      "Winman Deductee Name",
    ]);
  });

  it("gives Sections exactly three headers", () => {
    const sections = build().find((s) => s.name === "Sections")!;
    expect(headerCells(sections)).toEqual(["Tally Ledger Name", "Section", "Ledger Kind"]);
  });

  it("ships the data sheets empty so the parser never skips demo rows", () => {
    // Each data sheet's first row is its header row; nothing beyond it.
    for (const name of ["Sections", "Parties", "Certificates", "Challans", "Statements"]) {
      const s = build().find((x) => x.name === name)!;
      expect(s.rows).toHaveLength(1);
    }
  });

  it("pre-fills the Settings sheet with 194Q Applicable = Y", () => {
    const settings = build().find((s) => s.name === "Settings")!;
    expect(headerCells(settings)).toEqual(["Setting", "Value"]);
    expect(settings.rows).toHaveLength(2);
    expect([...settings.rows[1].cells.values()].map((c) => c.value)).toEqual(["194Q Applicable", "Y"]);
  });

  it("states the seven tasks the instructions must name, Sections first", () => {
    const instructions = build().find((s) => s.name === "Instructions")!;
    const text = [...instructions.rows.flatMap((r) => [...r.cells.values()].map((c) => c.value))].join("\n");
    expect(text).toContain(
      "The Sections sheet drives this whole check. A booking's TDS section is decided by the expense (or nature-of-payment) ledger it is booked to, and by nothing else.",
    );
    expect(text).toContain("paste its rows into chat");
    expect(text).toContain("Leave a cell blank");
    expect(text).toContain("text format");
    expect(text).toContain("Sample Builders LLP");
  });

  it("is a spreadsheet the project's own reader can round-trip (dropdowns ride the workbook, not the parser)", () => {
    const buf = buildTemplateWorkbook();
    const sheets = readWorkbook(buf);
    expect(sheets).toHaveLength(7);
    expect(sheets.every((s) => s.state === "visible")).toBe(true);
  });

  it("exposes all eight law keys including the 194-I split, and never a bare 194-I", () => {
    expect(SECTION_KEYS).toEqual(["194C", "194J", "194-I(a)", "194-I(b)", "194A", "194H", "194Q", "194T"]);
    expect(SECTION_KEYS).not.toContain("194-I");
  });

  it("names the file tds-operator-template-<company|all>-<date>.xlsx", () => {
    expect(templateFileName("Acme Associates", "20260916")).toBe("tds-operator-template-acme-associates-20260916.xlsx");
    expect(templateFileName(undefined, "20260916")).toBe("tds-operator-template-all-20260916.xlsx");
  });
});
