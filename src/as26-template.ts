import { readFileSync } from "node:fs";
import { buildWorkbook, type Sheet } from "./xlsx.js";
import { readWorkbook, type GridRow, type GridSheet } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import { loadAs26Map, round2, EMPTY_AS26_MAP, type As26Map, type As26MapEntry, type BankInterestMapping, type CreditLedgerMapping } from "./as26.js";
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
    [
      "Banks: some banks deduct TDS on fixed-deposit interest. On the 'Bank Interest' sheet, write one row per ledger — the bank's name exactly as it appears in 26AS, then its interest income ledger and/or FD ledger. Presence on that sheet marks the 26AS name a bank: its 194A entries then reconcile on TOTALS (never bill by bill). Leave the sheet empty if no bank interest is involved.",
    ],
    [
      "The FD ledger column is OPTIONAL. Fixed-deposit ledgers under the Deposits (Asset) group are detected automatically (an FD token in the ledger name) and assigned to a bank by its name — a distinctive word or short form of the bank's name inside the FD ledger name (e.g. UBI, UB, SBI), or, when the Bank Interest sheet lists exactly one bank, that bank. An explicit FD ledger here still wins. Ledger names appear on the report's 'FD ledger auto-assign' sheet with the rule that fired; those that could not be assigned are listed there too, marked unassigned.",
    ],
    [
      "TDS/TCS credit ledgers: the asset ledgers a customer DEBITS when it deducts tax from your invoices. Left the sheet empty, the review looks for a 'TDS Receivable'-style name under an asset group — which misses a ledger named e.g. 'TDS (FY:25-26) A/c' under Loans & Advances. If your books name it differently, write it on the 'Credit Ledgers' sheet with its kind (tds or tcs) and the review uses exactly those ledgers, ignoring the name rule. A name that is not a ledger in the books is refused.",
    ],
    ["Worked example (invented names only):"],
    ["Mapping | Sample Builders LLP | tds | 12,000.00 | Sample Builders"],
    ["Credit Ledgers | TDS Receivable A/c | tds"],
  ],
});

const ledgerReferenceSheet = (ledgers: string[]): Sheet => ({
  name: LEDGER_SHEET,
  columns: [{ header: "Tally ledger", width: 40, format: "text" }],
  rows: ledgers.map((l) => [l]),
});

/** The Bank Interest mapping sheet (design §12.5): presence on it marks the
 * 26AS name a bank and names the interest income and FD ledgers belonging to
 * it. Blank so the operator fills it; the columns reuse the Ledgers-backed
 * dropdown range. */
export const BANK_SHEET = "Bank Interest";

function bankInterestSheet(ledgers: string[]): Sheet {
  const validation = ledgers.length > 0
    ? { formula: ledgerRange(ledgers.length + 1) }
    : undefined;
  return {
    name: BANK_SHEET,
    columns: [
      { header: "26AS name (bank)", width: 34, format: "text" },
      { header: "Interest income ledger", width: 34, format: "text", ...(validation ? { validation } : {}) },
      { header: "FD ledger", width: 34, format: "text", ...(validation ? { validation } : {}) },
    ],
    rows: [],
  };
}

/** The operator-declared books-side credit (receivable) ledgers: the ledger a
 *  customer debits when it deducts TDS/TCS, plus which kind it collects. A
 *  non-empty sheet REPLACES the review's name heuristic (it cannot see a
 *  ledger parked under Loans & Advances with no "receivable" in its name).
 *  Pre-filled from the map in force, so re-fill round-trips. */
export const CREDIT_SHEET = "Credit Ledgers";

function creditLedgerSheet(ledgers: string[], declared: CreditLedgerMapping[]): Sheet {
  const validation = ledgers.length > 0
    ? { formula: ledgerRange(ledgers.length + 1) }
    : undefined;
  return {
    name: CREDIT_SHEET,
    columns: [
      {
        header: "TDS/TCS credit ledger",
        width: 34,
        format: "text",
        ...(validation ? { validation } : {}),
      },
      // Two values only: short enough for the inline list, which the ledger
      // range could not be (thousands of names, commas and quotes).
      { header: "kind", width: 6, format: "text", validation: { list: ["tds", "tcs"] } },
    ],
    rows: declared.map((c) => [c.ledger, c.kind]),
  };
}

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
    bankInterestSheet(ledgers),
    creditLedgerSheet(ledgers, opts.map.creditLedgers ?? []),
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
  const banks = parseBankInterestSheet(sheets);
  return { mappings, banks, creditLedgers: parseCreditLedgerSheet(sheets) };
}

const BANK_TOKENS = {
  name: "26asnamebank",
  interest: "interestincomeledger",
  fd: "fdledger",
} as const;

/** The optional Bank Interest sheet (design §12.5). Rows group by canonical
 * 26AS name into one bank entry; a ledger named twice refuses (row number
 * only, never a value). A missing sheet is normal: no bank marked. */
