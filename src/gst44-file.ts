// src/gst44-file.ts
import {
  accessors,
  bindColumns,
  colLetter,
  dataRows,
  enumCell,
  locatedSheet,
  textCell,
  type CellRef,
} from "./tds-file.js";
import { readWorkbook } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import { GST44_STATUS_SHEET } from "./gst44-template.js";
import { GST44_TEMPLATE_STATUSES } from "./gst44-law.js";
import { EMPTY_GST44, type OperatorGst44, type Gst44StatusRow } from "./gst44.js";

/**
 * Parse the fillable clause-44 operator template back into the status facts
 * the review takes from the operator — the M2 path-only channel: the file
 * itself never transits the model, only its path does. Error contract
 * verbatim from src/tds-file.ts: every fault names sheet, Excel row and
 * column letter + header, never a cell value (a stray cell may still be a
 * supplier name or tax id).
 */
export function parseGst44Template(buf: Buffer): OperatorGst44 {
  const sheets = readWorkbook(buf);
  const sheet = locatedSheet(sheets, GST44_STATUS_SHEET);
  const cols = accessors(
    bindColumns(sheet, [{ header: "Ledger" }, { header: "GST Status" }]),
  );
  const ledgerCol = cols.get("Ledger")!;
  const statusCol = cols.get("GST Status")!;
  const cellTexts = GST44_TEMPLATE_STATUSES.map((s) => s.cell);
  const seen = new Map<string, number>();
  const statuses: Gst44StatusRow[] = [];
  const at = (r: CellRef["row"], col: number, header: string): CellRef => ({ sheet, row: r, col, header });
  for (const r of dataRows(sheet)) {
    const ledger = textCell(at(r, ledgerCol, "Ledger"), r.cells.get(ledgerCol));
    if (ledger === undefined) {
      throw new Error(`template ${sheet.name} row ${r.row}, column ${colLetter(ledgerCol)} (Ledger): required cell is blank — name the ledger exactly as it appears in Tally`);
    }
    const key = canonicalKey(ledger);
    if (seen.has(key)) {
      throw new Error(`template ${sheet.name} row ${r.row}, column ${colLetter(ledgerCol)} (Ledger): this ledger already has a status in row ${seen.get(key)} — one row per ledger`);
    }
    seen.set(key, r.row);
    const status = enumCell(
      at(r, statusCol, "GST Status"),
      r.cells.get(statusCol),
      cellTexts,
      "not a GST status — use the dropdown (Exempt supplies, Composition supplier, Registered - others, Unregistered)",
    );
    statuses.push({
      ledger,
      status: GST44_TEMPLATE_STATUSES.find((s) => s.cell === status)!.key,
    });
  }
  return { statuses };
}

export { EMPTY_GST44 };
