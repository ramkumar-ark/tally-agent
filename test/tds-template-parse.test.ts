import { describe, expect, it } from "vitest";
import { parseOperatorTemplate } from "../src/tds-file.js";
import { buildTemplateWorkbook } from "../src/tds-template.js";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";
import { readWorkbook } from "../src/xlsx-read.js";

/**
 * Template-parse tests over workbooks built with the §6 headers through the
 * project's own writer, so the parse path exercises exactly what the
 * generator emits. Planted TAN/PAN-shaped strings ride the offending cells of
 * the fault cases and every assertion checks the message never echoes the
 * value — those strings are invented fixtures, never a real identifier.
 */
const TAN = "MUMA04826B";
const PAN = "ABCCS1234A";

function message(fn: () => unknown): string {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type CellRow = Array<string | number | null>;

const baseSheets: Record<string, Sheet> = {
  Sections: {
    name: "Sections",
    columns: [
      { header: "Tally Ledger Name", format: "text" },
      { header: "Section", format: "text" },
      { header: "Ledger Kind", format: "text" },
    ],
    rows: [],
  },
  Parties: {
    name: "Parties",
    columns: [
      { header: "Tally Ledger Name", format: "text" },
      { header: "TDS Applicable", format: "text" },
      { header: "PAN", format: "text" },
      { header: "Transporter Declaration 194C(6)", format: "text" },
      { header: "Deductee Filed Return s.201(1)", format: "text" },
      { header: "Winman Deductee Name", format: "text" },
    ],
    rows: [],
  },
  Certificates: {
    name: "Certificates",
    columns: [
      { header: "Tally Ledger Name", format: "text" },
      { header: "Section", format: "text" },
      { header: "Rate %", format: "text" },
      { header: "From Date", format: "date" },
      { header: "To Date", format: "date" },
      { header: "Limit", format: "money" },
    ],
    rows: [],
  },
  Challans: {
    name: "Challans",
    columns: [
      { header: "Section", format: "text" },
      { header: "For Month", format: "text" },
      { header: "Deposit Date", format: "date" },
    ],
    rows: [],
  },
  Statements: {
    name: "Statements",
    columns: [
      { header: "Form", format: "text" },
      { header: "Quarter", format: "text" },
      { header: "Filed Date", format: "date" },
      { header: "TDS Amount", format: "money" },
    ],
    rows: [],
  },
};

function fullWorkbook(
  fills: Array<[string, CellRow[]]>,
): Buffer {
  const sheets: Sheet[] = [
    { name: "Instructions", columns: [{ header: "How to fill this template" }], rows: [["fill me"]] },
    ...Object.entries(baseSheets).map(([name, sheet]) => ({
      ...sheet,
      rows: fills.find(([n]) => n === name)?.[1] ?? [],
    })),
  ];
  return buildWorkbook(sheets);
}

describe("parseOperatorTemplate — happy path", () => {
  it("parses the blank generated template to EMPTY_TDS_OPERATOR", () => {
    expect(parseOperatorTemplate(buildTemplateWorkbook())).toEqual({
      sections: [], parties: [], certificates: [], challans: [], statements: [],
    });
  });

  it("parses filled sections, parties, certificates, challans and statements", () => {
    const op = parseOperatorTemplate(
      fullWorkbook([
        ["Sections", [
          ["Site Repairs Contract", "194C", "Expense"],
          ["Rent - Plant & Machinery", "194-I(a)", "Expense"],
          ["Rent - Office Building", "194-I(b)", "Expense"],
          ["TDS Contractors", "194C", "TDS Duty"],
        ]],
        ["Parties", [
          ["Sample Builders LLP", "Y", PAN, "N", "yes", "Sample Builders (Unit 2)"],
          ["Sample Traders", "N", null, null, null, null],
        ]],
        ["Certificates", [["Sample Developers", "194-I(a)", 2, "2025-04-01", "2026-03-31", 400000]]],
        ["Challans", [["194C", "2025-05", "2025-06-16"]]],
        ["Statements", [["26Q", "Q1", "2025-08-20", 5000]]],
      ]),
    );
    expect(op.sections).toEqual([
      { ledger: "Site Repairs Contract", section: "194C" },
      { ledger: "Rent - Plant & Machinery", section: "194-I(a)" },
      { ledger: "Rent - Office Building", section: "194-I(b)" },
      { ledger: "TDS Contractors", section: "194C", kind: "duty" },
    ]);
    expect(op.parties).toEqual([
      {
        ledger: "Sample Builders LLP",
        tdsApplicable: true,
        transporterDeclaration: false,
        deducteeFiledReturn: true,
        winmanName: "Sample Builders (Unit 2)",
      },
      { ledger: "Sample Traders", tdsApplicable: false, transporterDeclaration: false, deducteeFiledReturn: false },
    ]);
    expect(op.certificates).toEqual([
      { ledger: "Sample Developers", section: "194-I(a)", rate: 2, from: "20250401", to: "20260331", limit: 400000 },
    ]);
    expect(op.challans).toEqual([{ section: "194C", forMonth: "2025-05", depositDate: "20250616" }]);
    expect(op.statements).toEqual([{ form: "26Q", quarter: "Q1", filedDate: "20250820", tdsAmount: 5000 }]);
  });
});

describe("parseOperatorTemplate — flags, dates, amounts", () => {
  const party = (flags: string[]) =>
    fullWorkbook([["Parties", flags.map((f, i) => [`Ledger ${i + 1}`, f])]]);

  it("accepts the Y/N/yes/on/1/0 flag spellings, upper or lower case", () => {
    expect(
      parseOperatorTemplate(party(["Y", "N", "1"])).parties.map((p) => p.tdsApplicable),
    ).toEqual([true, false, true]);
    expect(
      parseOperatorTemplate(party(["no", "NO", "false"])).parties.map((p) => p.tdsApplicable),
    ).toEqual([false, false, false]);
  });

  it("errors on an unrecognised TDS Applicable value and echoes nothing, even a planted TAN", () => {
    const wb = fullWorkbook([["Parties", [["Sample Builders", "Y"], ["Other Party", TAN]]]]);
    const msg = message(() => parseOperatorTemplate(wb));
    expect(msg).toMatch(/template Parties row 3, column B \(TDS Applicable\)/);
    expect(msg).not.toContain(TAN);
  });

  it("rejects a PAN cell Excel already turned numeric, and never echoes the mangled digits", () => {
    const wb = fullWorkbook([["Parties", [["Sample Builders", "Y", 1234567890]]]]);
    const msg = message(() => parseOperatorTemplate(wb));
    expect(msg).toMatch(/column C \(PAN\): cell is numeric/);
    expect(msg).not.toContain("1234567890");
  });

  it("compacts inner spaces in PANs, and rejects a shape that is not a PAN after compaction", () => {
    const ok = parseOperatorTemplate(fullWorkbook([["Parties", [["Ledger 1", "Y", "ABCCS 1234 A"]]]]));
    expect(ok.parties[0].tdsApplicable).toBe(true);
    const bad = message(() =>
      parseOperatorTemplate(fullWorkbook([["Parties", [["Ledger 1", "Y", `${PAN}!`]]]])),
    );
    expect(bad).toMatch(/column C \(PAN\)/);
    expect(bad).not.toContain(PAN);
  });

  it("accepts date cells (Excel serials from YYYYMMDD), YYYY-MM-DD text and YYYYMMDD text", () => {
    const op = parseOperatorTemplate(
      fullWorkbook([
        ["Certificates", [["L1", "194-I(a)", 2, "20250401", "2026-03-31", 400000]]],
        ["Challans", [["194C", "2025-05", "20250616"]]],
      ]),
    );
    expect(op.certificates[0].from).toBe("20250401");
    expect(op.certificates[0].to).toBe("20260331");
    expect(op.challans[0].depositDate).toBe("20250616");
  });

  it("rejects an ambiguous text date citing the cell position and the correction", () => {
    const wb = fullWorkbook([["Statements", [["26Q", "Q1", "05/06/2025", 1]]]]);
    const msg = message(() => parseOperatorTemplate(wb));
    expect(msg).toMatch(/Filed Date\): date is ambiguous/);
    expect(msg).not.toContain("05/06/2025");
  });

  it("rejects a currency symbol in an amount", () => {
    const wb = fullWorkbook([["Statements", [["26Q", "Q1", "2025-08-20", "₹5000"]]]]);
    expect(message(() => parseOperatorTemplate(wb))).toMatch(/remove the currency symbol/);
  });

  it("accepts amounts as numbers and as Indian-grouped text", () => {
    const op = parseOperatorTemplate(
      fullWorkbook([
        ["Statements", [["26Q", "Q1", "2025-08-20", 100000]]],
        ["Certificates", [["L1", "194-I(a)", 2, "20250401", "20260331", "1,00,000"]]],
      ]),
    );
    expect(op.statements[0].tdsAmount).toBe(100000);
    expect(op.certificates[0].limit).toBe(100000);
  });
});

