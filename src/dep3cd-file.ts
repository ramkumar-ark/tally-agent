import { buildWorkbook, type Sheet } from "./xlsx.js";
import { readWorkbook, type GridCell, type GridSheet } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import {
  accessors,
  bindColumns,
  colLetter,
  dataRows,
  enumCell,
  normHeader,
  raw,
  textCell,
  type CellRef,
} from "./tds-file.js";
import type { Dep3cdAdjustment, Dep3cdOperator } from "./dep3cd.js";
import { rateOfBlock } from "./dep3cd-law.js";

/**
 * The fillable clause-18 operator template: the block mapping and the manual
 * adjustments the books cannot supply. Excel sibling of the loans and 26AS
 * templates (src/loans-file.ts precedent) — written directly by the workbook
 * writer, carrying real ledger and group names on the operator's disk only.
 */

export interface Dep3cdTemplateInput {
  company?: string;
  groups: Array<{ name: string; rate: number | null }>;
  ledgers: Array<{ name: string; group: string }>;
  blockLists: { additions: readonly string[]; deletions: readonly string[] };
}

export interface Dep3cdTemplateParsed {
  operator: Dep3cdOperator;
  blockLists: { additions: string[]; deletions: string[] } | null;
}

export const EMPTY_DEP3CD_OPERATOR: Dep3cdOperator = {
  groupBlocks: new Map(),
  ledgerBlocks: new Map(),
  adjustments: [],
};

const ACTIONS: Dep3cdAdjustment["action"][] = [
  "New purchase",
  "Merge into earlier purchase",
  "Exclude",
  "Consideration",
  "Deduct from 2nd half",
];

/** "2026-09-27" -> "dep3cd-operator-template-all-2026-09-27.xlsx". */
export function dep3cdTemplateFileName(company: string | undefined, date: string): string {
  const name = (company ?? "all").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `dep3cd-operator-template-${name}-${date}.xlsx`;
}

