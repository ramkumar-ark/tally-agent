import { buildWorkbook, type Sheet } from "./xlsx.js";

/**
 * The generated, fillable TDS operator template (design of record:
 * docs/design/2026-09-16-tds-spreadsheet-input-design.md §6). Emitted by the
 * project's own workbook writer directly — NOT through the de-masking writer
 * wrapper: a blank template contains nothing that was ever masked, and
 * routing it through the vault would be semantics theatre.
 *
 * The data sheets ship empty so the parser never has to skip demo rows; the
 * worked example below (invented names and figures only) lives on the
 * Instructions sheet.
 */

/** The eight law-table keys a Section cell may name. Bare `194-I` is not one: it never was well-defined once the split landed. */
export const SECTION_KEYS = ["194C", "194J", "194-I(a)", "194-I(b)", "194A", "194H", "194Q", "194T"] as const;

const KINDS = ["Expense", "TDS Duty"];
const YN = ["Y", "N"];
const FORMS = ["24Q", "26Q", "27Q"];
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const instructions = (company?: string): Sheet => ({
  name: "Instructions",
  columns: [{ header: "How to fill this template", width: 110, format: "text" }],
  rows: [
    [company ? `TDS operator template for ${company}.` : "TDS operator template."],
    [
      "The Sections sheet drives this whole check. A booking's TDS section is decided by the expense (or nature-of-payment) ledger it is booked to, and by nothing else. A party ledger says only WHETHER TDS applies to it — never which section, because one party can be liable under several. If an expense ledger is missing from the Sections sheet, its bookings are reported as \"section unknown\" and no tax, interest or penalty is computed for them. The gateway never guesses a section.",
    ],
    ["Privacy: this file carries tax identities. Never paste its rows into chat — pass its path to tb_tds_review; the file itself is read inside the gateway."],
    ["Leave a cell blank to mean \"not applicable\". Do not write N/A."],
    ["Keep the PAN column's text format (letters then digits, 10 after removing spaces). If Excel shows scientific notation, retype the cell as text."],
    ["Type dates as 2026-01-15, or pick from the calendar picker in the date columns."],
    ["Ledger Kind on the Sections sheet: leave blank for an expense/purchase ledger; use \"TDS Duty\" for the TDS duty ledger (its row then never counts as a booking)."],
    ["Parties sheet: one row per deductee party ledger. TDS Applicable is required — Y or N, exactly as the party is configured in Tally."],
    ["One expense ledger may be mapped to more than one section, but nothing is computed for it until the mapping is one-to-one. Fix: split the Tally ledger per section (Rent - Plant & Machinery / Rent - Building) — which is what filing under 194-I(a) vs 194-I(b) requires anyway."],
    ["Worked example (invented names and figures only):"],
    ["Sections     | Site Repairs Contract  | 194C     | Expense"],
    ["Sections     | Rent - Plant & Machy   | 194-I(a) | Expense"],
    ["Sections     | Rent - Office Building | 194-I(b) | Expense"],
    ["Sections     | TDS Contractors        | 194C     | TDS Duty"],
    ["Parties      | Sample Builders LLP    | Y | ABCC1234A |   |   | Sample Builders (Unit 2)"],
    ["Parties      | Sample Traders         | N |           |   |   |"],
    ["Certificates | Sample Developers      | 194-I(a) | 2 | 2025-04-01 | 2026-03-31 | 400000"],
    ["Challans     | 194C                   | 2025-05  | 2025-06-16"],
    ["Statements   | 26Q                    | Q1       | 2025-08-20 | 5000"],
  ],
});

const sectionsSheet = (): Sheet => ({
  name: "Sections",
  columns: [
    { header: "Tally Ledger Name", width: 34, format: "text" },
    { header: "Section", width: 12, format: "text", validation: { list: [...SECTION_KEYS] } },
    { header: "Ledger Kind", width: 14, format: "text", validation: { list: KINDS } },
  ],
  rows: [],
});

const partiesSheet = (): Sheet => ({
  name: "Parties",
  columns: [
    { header: "Tally Ledger Name", width: 34, format: "text" },
    { header: "TDS Applicable", width: 14, format: "text", validation: { list: YN } },
    { header: "PAN", width: 16, format: "text" },
    { header: "Transporter Declaration 194C(6)", width: 26, format: "text", validation: { list: YN } },
    { header: "Deductee Filed Return s.201(1)", width: 26, format: "text", validation: { list: YN } },
    { header: "Winman Deductee Name", width: 30, format: "text" },
  ],
  rows: [],
});

const certificatesSheet = (): Sheet => ({
  name: "Certificates",
  columns: [
    { header: "Tally Ledger Name", width: 34, format: "text" },
    { header: "Section", width: 12, format: "text", validation: { list: [...SECTION_KEYS] } },
    { header: "Rate %", width: 10, format: "text" },
    { header: "From Date", width: 14, format: "date" },
    { header: "To Date", width: 14, format: "date" },
    { header: "Limit", width: 14, format: "money" },
  ],
  rows: [],
});

const challansSheet = (): Sheet => ({
  name: "Challans",
  columns: [
    { header: "Section", width: 12, format: "text", validation: { list: [...SECTION_KEYS] } },
    { header: "For Month", width: 12, format: "text" },
    { header: "Deposit Date", width: 16, format: "date" },
  ],
  rows: [],
});

const statementsSheet = (): Sheet => ({
  name: "Statements",
  columns: [
    { header: "Form", width: 10, format: "text", validation: { list: FORMS } },
    { header: "Quarter", width: 10, format: "text", validation: { list: QUARTERS } },
    { header: "Filed Date", width: 14, format: "date" },
    { header: "TDS Amount", width: 14, format: "money" },
  ],
  rows: [],
});

/** The workbook: Instructions plus the five data sheets, data rows empty. */
export function buildTemplateWorkbook(company?: string): Buffer {
  return buildWorkbook([instructions(company), sectionsSheet(), partiesSheet(), certificatesSheet(), challansSheet(), statementsSheet()]);
}

/** The file name the generator tool writes; blank company means "all". */
export function templateFileName(company: string | undefined, date: string): string {
  const name = (company ?? "all").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `tds-operator-template-${name}-${date}.xlsx`;
}
