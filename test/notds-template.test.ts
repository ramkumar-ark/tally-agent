import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/xlsx-read.js";
import type { NoTdsCandidateRow } from "../src/notds.js";
import { buildNotdsTemplate, notdsTemplateFileName } from "../src/notds-template.js";
import { entry } from "./xlsx.test.js";

const candidate = (over: Partial<NoTdsCandidateRow> = {}): NoTdsCandidateRow => ({
  key: "samplebasicsllp|20260115|2|194-I(a)",
  party: "Sample Basics LLP",
  date: "20260115",
  voucherNumber: "2",
  gross: 100000,
  tdsDone: 0,
  tdsDeposited: 0,
  depositDate: null,
  section: "194-I(a)",
  liability: 20000,
  pan: null,
  panFromGstin: false,
  ...over,
});

const build = (candidates: NoTdsCandidateRow[] = []) =>
  readWorkbook(buildNotdsTemplate({ company: "Sample Company", candidates, generatedOn: "20260925" }));

const buf = (candidates: NoTdsCandidateRow[] = []) =>
  buildNotdsTemplate({ company: "Sample Company", candidates, generatedOn: "20260925" });

const headerCells = (sheet: { rows: { cells: Map<number, { value: string | number | null }> }[] }): string[] => {
  const row = sheet.rows[0];
  return [...row.cells.entries()].sort(([a], [b]) => a - b).map(([, c]) => String(c.value));
};

const dataRowValues = (sheet: ReturnType<typeof build>[number]): Array<unknown[]> =>
  sheet.rows.slice(1).map((r) =>
    Array.from({ length: sheet.rows[0].cells.size }, (_, i) => r.cells.get(i)?.value ?? null),
  );

const listCol = (sheet: ReturnType<typeof build>[number], n: number): string[] =>
  sheet.rows
    .map((r) => r.cells.get(n)?.value)
    .filter((v): v is string => typeof v === "string" && v !== "")
    .map((v) => String(v));