function serialToYmd(n: number): string {
  const d = new Date((n - 25569) * 86400000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * The Adjustments sheet's date is declared dd-mm-yyyy, so it is read day-first
 * with no ambiguity guard (unlike the shared dateCell, which must refuse a
 * both-parts-≤12 slash date). Excel may also hand back a serial.
 */
function depDate(ref: CellRef, cell: GridCell | undefined): string {
  const v = raw(cell).value;
  const fail = (): never => {
    throw new Error(
      `template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): not a date — type it as 10-04-2025 or 20250410`,
    );
  };
  if (v === null || String(v).trim() === "") {
    throw new Error(
      `template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): required cell is blank`,
    );
  }
  if (typeof v === "number") {
    if (raw(cell).isDate) return serialToYmd(v);
    fail();
  }
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return s;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const p = (x: string) => x.padStart(2, "0");
    return `${m[1]}${p(m[2])}${p(m[3])}`;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3].length <= 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${year}${p(month)}${p(day)}`;
  }
  return fail();
}

function candidatesFor(list: readonly string[], rate: number | null): string[] {
  if (rate === null) return [];
  return list.filter((b) => rateOfBlock(b) === rate);
}

/**
 * Two rates are ambiguous in the real list (40 is Buildings or Plant/Machinery,
 * 10 is Buildings or Furniture). The captain fixed the default: 40 -> item 7,
 * 10 -> item 4, so the template pre-fills them rather than leaving them blank.
 */
const RATE_DEFAULT_ITEM: Record<number, RegExp> = {
  40: /^7\.\s/,
  10: /^4\.\s/,
};

function defaultBlockFor(list: readonly string[], rate: number | null): string | null {
  const re = rate === null ? undefined : RATE_DEFAULT_ITEM[rate];
  if (!re) return null;
  return list.find((b) => rateOfBlock(b) === rate && re.test(b.trim())) ?? null;
}

/**
 * Build the operator template. The Winman block column is pre-filled where the
 * additions list gives one unambiguous inference, and for the two ambiguous
 * rates the captain fixed (40 and 10); the remaining ambiguous rows carry their
 * candidates. Both block columns are backed by a
 * cross-sheet range on the hidden `Blocks` sheet (never an inline list — the
 * block strings carry "/" and ":" and a real company's list can grow).
 */
export function buildDep3cdTemplate(input: Dep3cdTemplateInput): Buffer {
  const additions = [...input.blockLists.additions];
  const deletions = [...input.blockLists.deletions];
  const blocksRows: Array<Array<string | number | null>> = [];
  for (let i = 0; i < Math.max(additions.length, deletions.length); i++) {
    blocksRows.push([additions[i] ?? null, deletions[i] ?? null]);
  }

  const groupRows: Array<Array<string | number | null>> = input.groups.map((g) => {
    const cands = candidatesFor(additions, g.rate);
    const prefill = cands.length === 1 ? cands[0] : defaultBlockFor(additions, g.rate);
    return [g.name, g.rate, prefill, cands.length > 1 ? cands.join(" / ") : null];
  });

  const sheets: Sheet[] = [
    {
      name: "Groups",
      columns: [
        { header: "Fixed-asset group", width: 34, format: "text" },
        { header: "Rate from name", width: 14, format: "text" },
        {
          header: "Winman block",
          width: 30,
          format: "text",
          validation: { formula: `Blocks!$A$2:$A$${additions.length + 1}` },
        },
        { header: "Candidates", width: 40, format: "text" },
      ],
      rows: groupRows,
    },
    {
      name: "Ledgers",
      columns: [
        { header: "Asset ledger", width: 40, format: "text" },
        { header: "Group", width: 30, format: "text" },
        {
          header: "Winman block (override)",
          width: 30,
          format: "text",
          validation: { formula: `Blocks!$B$2:$B$${deletions.length + 1}` },
        },
      ],
      rows: input.ledgers.map((l) => [l.name, l.group, null]),
    },
    {
      name: "Adjustments",
      columns: [
        { header: "Asset ledger", width: 40, format: "text" },
        { header: "Date (dd-mm-yyyy)", width: 16, format: "text" },
        { header: "Voucher No", width: 14, format: "text" },
        { header: "Action", width: 28, format: "text", validation: { list: [...ACTIONS] } },
        { header: "Amount", width: 14, format: "money" },
      ],
      rows: [],
    },
    {
      name: "Blocks",
      state: "hidden",
      columns: [{ header: "Additions", width: 30, format: "text" }, { header: "Deletions", width: 30, format: "text" }],
      rows: blocksRows,
    },
  ];
  return buildWorkbook(sheets);
}

function optionalSheet(sheets: GridSheet[], name: string): GridSheet | undefined {
  return sheets.find((x) => normHeader(x.name) === normHeader(name));
}

/** Read the hidden Blocks sheet's two columns; a missing sheet yields null. */
function parseBlocks(sheet: GridSheet | undefined): Dep3cdTemplateParsed["blockLists"] {
  if (!sheet) return null;
  const cols = accessors(bindColumns(sheet, [{ header: "Additions" }, { header: "Deletions" }]));
  const aCol = cols.get("Additions")!;
  const dCol = cols.get("Deletions")!;
  const additions: string[] = [];
  const deletions: string[] = [];
  for (const r of dataRows(sheet)) {
    const a = r.cells.get(aCol)?.value;
    if (typeof a === "string" && a.trim() !== "") additions.push(a.trim());
    const d = r.cells.get(dCol)?.value;
    if (typeof d === "string" && d.trim() !== "") deletions.push(d.trim());
  }
  return { additions, deletions };
}

/**
 * Parse a filled operator template back into the engine's Dep3cdOperator.
 * A missing Groups/Ledgers/Adjustments sheet counts as empty; a missing Blocks
 * sheet yields `blockLists: null`. Blank rows are skipped. Errors cite the
 * sheet, row, column letter and header — never a cell value.
 */
export function parseDep3cdTemplate(buf: Buffer): Dep3cdTemplateParsed {
  const sheets = readWorkbook(buf);
  const operator: Dep3cdOperator = { groupBlocks: new Map(), ledgerBlocks: new Map(), adjustments: [] };

  const groupsSheet = optionalSheet(sheets, "Groups");
  if (groupsSheet) {
    const cols = accessors(
      bindColumns(groupsSheet, [
        { header: "Fixed-asset group" },
        { header: "Rate from name" },
        { header: "Winman block" },
        { header: "Candidates" },
      ]),
    );
    const seen = new Map<string, number>();
    for (const r of dataRows(groupsSheet)) {
      const nameCol = cols.get("Fixed-asset group")!;
      const name = textCell(
        { sheet: groupsSheet, row: r, col: nameCol, header: "Fixed-asset group" },
        r.cells.get(nameCol),
      );
      if (name === undefined) {
        throw new Error(
          `template Groups row ${r.row}, column ${colLetter(nameCol)} (Fixed-asset group): required cell is blank`,
        );
      }
      const key = canonicalKey(name);
      if (seen.has(key)) {
        throw new Error(
          `template Groups row ${r.row}, column ${colLetter(nameCol)} (Fixed-asset group): this group already appears in row ${seen.get(key)} — one row per group`,
        );
      }
      seen.set(key, r.row);
      const blockCol = cols.get("Winman block")!;
      const block = textCell(
        { sheet: groupsSheet, row: r, col: blockCol, header: "Winman block" },
        r.cells.get(blockCol),
      );
      if (block !== undefined) operator.groupBlocks.set(key, block);
    }
  }

  const ledgersSheet = optionalSheet(sheets, "Ledgers");
  if (ledgersSheet) {
    const cols = accessors(
      bindColumns(ledgersSheet, [
        { header: "Asset ledger" },
        { header: "Group" },
        { header: "Winman block (override)" },
      ]),
    );
    const seen = new Map<string, number>();
    for (const r of dataRows(ledgersSheet)) {
      const nameCol = cols.get("Asset ledger")!;
      const name = textCell(
        { sheet: ledgersSheet, row: r, col: nameCol, header: "Asset ledger" },
        r.cells.get(nameCol),
      );
      if (name === undefined) {
        throw new Error(
          `template Ledgers row ${r.row}, column ${colLetter(nameCol)} (Asset ledger): required cell is blank`,
        );
      }
      const key = canonicalKey(name);
      if (seen.has(key)) {
        throw new Error(
          `template Ledgers row ${r.row}, column ${colLetter(nameCol)} (Asset ledger): this ledger already appears in row ${seen.get(key)} — one row per ledger`,
        );
      }
      seen.set(key, r.row);
      const blockCol = cols.get("Winman block (override)")!;
      const block = textCell(
        { sheet: ledgersSheet, row: r, col: blockCol, header: "Winman block (override)" },
        r.cells.get(blockCol),
      );
      if (block !== undefined) operator.ledgerBlocks.set(key, block);
    }
  }

  const adjSheet = optionalSheet(sheets, "Adjustments");
  if (adjSheet) {
    const cols = accessors(
      bindColumns(adjSheet, [
        { header: "Asset ledger" },
        { header: "Date (dd-mm-yyyy)" },
        { header: "Voucher No" },
        { header: "Action" },
        { header: "Amount" },
      ]),
    );
    for (const r of dataRows(adjSheet)) {
      const at = (header: string): CellRef => ({
        sheet: adjSheet,
        row: r,
        col: cols.get(header)!,
        header,
      });
      const ledger = textCell(at("Asset ledger"), r.cells.get(cols.get("Asset ledger")!));
      if (ledger === undefined) {
        throw new Error(
          `template Adjustments row ${r.row}, column ${colLetter(cols.get("Asset ledger")!)} (Asset ledger): required cell is blank`,
        );
      }
      const date = depDate(at("Date (dd-mm-yyyy)"), r.cells.get(cols.get("Date (dd-mm-yyyy)")!));
      const voucherNumber = textCell(at("Voucher No"), r.cells.get(cols.get("Voucher No")!));
      if (voucherNumber === undefined) {
        throw new Error(
          `template Adjustments row ${r.row}, column ${colLetter(cols.get("Voucher No")!)} (Voucher No): required cell is blank`,
        );
      }
      const action = enumCell(
        at("Action"),
        r.cells.get(cols.get("Action")!),
        ACTIONS as string[],
        "not a known action — use the dropdown",
      ) as Dep3cdAdjustment["action"];
      const amountRaw = raw(r.cells.get(cols.get("Amount")!)).value;
      let amount: number | null = null;
      if (amountRaw !== null && String(amountRaw).trim() !== "") {
        const s = String(amountRaw).trim();
        const n = typeof amountRaw === "number" ? amountRaw : Number(s.replace(/[,\s]/g, ""));
        if (!Number.isFinite(n)) {
          throw new Error(
            `template Adjustments row ${r.row}, column ${colLetter(cols.get("Amount")!)} (Amount): not a number — type the amount as digits`,
          );
        }
        amount = n;
      } else if (action === "Consideration") {
        throw new Error(
          `template Adjustments row ${r.row}, column ${colLetter(cols.get("Amount")!)} (Amount): a Consideration row needs an amount`,
        );
      }
      operator.adjustments.push({ ledger, date, voucherNumber, action, amount, row: r.row });
    }
  }

  return { operator, blockLists: parseBlocks(optionalSheet(sheets, "Blocks")) };
}