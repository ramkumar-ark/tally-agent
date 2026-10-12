// src/gst44-worksheet-read.ts
import { readWorkbook, type GridRow, type GridSheet } from "./xlsx-read.js";
import { CLAUSE_44_ROWS, type Gst44RowKey } from "./gst44-law.js";
import type { Gst44Row } from "./gst44.js";
import { WS_CAPITAL_SHEET, WS_REVENUE_SHEET } from "./gst44-worksheet-template.js";

/**
 * Read the operator's APPROVED GST nature-wise break-up WORKING SHEET and turn
 * it into the clause-44 rows the Winman writer consumes (captain's addendum
 * 2026-09-27, Q-F approval flow).
 *
 * The engine derives every figure from the sheet's LITERAL cells only — the
 * amount column B and the operator-filled D/E/H/J columns — and recomputes the
 * three formula columns with the sheet's own identities:
 *
 *   I (total expenditure) = B
 *   G (registered total)  = I - H - J
 *   F (others)            = G - E - D
 *
 * It deliberately does NOT read the sheet's G/F/I cells: our writer emits those
 * as formulas with no cached value, so a freshly generated sheet reads them as
 * blank until Excel recalculates. Recomputing from the literals is both robust
 * and exactly what the sheet displays, and it means the Winman totals tie to
 * the sheet's TOTAL row to the paisa.
 *
 * Winman column mapping (design of record §5, captain's v1 brief, 2026-09-27):
 *   TOTALEXPENDITURE      = B (= I, the books total)
 *   TOWARDSSUPPLIES       = D       (supplies exempt from GST)
 *   COMPOSITIONSUPPLIER   = E       (entities under composite scheme)
 *   OTHERS                = F       (registered, GST charged)
 *   REGISTEREDUNDERGST    = H       (TRAP: this Winman key names the *unregistered* column)
 * TOTALEXPENDITURE is the BOOKS total (column I = B), so the row no longer
 * adds across: C+D+E+F = G+H falls short of the total by exactly column J
 * (not supply on REVENUE, paid to govt on CAPITAL). The four split columns
 * are unchanged (C5); the gap is column J, which has no clause-44 column and
 * stays an informational finding rather than anything that fails the fill.
 */

/** 0-based column indexes on both REVENUE and CAPITAL (see gst44-worksheet-template.ts). */
const COL_AMOUNT = 1; // B
const COL_EXEMPT = 3; // D
const COL_COMPOSITION = 4; // E
const COL_UNREGISTERED = 7; // H
const COL_NOT_SUPPLY = 9; // J (not supply on REVENUE, paid to govt on CAPITAL)
const FIRST_DATA_ROW = 5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function num(row: GridRow, col: number): number {
  const v = row.cells.get(col)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function sheetRows(sheets: GridSheet[], name: string): GridRow[] {
  const sheet = sheets.find((s) => s.name === name);
  if (!sheet) {
    throw new Error(
      `the working sheet has no "${name}" sheet: pass the operator's GST nature-wise break-up workbook (built by tb_write_gst_working_sheet)`,
    );
  }
  return sheet.rows;
}

function sumSheet(rows: GridRow[], key: Gst44RowKey): Gst44Row {
  const totalRow = rows.find((r) => r.cells.get(0)?.value === "TOTAL")?.row;
  const data = rows.filter((r) => r.row >= FIRST_DATA_ROW && (totalRow === undefined || r.row < totalRow));
  const amount = data.reduce((s, r) => s + num(r, COL_AMOUNT), 0);
  const exempt = data.reduce((s, r) => s + num(r, COL_EXEMPT), 0);
  const composition = data.reduce((s, r) => s + num(r, COL_COMPOSITION), 0);
  const unregistered = data.reduce((s, r) => s + num(r, COL_UNREGISTERED), 0);
  const notSupply = data.reduce((s, r) => s + num(r, COL_NOT_SUPPLY), 0);
  const label = CLAUSE_44_ROWS.find((r) => r.key === key)?.label ?? key;
  return {
    key,
    label,
    // Winman's "Total expenditure" is the BOOKS total (column I = B), the
    // row's whole amount — not the attributed sum. The four split columns
    // (C+D+E+F = G+H) therefore fall short of it by column J (C5).
    total: round2(amount),
    exempt: round2(exempt),
    composition: round2(composition),
    others: round2(amount - unregistered - notSupply - composition - exempt),
    unregistered: round2(unregistered),
  };
}

/**
 * The two clause-44 rows (capital first, then revenue — the order Winman's
 * sheet carries them in) read from an approved working-sheet buffer.
 */
export function readWorksheetTotals(buf: Buffer): Gst44Row[] {
  const sheets = readWorkbook(buf);
  return [
    sumSheet(sheetRows(sheets, WS_CAPITAL_SHEET), "capital"),
    sumSheet(sheetRows(sheets, WS_REVENUE_SHEET), "revenue"),
  ];
}

/** A working-sheet ledger row whose break-up is still blank. */
export interface UnclassifiedWorksheetRow {
  sheet: "capital" | "revenue";
  /** The ledger name as the sheet shows it (real, operator-side). */
  ledger: string;
  /** Column B, the ledger's signed net for the period. */
  amount: number;
}

/** Break-up columns D..J (0-based 3..9): the operator's fills and the formulas. */
const FIRST_BREAKUP_COL = 3;
const LAST_BREAKUP_COL = 9;

/**
 * The rows of an approved working-sheet buffer that still carry no break-up:
 * no value in any of D..J. A seeded row always has literal D/E/H/J and cached
 * formulas in F/G/I, and a filled row has at least one value there, so this
 * reads what the operator has actually done to the sheet as it stands — never
 * the generation-time findings.
 */
export function unclassifiedWorksheetRows(buf: Buffer): UnclassifiedWorksheetRow[] {
  const sheets = readWorkbook(buf);
  const out: UnclassifiedWorksheetRow[] = [];
  for (const [sheet, name] of [
    ["capital", WS_CAPITAL_SHEET],
    ["revenue", WS_REVENUE_SHEET],
  ] as const) {
    const rows = sheetRows(sheets, name);
    const totalRow = rows.find((r) => r.cells.get(0)?.value === "TOTAL")?.row;
    for (const r of rows) {
      if (r.row < FIRST_DATA_ROW || (totalRow !== undefined && r.row >= totalRow)) continue;
      const ledger = r.cells.get(0)?.value;
      if (typeof ledger !== "string" || ledger.trim() === "") continue;
      const amount = num(r, COL_AMOUNT);
      if (Math.abs(amount) < 0.005) continue;
      let filled = false;
      for (let c = FIRST_BREAKUP_COL; c <= LAST_BREAKUP_COL && !filled; c += 1) {
        const v = r.cells.get(c)?.value;
        filled = v !== undefined && v !== null && v !== "";
      }
      if (!filled) out.push({ sheet, ledger, amount: round2(amount) });
    }
  }
  return out;
}
