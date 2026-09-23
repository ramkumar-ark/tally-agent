import { readFileSync } from "node:fs";
import { buildWorkbook, type Sheet } from "./xlsx.js";
import { readWorkbook, type GridRow, type GridSheet } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import { loadAs26Map, round2, EMPTY_AS26_MAP, type As26Map, type As26MapEntry } from "./as26.js";
import type { As26File, As26Kind } from "./as26-file.js";

/**
 * The generated, fillable 26AS party-mapping template (design of record:
 * docs/design/2026-09-22-form-26as-reconciliation-design.md §10). Sister to
 * `src/tds-template.ts`: the gateway writes it by path, the operator fills the
 * "Tally ledger" column in Excel and passes it back as `as26MapPath`.
 *
 * Unlike the blank TDS template, this one is built from real 26AS deductor
 * names and real Tally ledger names, so it is written directly by the workbook
 * writer (never through the de-masking vault wrapper): nothing here was ever
 * masked, and the file lives on the operator's disk like the report workbook.
 */

export interface As26TemplateDeductor {
  name: string;
  kind: As26Kind;
  tax: number;
}

/** One row per distinct 26AS name (the map's own key), tax summed across summaries. */
export function templateDeductors(file: As26File): As26TemplateDeductor[] {
  const byName = new Map<string, As26TemplateDeductor>();
  for (const s of file.summaries) {
    const k = canonicalKey(s.name);
    const d = byName.get(k);
    if (d) d.tax = round2(d.tax + s.taxTotal);
    else byName.set(k, { name: s.name, kind: s.kind, tax: s.taxTotal });
  }
  return [...byName.values()];
}

const normHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
function colLetter(n: number): string {
  let s = "";
  let i = n + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = (i - r - 1) / 26;
  }
  return s;
}

/**
 * The Tally-ledger dropdown is backed by a range on the always-written
 * `Ledgers` sheet, never an inline list: an OOXML list formula joined from
 * names is capped at 255 characters and breaks on a comma or quote, so it
 * cannot carry a real company's ledger list (thousands of names). A
 * cross-sheet range reference has neither limit.
 */
export const LEDGER_SHEET = "Ledgers";

