import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildTemplateWorkbook, SECTION_KEYS, templateFileName } from "../src/tds-template.js";
import { entry } from "./xlsx.test.js";

const bufCache = buildTemplateWorkbook("Sample Company");
const build = () => readWorkbook(bufCache);
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
  it("carries exactly nine sheets by name, the hidden TCS Natures list last", () => {
    expect(build().map((s) => s.name)).toEqual([
      "Instructions", "Settings", "Sections", "Parties", "Certificates", "Challans", "Statements",
      "TCS Sections", "Interest Paid", "TCS Natures",
    ]);
    const natures = build().find((s) => s.name === "TCS Natures")!;
    expect(natures.state).toBe("hidden");
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
    for (const name of ["Sections", "Parties", "Certificates", "Challans", "Statements", "TCS Sections", "Interest Paid"]) {
      const s = build().find((x) => x.name === name)!;
      expect(s.rows).toHaveLength(1);
    }
  });

  it("gives TCS Sections the two brief columns with the nature dropdown backed by the hidden list range", () => {
    const tcs = build().find((s) => s.name === "TCS Sections")!;
    expect(headerCells(tcs)).toEqual(["Ledger", "Nature of receipt (exact Winman text)"]);
    const xml = entry(bufCache, "xl/worksheets/sheet8.xml");
    expect(xml).toContain("<formula1>'TCS Natures'!$A$2:$A$14</formula1>");
  });

  it("gives Interest Paid the four brief columns with the interest-form union as the Form dropdown", () => {
    const interest = build().find((s) => s.name === "Interest Paid")!;
    expect(headerCells(interest)).toEqual(["Form", "Quarter (Q1-Q4)", "Amount", "Paid on"]);
    const xml = entry(bufCache, "xl/worksheets/sheet9.xml");
    expect(xml).toContain("<formula1>\"24Q,26A,26Q,26QB,27Q,27EQ\"</formula1>");
    expect(xml).toContain("<formula1>\"Q1,Q2,Q3,Q4\"</formula1>");
  });

  it("backs the nature dropdown by the 13 exact TCS_NATURES winman strings on the hidden sheet", () => {
    const natures = build().find((s) => s.name === "TCS Natures")!;
    expect(headerCells(natures)).toEqual(["Nature of receipt (exact Winman text)"]);
    const values = natures.rows.slice(1).flatMap((r) => [...r.cells.values()].map((c) => c.value));
    expect(values).toEqual([
      "Liquor", "Minerals-coal/lignite/iron ore", "Mining & Quarrying Lease", "Motor vehicle",
      "Overseas Tour package", "Parking Lot Lease", "Remittance under LRS",
      "Sale of Notified goods u/s 206C(1F)(ii)", "Scrap", "Tendu leaves",
      "Timber or other forest product(except tendu leaves)-Forest Lease", "Timber-Others", "Toll Plaza Lease",
    ]);
  });

  it("pre-fills the Settings sheet with 194Q Applicable = Y, Late Deduction Interest = Y and a blank TAN row", () => {
    const settings = build().find((s) => s.name === "Settings")!;
    expect(headerCells(settings)).toEqual(["Setting", "Value"]);
    expect(settings.rows).toHaveLength(4);
    expect([...settings.rows[1].cells.values()].map((c) => c.value)).toEqual(["194Q Applicable", "Y"]);
    expect([...settings.rows[2].cells.values()].map((c) => c.value)).toEqual(["Late Deduction Interest", "Y"]);
    expect([...settings.rows[3].cells.values()].map((c) => c.value)).toEqual(["TAN", null]);
  });

  it("gives Statements a fifth Return Accurate column with a Yes/No dropdown", () => {
    const statements = build().find((s) => s.name === "Statements")!;
    expect([...statements.rows[0].cells.entries()].sort(([a], [b]) => a - b).map(([, c]) => c.value)).toEqual([
      "Form", "Quarter", "Filed Date", "TDS Amount", "Return Accurate? (Yes/No)",
    ]);
    const xml = entry(bufCache, "xl/worksheets/sheet7.xml");
    expect(xml).toContain("<formula1>\"Yes,No\"</formula1>");
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
    expect(sheets).toHaveLength(10);
    expect(sheets.filter((s) => s.state !== "visible")).toEqual([
      expect.objectContaining({ name: "TCS Natures", state: "hidden" }),
    ]);
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
