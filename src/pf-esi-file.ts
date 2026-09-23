import type { FundKey } from "./pf-esi-law.js";
import {
  accessors,
  amountCell,
  bindColumns,
  colLetter,
  dataRows,
  dateCell,
  enumCell,
  locatedSheet,
  type CellRef,
} from "./tds-file.js";
import { readWorkbook } from "./xlsx-read.js";
import { PF_ESI_FUNDS } from "./pf-esi-template.js";

/**
 * Parse the fillable PF/ESI clause-20(b) operator template
 * (`buildPfEsiTemplate`) back into the challan facts the review takes from
 * the operator — the M2 returnsPath channel: contents never transit the
 * model, only the file path does. Reuses `src/tds-file.ts`'s template error
 * contract verbatim: every fault names sheet, Excel row and column letter +
 * header and never interpolates a cell value, which may still be a tax id.
 */
export interface OperatorChallan {
  fund: FundKey;
  /** "2025-04" */
  wageMonth: string;
  /** YYYYMMDD */
  paidOn: string;
  amountPaid: number;
  sheet: string;
  row: number;
}

export interface OperatorPfEsi {
  challans: OperatorChallan[];
}

export const EMPTY_PF_ESI: OperatorPfEsi = { challans: [] };

/**
 * Parse the PF/ESI template. Malformed input is rejected wholesale — a half
 * read can never produce a confident-looking 20(b) computation. A Paid On
 * date outside the audited FY is valid data (Review Focus #5: March's
 * liability lands in the next FY) and is never checked against the year.
 */
export function parsePfEsiTemplate(buf: Buffer): OperatorPfEsi {
  const sheets = readWorkbook(buf);
  const sheet = locatedSheet(sheets, "Challans");
  const cols = accessors(
    bindColumns(sheet, [
      { header: "Fund" },
      { header: "Wage Month" },
      { header: "Paid On" },
      { header: "Amount Paid" },
    ]),
  );

  const seen = new Map<string, number>();
  const challans: OperatorChallan[] = dataRows(sheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({ sheet, row: r, col, header });
    const fundCell = enumCell(
      at(cols.get("Fund")!, "Fund"),
      r.cells.get(cols.get("Fund")!),
      PF_ESI_FUNDS.map((f) => f.cell),
      "not a fund — use the dropdown (P.F. or E.S.I.)",
    );
    const fund = PF_ESI_FUNDS.find((f) => f.cell === fundCell)!.key;
    const wageMonthRef = at(cols.get("Wage Month")!, "Wage Month");
    const wageMonth = String(r.cells.get(cols.get("Wage Month")!)?.value ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(wageMonth)) {
      throw new Error(`template ${wageMonthRef.sheet.name} row ${r.row}, column ${colLetter(cols.get("Wage Month")!)} (Wage Month): not a wage month — enter it as 2025-04`);
    }
    const key = `${fund}|${wageMonth}`;
    if (seen.has(key)) {
      throw new Error(`template ${sheet.name} row ${r.row}, column ${colLetter(cols.get("Wage Month")!)} (Wage Month): already has a challan for this fund and wage month in row ${seen.get(key)}`);
    }
    seen.set(key, r.row);
    return {
      fund,
      wageMonth,
      paidOn: dateCell(at(cols.get("Paid On")!, "Paid On"), r.cells.get(cols.get("Paid On")!)),
      amountPaid: amountCell(at(cols.get("Amount Paid")!, "Amount Paid"), r.cells.get(cols.get("Amount Paid")!)),
      sheet: sheet.name,
      row: r.row,
    };
  });

  return { challans };
}