describe("parseOperatorTemplate — structure and duplicates", () => {
  it("errors naming sheet, row, column letter and header for a blank required cell", () => {
    const wb = fullWorkbook([["Sections", [["", "194C"]]]]);
    expect(message(() => parseOperatorTemplate(wb))).toMatch(
      /template Sections row 2, column A \(Tally Ledger Name\): required cell is blank/,
    );
  });

  it("rejects a duplicate party ledger citing both rows", () => {
    const wb = fullWorkbook([["Parties", [["Ledger A", "Y"], ["Ledger A", "Y"]]]]);
    const msg = message(() => parseOperatorTemplate(wb));
    expect(msg).toMatch(/this ledger already appears in row \d+ — one row per party/);
  });

  it("rejects a duplicate (ledger, section) pair in Sections", () => {
    const wb = fullWorkbook([["Sections", [["L1", "194C"], ["L1", "194C"]]]]);
    expect(message(() => parseOperatorTemplate(wb))).toMatch(/this ledger-and-section pair already appears in row/);
  });

  it("accepts one ledger mapped to two sections (the review reports it, the parser never guesses)", () => {
    const wb = fullWorkbook([["Sections", [["Rent - Mixed", "194-I(a)"], ["Rent - Mixed", "194-I(b)"]]]]);
    const op = parseOperatorTemplate(wb);
    expect(op.sections.filter((s) => s.ledger === "Rent - Mixed")).toHaveLength(2);
  });

  it("rejects a bad section and never echoes the cell (a stray TAN is not a section)", () => {
    const wb = fullWorkbook([["Sections", [["Ledger 1", TAN]]]]);
    const msg = message(() => parseOperatorTemplate(wb));
    expect(msg).toMatch(/column B \(Section\): not a TDS section — use the dropdown/);
    expect(msg).not.toContain(TAN);
  });

  it("rejects wholesale: one bad cell fails the whole file, no partial rows", () => {
    const wb = fullWorkbook([
      ["Sections", [["L1", "194C"]]],
      ["Parties", [["Ledger 1", "Y"], ["Ledger 2", TAN]]],
    ]);
    expect(message(() => parseOperatorTemplate(wb))).toMatch(/TDS Applicable/);
  });

  it("tolerates a trailing blank row silently", () => {
    const op = parseOperatorTemplate(
      fullWorkbook([["Sections", [["L1", "194C"], ["", ""]]]]),
    );
    expect(op.sections).toEqual([{ ledger: "L1", section: "194C" }]);
  });

  it("rejects a rename of a required header with the expected headers listed", () => {
    const sheets: Sheet[] = [
      { name: "Instructions", columns: [{ header: "x" }], rows: [] },
      { ...baseSheets.Sections, rows: [] },
      {
        ...baseSheets.Parties,
        columns: baseSheets.Parties.columns.map((c, i) =>
          i === 1 ? { ...c, header: "Applicable?" } : c,
        ),
      },
      { ...baseSheets.Certificates, rows: [] },
      { ...baseSheets.Challans, rows: [] },
      { ...baseSheets.Statements, rows: [] },
    ];
    const msg = message(() => parseOperatorTemplate(buildWorkbook(sheets)));
    expect(msg).toMatch(/template Parties: column B \(TDS Applicable\) is missing — expected headers: /);
  });

  it("errors on a missing required sheet, naming the sheets it found (a Winman file does not parse as a template)", () => {
    const msg = message(() =>
      parseOperatorTemplate(buildWorkbook([{ name: "Instructions", columns: [{ header: "x" }], rows: [] }])),
    );
    expect(msg).toMatch(/template sheet missing/i);
    expect(msg).toContain("Instructions");
  });

  it("treats a Ledger Kind outside the dropdown as an error", () => {
    const wb = fullWorkbook([["Sections", [["L1", "194C", "Party"]]]]);
    expect(message(() => parseOperatorTemplate(wb))).toMatch(/column C \(Ledger Kind\): not Expense or TDS Duty/);
  });

  it("rejects a Quarter outside Q1..Q4 and a Form outside 24Q/26Q/27Q", () => {
    expect(message(() => parseOperatorTemplate(
      fullWorkbook([["Statements", [["26Q", "Q5", "2025-08-20", 1]]]]),
    ))).toMatch(/column B \(Quarter\)/);
    expect(message(() => parseOperatorTemplate(
      fullWorkbook([["Statements", [["2BQ", "Q1", "2025-08-20", 1]]]]),
    ))).toMatch(/column A \(Form\)/);
  });

  it("rejects a For Month that is not YYYY-MM", () => {
    expect(message(() => parseOperatorTemplate(
      fullWorkbook([["Challans", [["194C", "May 2026", "2025-06-16"]]]]),
    ))).toMatch(/column B \(For Month\)/);
  });
});