describe("the generated No-TDS operator template", () => {
  it("carries exactly four sheets by name, Lists hidden last", () => {
    const sheets = build();
    expect(sheets.map((s) => s.name)).toEqual(["Instructions", "Candidates", "Manual Rows", "Lists"]);
    expect(sheets[3].state).toBe("hidden");
    expect(sheets.slice(0, 3).every((s) => s.state === "visible")).toBe(true);
  });

  it("pins the Candidates column layout exactly", () => {
    const candidates = build().find((s) => s.name === "Candidates")!;
    expect(headerCells(candidates)).toEqual([
      "Key", "Party", "Date", "Voucher", "Section",
      "Gross", "TDS Done", "TDS Deposited", "Deposit Date", "Liability", "PAN",
      "Include", "Cure Reason", "Residency", "NR Section",
      "Nature of Payment", "Address", "City", "State", "PIN", "Country",
      "Amount Override", "Notes",
    ]);
  });

  it("pins the Manual Rows column layout exactly", () => {
    const manual = build().find((s) => s.name === "Manual Rows")!;
    expect(headerCells(manual)).toEqual([
      "Sheet", "Party", "Date", "Amount", "Tax/Levy Deducted", "Tax/Levy Deposited",
      "Section", "Nature of Payment", "PAN/Aadhaar", "Address", "City", "State",
      "PIN", "Country", "Notes",
    ]);
  });

  it("prefills the books columns from the candidates, Section in Winman spelling with the real PAN and money/date styling", () => {
    const rows = build([
      candidate({
        pan: "ABCSA1234A",
        depositDate: "20260615",
        tdsDone: 0,
        tdsDeposited: 20000,
      }),
    ]);
    const candidates = rows.find((s) => s.name === "Candidates")!;
    expect(dataRowValues(candidates)).toEqual([
      [
        "samplebasicsllp|20260115|2|194-I(a)",
        "Sample Basics LLP",
        expect.any(Number),
        "2",
        "194I (a)",
        100000,
        0,
        20000,
        expect.any(Number),
        20000,
        "ABCSA1234A",
        // The operator columns ship blank.
        null, null, null, null, null, null, null, null, null, null, null, null,
      ],
    ]);
    const dateCell = candidates.rows[1].cells.get(2)!;
    expect(dateCell.isDate).toBe(true);
    expect(dateCell.value).toBeTypeOf("number");
    const depositCell = candidates.rows[1].cells.get(8)!;
    expect(depositCell.isDate).toBe(true);
    const xml = entry(buf([candidate({ pan: "ABCSA1234A", tdsDeposited: 20000, depositDate: "20260615" })]), "xl/worksheets/sheet2.xml");
    expect(xml).toContain('<c r="F2" s="2"><v>100000</v></c>');
    expect(xml).toContain('<c r="C2" s="3">');
  });

  it("round-trips the candidate keys through the project's own reader", () => {
    const rows = build([
      candidate(),
      candidate({
        key: "samplecomponents|20260211|7|194C",
        party: "Sample Components Ltd",
        date: "20260211",
        voucherNumber: "7",
        section: "194C",
        gross: 45000,
        liability: 9000,
      }),
    ]);
    const candidates = rows.find((s) => s.name === "Candidates")!;
    const keys = candidates.rows.slice(1).map((r) => String(r.cells.get(0)?.value));
    expect(keys).toEqual(["samplebasicsllp|20260115|2|194-I(a)", "samplecomponents|20260211|7|194C"]);
  });

  it("ships the Candidates sheet empty but headed when no candidates exist", () => {
    const sheets = build([]);
    const candidates = sheets.find((s) => s.name === "Candidates")!;
    expect(candidates.rows).toHaveLength(1);
    expect(headerCells(candidates)).toContain("Key");
    expect(readWorkbook(buildNotdsTemplate({ company: "x", candidates: [], generatedOn: "20260925" }))).toHaveLength(4);
  });

  it("backs every dropdown with a hidden Lists-sheet range formula, never an inline list", () => {
    const candidatesXml = entry(buf(), "xl/worksheets/sheet2.xml");
    expect(candidatesXml).toContain("<dataValidations count=\"4\">");
    expect(candidatesXml).toContain("<formula1>Lists!$A$2:$A$3</formula1>"); // Include Y/N
    expect(candidatesXml).toContain("<formula1>Lists!$B$2:$B$6</formula1>"); // Cure Reason tokens
    expect(candidatesXml).toContain("<formula1>Lists!$C$2:$C$3</formula1>"); // Residency R/NR
    expect(candidatesXml).toContain("<formula1>Lists!$E$2:$E$39</formula1>"); // State, 38 values
    const manualXml = entry(buf(), "xl/worksheets/sheet3.xml");
    expect(manualXml).toContain("<dataValidations count=\"2\">");
    expect(manualXml).toContain("<formula1>Lists!$D$2:$D$5</formula1>"); // the four sheet keys
    expect(manualXml).toContain("<formula1>Lists!$E$2:$E$39</formula1>"); // State rides the same list
  });

  it("carries on the Lists sheet the Y/N, cure, residency, sheet-key and state lists", () => {
    const lists = build().find((s) => s.name === "Lists")!;
    const col = (n: number): string[] => listCol(lists, n);
    expect(col(0)).toEqual(["Include", "Y", "N"]);
    expect(col(1)).toEqual([
      "Cure Reason",
      "threshold",
      "transporter-declaration",
      "payee-filed-return",
      "deposited-by-return-date",
      "other",
    ]);
    expect(col(2)).toEqual(["Residency", "R", "NR"]);
    expect(col(3)).toEqual([
      "Sheet",
      "40(a)(ia) to resident",
      "40(a)(i) to non-resident",
      "40(a)(ib) - Equalisation Levy",
      "40(a)(iii)",
    ]);
    const states = col(4);
    expect(states).toHaveLength(39); // header + the 38-value state/UT list
    expect(states[0]).toBe("State");
    expect(states).toContain("State outside India");
    expect(states).toContain("Karnataka");
  });

  it("names the file notds-operator-template-<slug>-<date>.xlsx", () => {
    expect(notdsTemplateFileName("Acme & Associates", "20260925")).toBe(
      "notds-operator-template-acme-associates-20260925.xlsx",
    );
  });

  it("explains the workflow, the cure reasons with their CONFIRM-marked law rows, the residency default and the privacy line", () => {
    const instructions = build().find((s) => s.name === "Instructions")!;
    const text = [...instructions.rows.flatMap((r) => [...r.cells.values()].map((c) => c.value))].join("\n");
    expect(text).toContain("paste its rows into chat");
    expect(text).toContain("resident unless marked NR");
    expect(text).toContain("Include");
    expect(text).toContain("counts as Include");
    // The four provision rows, verbatim law content with C10/C11/C12 confirm markers kept.
    expect(text).toContain("40(a)(i)");
    expect(text).toContain("40(a)(ia)");
    expect(text).toContain("40(a)(ib)");
    expect(text).toContain("40(a)(iii)");
    expect(text).toContain("C10");
    expect(text).toContain("C11");
    expect(text).toContain("C12");
    expect(text).toContain("C13");
    expect(text).toContain("Amount Override");
    // Invented-figure worked example.
    expect(text).toContain("Sample Basics LLP");
  });
});
