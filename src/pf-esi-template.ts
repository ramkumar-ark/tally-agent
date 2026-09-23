import { buildWorkbook, type Sheet } from "./xlsx.js";
import type { FundKey } from "./pf-esi-law.js";

/**
 * The generated, fillable PF/ESI clause-20(b) operator template (design of
 * record: docs/design/2026-09-23-winman-3cd-pf-esi-design.md). Same channel as
 * the TDS template (`src/tds-template.ts`): written through the project's own
 * workbook writer directly — NOT through the de-masking `writeWorkbook`, since
 * a blank template contains nothing that was ever masked. The data sheet
 * ships empty so the parser never has to skip demo rows; the worked example
 * lives on the Instructions sheet.
 */

/** The Funds list a Fund cell may hold; FundKey values after parse. */
export const PF_ESI_FUNDS: Array<{ cell: string; key: FundKey }> = [
  { cell: "P.F.", key: "PF" },
  { cell: "E.S.I.", key: "ESI" },
];

const instructions = (company?: string): Sheet => ({
  name: "Instructions",
  columns: [{ header: "How to fill this template", width: 110, format: "text" }],
  rows: [
    [company ? `PF/ESI operator template for ${company}.` : "PF/ESI operator template."],
    [
      "The Challans sheet is the only data this review takes from you: one row per challan or ECR payment, the amount PF/ESI that was actually deposited, per fund and wage month. Everything else in clause 20(b) comes from the Tally books. March's payment is normally due after 31-March, so a Paid On date in the NEXT financial year is accepted and expected.",
    ],
    ["Privacy: this file carries payment evidence only. Never paste its rows into chat — pass its path to the review; the file itself is read inside the gateway."],
    ["One row per challan per fund per wage month — two payments for the same fund and wage month cannot both be read."],
    ["Fund: pick P.F. or E.S.I. from the dropdown."],
    ["Wage Month: type it as 2025-04 (the month FOR which PF or ESI was deducted, not the month you paid it)."],
    ["Paid On: the challan/ECR deposit date. Type it as 2026-04-15, or pick from the calendar picker."],
    ["Amount Paid: the total deposited for that fund, digits only (Indian commas are fine)."],
    ["Worked example (invented figures only):"],
    ["Challans     | P.F. | 2025-04 | 2025-05-14 | 30575"],
    ["Challans     | E.S.I. | 2025-04 | 2025-05-18 | 8420"],
  ],
});

const challansSheet = (): Sheet => ({
  name: "Challans",
  columns: [
    { header: "Fund", width: 10, format: "text", validation: { list: PF_ESI_FUNDS.map((f) => f.cell) } },
    { header: "Wage Month", width: 12, format: "text" },
    { header: "Paid On", width: 16, format: "date" },
    { header: "Amount Paid", width: 14, format: "money" },
  ],
  rows: [],
});

/** The workbook: Instructions plus the Challans sheet, data rows empty. */
export function buildPfEsiTemplate(company?: string): Buffer {
  return buildWorkbook([instructions(company), challansSheet()]);
}

/** The file name the generator tool writes; blank company means "all". */
export function pfEsiTemplateFileName(company: string | undefined, date: string): string {
  const name = (company ?? "all").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `pf-esi-operator-template-${name}-${date}.xlsx`;
}
