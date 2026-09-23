// src/as26-file.ts — TRACES Form 26AS export parser. Structure learned from a real
// export under operator-samples rules; every name and figure in tests is invented.
import { readWorkbook } from "./xlsx-read.js";
import { canonicalKey } from "./key.js";
import type { GridSheet } from "./xlsx-read.js";

export type As26Kind = "tds" | "tcs";

export interface As26SummaryRow {
  kind: As26Kind; name: string; nameKey: string; section: string;
  taxTotal: number; taxClaimed: number; balanceCf: number; gross: number;
}

export interface As26Transaction {
  kind: As26Kind; nameKey: string; date: string; // YYYYMMDD
  amount: number; tax: number; status: string;
  bookingDate: string | null; section: string;
}

export interface As26File {
  summaries: As26SummaryRow[];
  transactions: As26Transaction[];
  skipped: { noDate: number; blankTax: number; form16BCDE: number };
}

const normToken = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const SHEET_TOKENS = {
  tdsSummary: "tdsform16a", tdsDetail: "tdsdetailed",
  tcsSummary: "tcs", tcsDetail: "tcsdetailed", form16BCDE: "tdsform16b16c16d16e",
} as const;

const SUMMARY_TOKENS = {
  name: new Set(["deductorname", "collectorname"]),
  taxTotal: new Set(["tdsown", "tcscollected"]),
  taxClaimed: new Set(["tdsclaimedcy", "tcsclaimedcy"]),
  balanceCf: new Set(["balancetdscf"]),
  gross: new Set(["grossreceiptsasper26as", "expenditure26as"]),
  section: new Set(["section"]),
} as const;

const DETAIL_TOKENS = {
  name: new Set(["nameofdeductor", "nameofcollector"]),
  date: new Set(["transactiondate"]),
  amount: new Set(["amountpaidcredited", "amountpaiddebited"]),
  tax: new Set(["taxdeducted", "taxcollected"]),
  status: new Set(["statusofbooking"]),
  bookingDate: new Set(["dateofbooking"]),
  section: new Set(["section"]),
} as const;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Text 'dd-MMM-yyyy' (the detailed sheets) or an Excel serial date cell. */
function as26Date(cell: { value: string | number | null; isDate: boolean } | undefined): string | null {
  if (!cell || cell.value === null || cell.value === "") return null;
  if (cell.isDate && typeof cell.value === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + cell.value * 86400000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(cell.value).trim());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2].toLowerCase());
  if (mo < 0) return null;
  return `${m[3]}${String(mo + 1).padStart(2, "0")}${m[1].padStart(2, "0")}`;
}

function sheetByToken(sheets: GridSheet[], token: string): GridSheet | undefined {
  return sheets.find((s) => normToken(s.name) === token); // name match, state ignored (§0.4)
}

/** Exact-token binding first, then a prefix pass for headersSuffixes like "(Rs.)". */
function bindHeader(sheet: GridSheet, headerRow: number, tokens: Record<string, Set<string>>):
  Map<string, number> {
  const row = sheet.rows.find((r) => r.row === headerRow);
  const bound = new Map<string, number>();
  if (!row) return bound;
  const cellTokens = new Map<number, string>();
  for (const [c, cell] of row.cells) cellTokens.set(c, normToken(String(cell.value ?? "")));
  const m = (prefix = false): void => {
    for (const [field, accept] of Object.entries(tokens)) {
      if (bound.has(field)) continue;
      for (const [c, t] of cellTokens) {
        if (!accept.has(t) && !(prefix && [...accept].some((a) => t.startsWith(a) || a.startsWith(t)))) continue;
        if (prefix && t.length === 0) continue;
        bound.set(field, c);
        break;
      }
    }
  };
  m(false);
  m(true);
  return bound;
}

function locateHeaderRow(sheet: GridSheet, tokens: Set<string>): number | null {
  for (const r of sheet.rows.slice(0, 12)) {
    for (const cell of r.cells.values()) {
      if (tokens.has(normToken(String(cell.value ?? "")))) return r.row;
    }
  }
  return null;
}

const num = (v: string | number | null): number => (typeof v === "number" ? v : Number(v) || 0);

function parseSummaries(sheet: GridSheet, kind: As26Kind): As26SummaryRow[] {
  const headerRow = locateHeaderRow(sheet, SUMMARY_TOKENS.name) ?? 2;
  const b = bindHeader(sheet, headerRow, SUMMARY_TOKENS);
  const out: As26SummaryRow[] = [];
  for (const r of sheet.rows) {
    if (r.row <= headerRow) continue;
    const name = String(r.cells.get(b.get("name") ?? -1)?.value ?? "").trim();
    if (!name || /^[-\s]+$/.test(name)) continue;
    const numeric = [b.get("taxTotal"), b.get("gross"), b.get("taxClaimed")]
      .some((c) => c !== undefined && typeof r.cells.get(c)?.value === "number");
    if (!numeric) continue; // human-header / dash rows never qualify (§0.1)
    out.push({
      kind, name, nameKey: canonicalKey(name),
      section: String(r.cells.get(b.get("section") ?? -1)?.value ?? "").trim(),
      taxTotal: round2(num(r.cells.get(b.get("taxTotal") ?? -1)?.value ?? null)),
      taxClaimed: round2(num(r.cells.get(b.get("taxClaimed") ?? -1)?.value ?? null)),
      balanceCf: round2(num(r.cells.get(b.get("balanceCf") ?? -1)?.value ?? null)),
      gross: round2(num(r.cells.get(b.get("gross") ?? -1)?.value ?? null)),
    });
  }
  return out;
}

export function parseAs26Export(buf: Buffer): As26File {
  const sheets = readWorkbook(buf);
  const found = sheets.map((s) => s.name).join(", ");
  const need = (token: keyof typeof SHEET_TOKENS, human: string): GridSheet => {
    const s = sheetByToken(sheets, SHEET_TOKENS[token]);
    if (!s) throw new Error(`as26 sheet missing: ${human} — found: ${found}`);
    return s;
  };
  const tdsSummary = need("tdsSummary", "TDS - Form 16A");
  need("tdsDetail", "TDS_Detailed");
  const tcsSummary = sheetByToken(sheets, SHEET_TOKENS.tcsSummary);
  if (!tcsSummary) throw new Error(`as26 sheet missing: TCS — found: ${found}`);
  need("tcsDetail", "TCS_Detailed");

  const summaries = [
    ...parseSummaries(tdsSummary, "tds"),
    ...parseSummaries(tcsSummary, "tcs"),
  ];

  const formBCDE = sheetByToken(sheets, SHEET_TOKENS.form16BCDE);
  let form16BCDE = 0;
  if (formBCDE) {
    for (const r of formBCDE.rows) {
      for (const cell of r.cells.values()) if (typeof cell.value === "number") form16BCDE += 1;
    }
  }

  return { summaries, transactions: [], skipped: { noDate: 0, blankTax: 0, form16BCDE } };
}
