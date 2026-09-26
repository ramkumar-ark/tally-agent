// src/gst44-prior.ts
import { readWorkbook } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import { money } from "./format.js";
import type { WorksheetTreatment } from "./gst44-treatments.js";

/**
 * Reader for the prior year's hand-prepared "GST INWARD SUPPLY - NATURE WISE
 * BREAK UP" workbook (the FY 24-25 reference). It supplies the prior-year
 * seeding layer of the working sheet: per ledger name, which break-up columns
 * carried the expenditure last year. Amounts are read for the split note and
 * never echoed anywhere else. Read-only: the reference file is never written.
 *
 * Column roles (captain-confirmed Q-C): D exempt, E composite, F others,
 * H unregistered, J not-supply/paid-to-govt; G = D+E+F and G+H+J = I close
 * every row, so F is normally the derived residual of its own row.
 */

export interface PriorYearRow {
  /** Column A of the prior-year row, for diagnostics only. */
  label: string;
  /** The dominant nonzero treatment column of that row. */
  treatment: WorksheetTreatment;
  /** True when more than one treatment column carried amounts (a split row). */
  split: boolean;
  /** Human-readable profile of the nonzero columns, for the seed reason. */
  profile: string;
}

export interface PriorYearSheets {
  revenue: Map<string, PriorYearRow>;
  capital: Map<string, PriorYearRow>;
}

/** Treatment column letters of the reference layout, D..J skipping G and I. */
const COLUMNS: Array<{ col: number; treatment: WorksheetTreatment; label: string }> = [
  { col: 3, treatment: "exempt", label: "exempt (D)" },
  { col: 4, treatment: "composition", label: "composition (E)" },
  { col: 5, treatment: "others", label: "others (F)" },
  { col: 7, treatment: "unregistered", label: "unregistered (H)" },
  { col: 9, treatment: "not_supply", label: "not supply (J)" },
];

const ZERO = 0.005;

const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
};

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

const LABEL_SKIP = /total|round|as per|difference/i;

/**
 * Read a prior-year break-up workbook into per-sheet treatment maps keyed by
 * canonical ledger name. Sheets are matched by name (REVENUE/CAPITAL,
 * case-insensitive) with a structural fallback (any sheet whose header row
 * carries the exempt column's header, distinguished by the J header). A file
 * with no recognisable sheet is refused loudly, never silently ignored.
 */
export function readPriorWorksheet(buf: Buffer): PriorYearSheets {
  const sheets = readWorkbook(buf);
  const out: PriorYearSheets = { revenue: new Map(), capital: new Map() };
  let recognised = 0;

  for (const sheet of sheets) {
    const byName = /revenue/i.test(sheet.name)
      ? "revenue"
      : /capital/i.test(sheet.name)
        ? "capital"
        : null;
    // Header row: the row whose D cell carries the exempt column's header.
    let headerRow = 0;
    let kind: "revenue" | "capital" | null = byName;
    for (const r of sheet.rows) {
      const d = text(r.cells.get(3)?.value);
      if (/supplies exempt from gst/i.test(d)) {
        headerRow = r.row;
        if (!kind) {
          const j = text(r.cells.get(9)?.value);
          kind = /not supply/i.test(j) ? "revenue" : /paid to govt/i.test(j) ? "capital" : null;
        }
        break;
      }
    }
    if (!headerRow || !kind) continue;
    recognised += 1;
    const map = out[kind];
    for (const r of sheet.rows) {
      if (r.row <= headerRow) continue;
      const label = text(r.cells.get(0)?.value).trim();
      if (!label || LABEL_SKIP.test(label)) continue;
      const amounts = COLUMNS.map((c) => ({ ...c, amount: num(r.cells.get(c.col)?.value) }));
      const nonzero = amounts.filter((a) => Math.abs(a.amount) > ZERO);
      if (nonzero.length === 0) continue;
      const dominant = [...nonzero].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
      map.set(canonicalKey(label), {
        label,
        treatment: dominant.treatment,
        split: nonzero.length > 1,
        profile: nonzero.map((a) => `${a.label} ${money(a.amount)}`).join(" + "),
      });
    }
  }

  if (recognised === 0) {
    throw new Error(
      "the prior-year file is not a GST nature-wise break-up workbook: no sheet carries the 'Supplies exempt from GST' header row",
    );
  }
  return out;
}