function ledgerRange(lastRow: number): string {
  return `${LEDGER_SHEET}!$A$2:$A$${lastRow}`;
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = n.trim();
    if (!t) continue;
    const k = canonicalKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const instructions = (company: string | undefined, hasLedgers: boolean): Sheet => ({
  name: "Instructions",
  columns: [{ header: "How to fill this template", width: 110, format: "text" }],
  rows: [
    [company ? `26AS mapping template for ${company}.` : "26AS mapping template."],
    [
      "One row per 26AS deductor/collector name. Type the matching Tally ledger name into the \"Tally ledger\" column. Leave it blank to leave that party unmapped — the reconciliation reports it as a mapping gap and computes no money checks for it.",
    ],
    [
      "If one 26AS deductor/collector is represented by several Tally ledgers (for example a customer split across a site ledger and a head-office ledger), add another row for it with the SAME \"26AS name\" and pick the next ledger. The reconciliation sums all of them and compares the total against 26AS once, as a single party. The reverse is a mistake and is refused: a Tally ledger may map to only one 26AS name.",
    ],
    [
      "Privacy: this file carries company and party names. Never paste its rows into chat — pass its path to tb_26as_review as as26MapPath; the file itself is read inside the gateway.",
    ],
    ["Rows already mapped are pre-filled, so you can re-fill and re-run iteratively."],
    [
      hasLedgers
        ? "The Tally ledger column has a dropdown of this company's ledger names, backed by the Ledgers sheet."
        : "The Ledgers sheet lists this company's ledger names for reference — copy a name into the Tally ledger column.",
    ],
    ["Do not rename the sheets or the header columns; the parser binds by header text, never by position."],
    ["Worked example (invented names only):"],
    ["Mapping | Sample Builders LLP | tds | 12,000.00 | Sample Builders"],
  ],
});

const ledgerReferenceSheet = (ledgers: string[]): Sheet => ({
  name: LEDGER_SHEET,
  columns: [{ header: "Tally ledger", width: 40, format: "text" }],
  rows: ledgers.map((l) => [l]),
});

export function buildAs26MapTemplate(opts: {
  company?: string;
  deductors: As26TemplateDeductor[];
  map: As26Map;
  ledgers: string[];
}): Buffer {
  // One 26AS name may carry several ledgers; the first rides the deductor's
  // own row and each extra one gets a follow-on row with the same name (the
  // operator adds such rows by hand, so re-fill must round-trip them too).
  const mappedLedgersBy26as = new Map<string, string[]>();
  for (const m of opts.map.mappings) {
    const k = canonicalKey(m.as26Name);
    const arr = mappedLedgersBy26as.get(k);
    if (arr) arr.push(m.ledger);
    else mappedLedgersBy26as.set(k, [m.ledger]);
  }
  const ledgers = dedupe(opts.ledgers);
  // The Ledgers sheet is always written — it is the dropdown's backing range —
  // even when the company's masters are unavailable (an empty list).
  const lastLedgerRow = ledgers.length + 1;
  const mapping: Sheet = {
    name: "Mapping",
    columns: [
      { header: "26AS name", width: 34, format: "text" },
      { header: "kind", width: 6, format: "text" },
      { header: "26AS tax", width: 14, format: "money" },
      {
        header: "Tally ledger",
        width: 34,
        format: "text",
        ...(ledgers.length > 0 ? { validation: { formula: ledgerRange(lastLedgerRow) } } : {}),
      },
    ],
    rows: opts.deductors.flatMap((d) => {
      const mapped = mappedLedgersBy26as.get(canonicalKey(d.name)) ?? [];
      const first: Array<string | number> = [d.name, d.kind, d.tax, mapped[0] ?? ""];
      const extra = mapped.slice(1).map((ledger): Array<string | number> => [d.name, d.kind, "", ledger]);
      return [first, ...extra];
    }),
  };
  return buildWorkbook([
    instructions(opts.company, ledgers.length > 0),
    mapping,
    ledgerReferenceSheet(ledgers),
  ]);
}

/**
 * Parse a filled mapping template back into the same As26Map the JSON channel
 * yields, so the review merges both sources identically. Blank rows and
 * pre-filled rows whose Tally ledger is still empty are skipped. A 26AS name
 * may repeat (several rows, one ledger each), but a Tally ledger mapped twice
 * refuses, citing the ROW NUMBER only, never a name.
 */
export function parseAs26MapTemplate(buf: Buffer): As26Map {
  const sheets = readWorkbook(buf);
  const sheet: GridSheet | undefined = sheets.find((s) => normHeader(s.name) === "mapping");
  if (!sheet) {
    throw new Error(
      `as26-map template: no "Mapping" sheet — found: ${sheets.map((s) => s.name).join(", ") || "none"}`,
    );
  }
  const header: GridRow | undefined = sheet.rows[0];
  const byHeader = new Map<string, number>();
  for (const [idx, c] of header?.cells ?? []) {
    if (typeof c.value !== "string") continue;
    const k = normHeader(c.value);
    if (!byHeader.has(k)) byHeader.set(k, idx);
  }
  const nameCol = byHeader.get("26asname");
  const ledgerCol =
    byHeader.get("tallyledger") ?? byHeader.get("tallyledgername") ?? byHeader.get("ledger");
  if (nameCol === undefined || ledgerCol === undefined) {
    throw new Error(
      "as26-map template: the Mapping sheet needs \"26AS name\" and \"Tally ledger\" header columns — " +
        "expected headers: 26AS name, kind, 26AS tax, Tally ledger",
    );
  }

  const cellText = (r: GridRow, col: number, headerName: string): string | undefined => {
    const c = r.cells.get(col);
    if (!c || c.value === null || String(c.value).trim() === "") return undefined;
    if (typeof c.value !== "string") {
      throw new Error(
        `as26-map template row ${r.row}, column ${colLetter(col)} (${headerName}): cell is numeric — retype it as text`,
      );
    }
    return String(c.value).trim();
  };

  const mappings: As26MapEntry[] = [];
  const seenLedger = new Set<string>();
  for (const r of sheet.rows.slice(1)) {
    const as26Name = cellText(r, nameCol, "26AS name");
    const ledger = cellText(r, ledgerCol, "Tally ledger");
    if (!as26Name && !ledger) continue; // blank padding row
    if (!as26Name) {
      throw new Error(
        `as26-map template row ${r.row}: "Tally ledger" is filled but "26AS name" is blank`,
      );
    }
    if (!ledger) continue; // pre-filled name, not yet mapped
    const lk = canonicalKey(ledger);
    if (seenLedger.has(lk)) {
      throw new Error(
        `as26-map template row ${r.row}: maps a ledger already mapped earlier in the file`,
      );
    }
    seenLedger.add(lk);
    mappings.push({ ledger, as26Name });
  }
  return { mappings };
}

/** The template loader: a missing file degrades to empty with a warning, like the JSON map. */
export function loadAs26MapTemplate(path: string, warn?: (why: string) => void): As26Map {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e: unknown) {
    warn?.((e as NodeJS.ErrnoException)?.code ?? "unreadable");
    return EMPTY_AS26_MAP;
  }
  return parseAs26MapTemplate(buf);
}

/**
 * The operator map channel dispatches on file extension: a filled `.xlsx`
 * template is parsed as a workbook, anything else as the JSON map. Both yield
 * the same As26Map and share the missing-file degrade.
 */
export function loadAs26MapFile(path: string, warn?: (why: string) => void): As26Map {
  return /\.xls[xm]$/i.test(path) ? loadAs26MapTemplate(path, warn) : loadAs26Map(path, warn);
}

/** The file name the generator tool writes; blank company means "all". */
export function as26TemplateFileName(company: string | undefined, date: string): string {
  const name = (company ?? "all").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `as26-map-template-${name}-${date}.xlsx`;
}