function parseBankInterestSheet(sheets: GridSheet[]): BankInterestMapping[] {
  const sheet = sheets.find((s) => normHeader(s.name) === "bankinterest");
  if (!sheet) return [];
  const header: GridRow | undefined = sheet.rows[0];
  const byHeader = new Map<string, number>();
  for (const [idx, c] of header?.cells ?? []) {
    if (typeof c.value !== "string") continue;
    const k = normHeader(c.value);
    if (!byHeader.has(k)) byHeader.set(k, idx);
  }
  if (byHeader.get(BANK_TOKENS.name) === undefined) {
    throw new Error(
      "as26-map template: the 'Bank Interest' sheet needs an \"26AS name (bank)\" header column" +
        ` — found headers: ${[...byHeader.keys()].join(", ") || "none"}`,
    );
  }
  const interestCol = byHeader.get(BANK_TOKENS.interest) ?? byHeader.get("interestledger");
  const fdCol = byHeader.get(BANK_TOKENS.fd);
  const banks = new Map<string, BankInterestMapping>();
  const seenLedger = new Set<string>();
  for (const r of sheet.rows.slice(1)) {
    const cell = (col: number | undefined, headerName: string): string | undefined => {
      if (col === undefined) return undefined;
      const c = r.cells.get(col);
      if (!c || c.value === null || String(c.value).trim() === "") return undefined;
      if (typeof c.value !== "string") {
        throw new Error(
          `as26-map template row ${r.row}, column ${colLetter(col)} (${headerName}): cell is numeric — retype it as text`,
        );
      }
      return String(c.value).trim();
    };
    const name = cell(byHeader.get(BANK_TOKENS.name), "26AS name (bank)");
    const interest = cell(interestCol, "Interest income ledger");
    const fd = cell(fdCol, "FD ledger");
    if (!name && !interest && !fd) continue;
    if (!name) {
      throw new Error(
        `as26-map template row ${r.row} on the Bank Interest sheet: ledgers are filled but "26AS name (bank)" is blank`,
      );
    }
    const nk = canonicalKey(name);
    let bank = banks.get(nk);
    if (!bank) {
      bank = { as26Name: name, interestLedgers: [], fdLedgers: [] };
      banks.set(nk, bank);
    }
    for (const [led, list, headerName] of [
      [interest, bank.interestLedgers, "Interest income ledger"],
      [fd, bank.fdLedgers, "FD ledger"],
    ] as Array<[string | undefined, string[], string]>) {
      if (!led) continue;
      const lkey = canonicalKey(led);
      if (seenLedger.has(lkey)) {
        throw new Error(
          `as26-map template row ${r.row} on the Bank Interest sheet: names a ledger already named earlier on the sheet`,
        );
      }
      seenLedger.add(lkey);
      list.push(led);
    }
  }
  return [...banks.values()];
}

/** The optional Credit Ledgers sheet: the operator's explicit books-side
 *  credit (receivable) ledgers, one per row with its kind. A missing sheet is
 *  normal (the review falls back to its name heuristic). Every error cites
 *  sheet, row, column letter + header — never a cell value. */
function parseCreditLedgerSheet(sheets: GridSheet[]): CreditLedgerMapping[] {
  const sheet = sheets.find((s) => normHeader(s.name) === "creditledgers");
  if (!sheet) return [];
  const header: GridRow | undefined = sheet.rows[0];
  const byHeader = new Map<string, number>();
  for (const [idx, c] of header?.cells ?? []) {
    if (typeof c.value !== "string") continue;
    const k = normHeader(c.value);
    if (!byHeader.has(k)) byHeader.set(k, idx);
  }
  const ledgerCol =
    byHeader.get("tdstcscreditledger") ??
    byHeader.get("creditledger") ??
    byHeader.get("tallyledger") ??
    byHeader.get("ledger");
  if (ledgerCol === undefined) {
    throw new Error(
      "as26-map template: the 'Credit Ledgers' sheet needs a \"TDS/TCS credit ledger\" header column" +
        ` — found headers: ${[...byHeader.keys()].join(", ") || "none"}`,
    );
  }
  const kindCol = byHeader.get("kind") ?? byHeader.get("tdstcskind") ?? byHeader.get("type");
  const out: CreditLedgerMapping[] = [];
  const seenLedger = new Set<string>();
  for (const r of sheet.rows.slice(1)) {
    const cell = (col: number | undefined, headerName: string): string | undefined => {
      if (col === undefined) return undefined;
      const c = r.cells.get(col);
      if (!c || c.value === null || String(c.value).trim() === "") return undefined;
      if (typeof c.value !== "string") {
        throw new Error(
          `as26-map template row ${r.row}, column ${colLetter(col)} (${headerName}) on the Credit Ledgers sheet: cell is numeric — retype it as text`,
        );
      }
      return String(c.value).trim();
    };
    const ledger = cell(ledgerCol, "TDS/TCS credit ledger");
    const kindText = cell(kindCol, "kind");
    if (!ledger && !kindText) continue;
    if (!ledger) {
      throw new Error(
        `as26-map template row ${r.row} on the Credit Ledgers sheet: "kind" is filled but "TDS/TCS credit ledger" is blank`,
      );
    }
    if (!kindText) {
      throw new Error(
        `as26-map template row ${r.row}, column ${colLetter(kindCol ?? 0)} (kind) on the Credit Ledgers sheet: choose tds or tcs`,
      );
    }
    const kind = normHeader(kindText);
    if (kind !== "tds" && kind !== "tcs") {
      throw new Error(
        `as26-map template row ${r.row}, column ${colLetter(kindCol ?? 0)} (kind) on the Credit Ledgers sheet: expected tds or tcs`,
      );
    }
    const lkey = canonicalKey(ledger);
    if (seenLedger.has(lkey)) {
      throw new Error(
        `as26-map template row ${r.row} on the Credit Ledgers sheet: names a ledger already named earlier on the sheet`,
      );
    }
    seenLedger.add(lkey);
    out.push({ ledger, kind });
  }
  return out;
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
