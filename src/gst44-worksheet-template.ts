// src/gst44-worksheet-template.ts
import { buildWorkbook, type CellValue, type Sheet, type SheetFormula, type Column } from "./xlsx.js";
import { WS_TREATMENT_LABELS, type WsLedgerRow } from "./gst44-worksheet.js";
import type { TreatmentRule } from "./gst44-treatments.js";

/**
 * The generated GST nature-wise break-up WORKING SHEET, mirroring the FY 24-25
 * hand-prepared reference workbook (captain's addendum 2026-09-26): REVENUE
 * and CAPITAL sheets with the reference's column layout plus two working
 * columns (Seeded as / Seed reason), then Instructions and Vocabulary sheets.
 *
 * Written through the project's own writer directly — NOT the de-masking
 * writeWorkbook — because it carries real ledger names on the operator's disk
 * by design (the 26AS-template precedent). Nothing in it was ever masked.
 *
 * The operator fills D/E/H/J only; I = B, G = I - H - J, F = G - E - D derive
 * via formulas on seeded rows (Q-C). Unclassified rows carry no formulas, so
 * an unfilled amount can never silently land in the Others column.
 */

export const WS_REVENUE_SHEET = "REVENUE";
export const WS_CAPITAL_SHEET = "CAPITAL";

const MONEY: Pick<Column, "format" | "width"> = { format: "money", width: 15 };

function breakUpColumns(extraHeader: string): Column[] {
  return [
    { header: "Particulars", width: 38, format: "text" },
    { header: "Amount (Rs)", width: 15, ...MONEY },
    { header: "", width: 2, format: "text" },
    { header: "Supplies exempt from GST", ...MONEY },
    { header: "Entities under composite scheme", ...MONEY },
    { header: "Others", ...MONEY },
    { header: "Total", ...MONEY },
    { header: "Un-registered", ...MONEY },
    { header: "Total expenditure", ...MONEY },
    { header: extraHeader, ...MONEY },
    { header: "Seeded as", width: 20, format: "text" },
    { header: "Seed reason", width: 95, format: "text" },
  ];
}

interface BreakUpBuild {
  rows: CellValue[][];
  formulas: SheetFormula[];
  /** Sum of every row's column B literal — the books' total for the roots. */
  booksTotal: number;
}

function breakUpSheetRows(rowsIn: WsLedgerRow[], band: string): BreakUpBuild {
  const rows: CellValue[][] = [];
  const formulas: SheetFormula[] = [];
  const blank = (): CellValue[] => [null, null, null, null, null, null, null, null, null, null, null, null];
  rows.push([band, null, null, null, null, null, null, null, null, null, null, null]);
  const first = 5; // title=1, lead=2, header=3, band=4
  let r = first;
  for (const row of rowsIn) {
    const seeded = row.seed !== null;
    const cells = blank();
    cells[0] = row.ledger;
    cells[1] = row.amount;
    if (seeded) {
      cells[3] = row.seed!.d;
      cells[4] = row.seed!.e;
      cells[7] = row.seed!.h;
      cells[9] = row.seed!.j;
      cells[10] = WS_TREATMENT_LABELS[row.seed!.treatment];
      cells[11] = row.seed!.reason;
      formulas.push({ ref: `I${r}`, f: `B${r}` });
      formulas.push({ ref: `G${r}`, f: `I${r}-H${r}-J${r}` });
      formulas.push({ ref: `F${r}`, f: `G${r}-E${r}-D${r}` });
    } else {
      cells[10] = WS_TREATMENT_LABELS.unclassified;
      cells[11] = "no treatment rule matched — fill D/E/H/J, then copy the Total/Others/Total expenditure formulas down from any seeded row";
    }
    rows.push(cells);
    r += 1;
  }
  const last = r - 1;
  const sumCols = [1, 3, 4, 5, 6, 7, 8, 9];
  const totalRow = blank();
  totalRow[0] = "TOTAL";
  if (last >= first) {
    for (const c of sumCols) formulas.push({ ref: `${colLetter(c)}${r}`, f: `SUM(${colLetter(c)}${first}:${colLetter(c)}${last})` });
  } else {
    // Excel normalises a reversed range (SUM(B5:B4) -> B4:B5) into a circular
    // reference against this very row, so an empty sheet gets literal zeros.
    for (const c of sumCols) totalRow[c] = 0;
  }
  rows.push(totalRow);
  r += 1;
  const roundedRow = blank();
  roundedRow[0] = "ROUNDED (for Winman)";
  for (const c of sumCols) {
    if (last >= first) formulas.push({ ref: `${colLetter(c)}${r}`, f: `ROUND(${colLetter(c)}${r - 1},0)` });
    else roundedRow[c] = 0;
  }
  rows.push(roundedRow);
  r += 1;
  const booksRow = blank();
  booksRow[0] = "As per books (all ledgers under the clause 44 roots)";
  booksRow[1] = rowsIn.reduce((s, x) => s + x.amount, 0);
  rows.push(booksRow);
  r += 1;
  const diffRow = blank();
  diffRow[0] = "Difference (must stay zero)";
  formulas.push({ ref: `B${r}`, f: `B${r - 1}-B${r - 3}` });
  rows.push(diffRow);
  return { rows, formulas, booksTotal: booksRow[1] as number };
}

