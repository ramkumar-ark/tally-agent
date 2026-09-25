import { describe, expect, it } from "vitest";
import { buildGst44Template, gst44TemplateFileName } from "../src/gst44-template.js";
import { parseGst44Template } from "../src/gst44-file.js";
import { GST44_TEMPLATE_STATUSES } from "../src/gst44-law.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";
import { entry } from "./xlsx.test.js";

const LEDGERS = ["Nova Traders", "Orchid Suppliers", "Prime Haulage"];

/**
 * The template's GST Status sheet's own header (read back through the reader)
 * drives the rebuilt workbook, so a header rename in the builder cannot go
 * unseen by the tests — the pf-esi-file.test.ts technique: rows go in through
 * the same reader-grid shape the parser will find them in.
 */
const bufFromRows = (template: Buffer, rows: string[][]): Buffer => {
  const status = readWorkbook(template).find((s) => s.name === "GST Status")!;
  const headerRow = status.rows[0]!;
  const headers = [...headerRow.cells.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => String(c.value));
  expect(headers).toEqual(["Ledger", "GST Status"]);
  const sheet: Sheet = {
    name: "GST Status",
    columns: headers.map((h) => ({ header: h })),
    rows,
  };
  return buildWorkbook([
    { name: "Instructions", columns: [{ header: "How to fill this template" }], rows: [] },
    sheet,
  ]);
};

const filled = (rows: string[][]): Buffer =>
  bufFromRows(buildGst44Template({ ledgers: LEDGERS }), rows);

describe("gst44 template builder", () => {
  it("pins the dropdown vocabulary to the four buckets, in order", () => {
    expect(GST44_TEMPLATE_STATUSES.map((s) => s.cell)).toEqual([
      "Exempt supplies",
      "Composition supplier",
      "Registered - others",
      "Unregistered",
    ]);
  });

  it("writes the Ledgers backing sheet and a cross-sheet dropdown formula", () => {
    const buf = buildGst44Template({ ledgers: LEDGERS });
    expect(readWorkbook(buf).some((s) => s.name === "Ledgers")).toBe(true);
    expect(readWorkbook(buf).find((s) => s.name === "Ledgers")!.rows).toHaveLength(4);
    // The Ledgers sheet backs the Ledger-column dropdown (GST Status is sheet 2:
    // Instructions, GST Status, Ledgers), and the status column's inline list is
    // exactly the four vocabulary strings.
    const xml = entry(buf, "xl/worksheets/sheet2.xml");
    expect(xml).toContain("<formula1>Ledgers!$A$2:$A$4</formula1>");
    expect(xml).toContain('"Exempt supplies,Composition supplier,Registered - others,Unregistered"');
  });

  it("names the file after the company and date", () => {
    expect(gst44TemplateFileName("Test Co", "20260924")).toBe(
      "gst-44-operator-template-test-co-20260924.xlsx",
    );
    expect(gst44TemplateFileName(undefined, "20260924")).toBe(
      "gst-44-operator-template-all-20260924.xlsx",
    );
  });
});

describe("gst44 template parsing", () => {
  it("round-trips statuses, with an empty template parsing to nothing", () => {
    expect(parseGst44Template(buildGst44Template({ ledgers: LEDGERS })).statuses).toEqual([]);
    const parsed = parseGst44Template(
      bufFromRows(buildGst44Template({ ledgers: LEDGERS }), [
        ["Orchid Suppliers", "Composition supplier"],
        ["Prime Haulage", "Unregistered"],
      ]),
    );
    expect(parsed.statuses).toEqual([
      { ledger: "Orchid Suppliers", status: "composition" },
      { ledger: "Prime Haulage", status: "unregistered" },
    ]);
  });

  it("rejects a bad status citing the sheet, row and column — never the value", () => {
    expect(() => parseGst44Template(filled([["Nova Traders", "super-registered"]])))
      .toThrow(/template GST Status row 2, column B \(GST Status\)/);
    expect(() => parseGst44Template(filled([["Nova Traders", "super-registered"]])))
      .not.toThrow(/super-registered/);
  });

  it("rejects a duplicate ledger citing rows only", () => {
    expect(() => parseGst44Template(filled([
      ["Nova Traders", "Unregistered"],
      ["nova traders", "Exempt supplies"],
    ]))).toThrow(/row 3.*row 2/);
  });

  it("rejects a blank ledger cell", () => {
    expect(() => parseGst44Template(filled([["", "Exempt supplies"]])))
      .toThrow(/template GST Status row 2, column A \(Ledger\)/);
  });
});