const LETTERS = "ABCDEFGHIJKL";
const colLetter = (zeroBased: number): string => LETTERS[zeroBased];

export function buildGstWorksheet(opts: {
  company?: string;
  period: string;
  revenueRows: WsLedgerRow[];
  capitalRows: WsLedgerRow[];
  rules: readonly TreatmentRule[];
  priorYearUsed: boolean;
}): Buffer {
  const companyLine = opts.company ? `${opts.company} — GST inward supply, nature-wise break-up — ${opts.period}` : `GST inward supply, nature-wise break-up — ${opts.period}`;
  const revenue = breakUpSheetRows(opts.revenueRows, `REVENUE EXPENDITURE - ${opts.period}`);
  const capital = breakUpSheetRows(opts.capitalRows, `CAPITAL EXPENDITURE - ${opts.period}`);

  const instructionRows: string[] = [
    companyLine,
    "This working sheet feeds the Winman clause 44 (Break-up of GST expenditure) sheet for the year.",
    "Column B is the ledger's signed net for the period straight from the books; never edit it.",
    "Fill ONLY columns D, E, H and J: D supplies exempt from GST, E composite suppliers, H unregistered, J not supply (REVENUE) or paid to govt (CAPITAL).",
    "F (Others), G (Total) and I (Total expenditure) are formulas: I = B, G = I - H - J, F = G - E - D. Seeded rows already carry them.",
    "Rows marked UNCLASSIFIED match no rule and are deliberately blank: fill D/E/H/J, then copy the three formulas down from any seeded row.",
    "Column K shows what the engine seeded the row as; column L shows why. Overrule a seed by editing D/E/H/J directly.",
    "The Difference row must stay zero; if it moves, a SUM range lost a row.",
    opts.priorYearUsed
      ? "Seeds were also matched against the prior-year working sheet you supplied; a row whose seed differs from last year carries a review note in the tool result."
      : "No prior-year sheet was supplied; seeds come from the rule vocabulary and the books' GSTIN evidence only.",
    "When the totals are agreed, tell the captain 'approved': only then is a NEW dated copy of the Winman clause 44 workbook written. The source workbook is never touched, and nothing is written before approval.",
    "Privacy: pass this file's PATH to tools; never paste its rows into chat.",
  ];

  const vocabulary: Sheet = {
    name: "Vocabulary",
    columns: [
      { header: "Rule id", width: 22, format: "text" },
      { header: "Kind", width: 10, format: "text" },
      { header: "Treatment", width: 22, format: "text" },
      { header: "Keywords", width: 40, format: "text" },
      { header: "Pattern", width: 40, format: "text" },
      { header: "Meaning", width: 70, format: "text" },
    ],
    rows: opts.rules.map((r) => [
      r.id,
      r.kind,
      WS_TREATMENT_LABELS[r.treatment],
      (r.keywords ?? []).join(" | "),
      r.pattern ?? "",
      r.note,
    ]),
  };

  const breakUp = (name: string, extra: string, build: BreakUpBuild): Sheet => ({
    name,
    title: [companyLine],
    leadRows: [[null, null, null, "Registered Dealers"]],
    columns: breakUpColumns(extra),
    rows: build.rows,
    formulas: build.formulas,
  });

  return buildWorkbook([
    breakUp(WS_REVENUE_SHEET, "not supply", revenue),
    breakUp(WS_CAPITAL_SHEET, "paid to govt", capital),
    {
      name: "Instructions",
      columns: [{ header: "How to use this working sheet", width: 110, format: "text" }],
      rows: instructionRows.map((line) => [line]),
    },
    vocabulary,
  ]);
}

export function gstWorksheetFileName(company: string | undefined, date: string): string {
  const name = (company ?? "gst").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `gst-nature-wise-break-up-${name}-${date}.xlsx`;
}

/** "FY 25-26" from a YYYYMMDD date inside it: the Indian fiscal year that
 * starts on 1 April (fromDate 20250401 -> FY 25-26). */
export function fyLabel(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const start = m >= 4 ? y : y - 1;
  return `FY ${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}
