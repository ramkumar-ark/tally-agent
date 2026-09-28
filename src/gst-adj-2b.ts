import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readWorkbook } from "./xlsx-read.js";
import type { Head } from "./gst-adj-3b.js";

export interface Itc2bEntry {
  key: string;
  docNo: string | null;
  vchNo: string | null;
  date: string;
  party: string;
  gstin: string;
  tax: Head;
}

export interface Itc2bLists {
  lists: Map<string, Itc2bEntry[]>;
  gstinByMonth: Map<string, string>;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const normUpper = (s: string): string => s.replace(/\s+/g, " ").trim().toUpperCase();
const normAlpha = (s: string): string => norm(s).replace(/[^a-z0-9]/g, "");

const SHEET_RE = /^not[ ]?reflected$/i;
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9][A-Z][A-Z0-9])\b/;
const PERIOD_RE = /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/;

const MONTHS_BY_NAME: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function extractFileMonth(file: string, periodMonth: string): string | null {
  const fileMonth = file.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/);
  if (!fileMonth) return null;
  const monthNum = MONTHS_BY_NAME[fileMonth[1].toLowerCase()];
  const yearMatch = periodMonth.slice(0, 4);
  return `${yearMatch}-${monthNum}`;
}

function xlsxFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.xlsx$/i.test(f))
    .sort();
}

function dateFromSerial(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function money(v: unknown): number {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  }
  return 0;
}

function cellStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function parsePeriodDate(period: string, filePath: string, sheetName: string): string {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`gst-adj 2B: ${filePath} sheet "${sheetName}" row 3: cannot find period`);
  let [, dayStr, monStr, yearStr] = m;
  const day = parseInt(dayStr, 10);
  const mon = MONTHS[monStr.toLowerCase()];
  if (!mon) throw new Error(`gst-adj 2B: ${filePath} sheet "${sheetName}" row 3: unknown month "${monStr}"`);
  let year = parseInt(yearStr, 10);
  if (yearStr.length === 2) year = 2000 + year;
  return `${year}-${mon}`;
}

function parseGstin(buf: Buffer): string | null {
  const sheets = readWorkbook(buf);
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      if (row.row > 5) break;
      for (const cell of row.cells.values()) {
        if (cell.value === null || cell.value === undefined) continue;
        const m = GSTIN_RE.exec(String(cell.value));
        if (m) return m[1];
      }
    }
  }
  return null;
}

async function parseSheet(buf: Buffer, filePath: string): Promise<{
  month: string;
  sheetName: string;
  entries: Itc2bEntry[];
  gstin: string;
} | null> {
  const sheets = readWorkbook(buf);
  const sheet = sheets.find((s) => SHEET_RE.test(s.name));
  if (!sheet) return null;

  const gstin = parseGstin(buf) ?? "33AAAAA0000A0Z0";

  let period = "";
  for (const row of sheet.rows) {
    if (row.row > 5) break;
    const cell0 = row.cells.get(0);
    if (cell0?.value && PERIOD_RE.test(String(cell0.value))) {
      period = String(cell0.value);
      break;
    }
  }
  if (!period) throw new Error(`gst-adj 2B: ${filePath} sheet "${sheet.name}" row 3: cannot find period`);
  const month = parsePeriodDate(period, filePath, sheet.name);

  const headerRow6 = sheet.rows.find((r) => r.row === 6);
  const headerRow7 = sheet.rows.find((r) => r.row === 7);
  if (!headerRow6 || !headerRow7) throw new Error(`gst-adj 2B: ${filePath} sheet "${sheet.name}": header rows 6-7 not found`);

  const roleToCol = new Map<string, number>();
  for (const [idx, cell6] of headerRow6.cells) {
    const v6 = cell6?.value ?? "";
    const v7 = headerRow7.cells.get(idx)?.value ?? "";
    const compound = normAlpha(String(v6)) + normAlpha(String(v7));
    let role: string | undefined;
    if (compound === "date") role = "date";
    else if (compound === "particulars") role = "party";
    else if (compound.includes("gstin")) role = "gstin";
    else if (/^vch.*no$/.test(compound)) role = "vchNo";
    else if (/^doc.*no$/.test(compound)) role = "docNo";
    else if (compound === "igst") role = "igst";
    else if (compound === "cgst") role = "cgst";
    else if (compound === "cess") role = "cess";
    else if (compound.includes("sgst")) role = "sgst";
    else if (compound === "cess") role = "cess";
    if (role) roleToCol.set(role, idx);
  }

  const dateCol = roleToCol.get("date");
  if (dateCol === undefined) throw new Error(`gst-adj 2B: ${filePath} sheet "${sheet.name}": date column not found`);

  const dataStart = sheet.rows.findIndex((r) => r.row >= 8);
  if (dataStart < 0) throw new Error(`gst-adj 2B: ${filePath} sheet "${sheet.name}": data rows not found`);

  const entries: Itc2bEntry[] = [];
  for (let i = dataStart; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    const colB = row.cells.get(1);
    if (colB && normAlpha(String(colB.value ?? "")) === "total") break;
    const dateCell = row.cells.get(dateCol);
    if (dateCell?.value === null || dateCell?.value === undefined) continue;

    const dateVal = dateCell.value;
    let date: string;
    if (typeof dateVal === "number") {
      date = dateFromSerial(dateVal);
    } else {
      const s = String(dateVal);
      if (/^\d{8}$/.test(s)) date = s;
      else continue;
    }

    const partyCell = row.cells.get(roleToCol.get("party") ?? -1);
    const party = partyCell?.value ? String(partyCell.value) : "";

    const gstinCell = row.cells.get(roleToCol.get("gstin") ?? -1);
    const entryGstin = gstinCell?.value ? String(gstinCell.value) : gstin;

    const docNoCol = roleToCol.get("docNo");
    const vchNoCol = roleToCol.get("vchNo");
    const docNo = docNoCol !== undefined ? cellStr(row.cells.get(docNoCol)?.value) : null;
    const vchNo = vchNoCol !== undefined ? cellStr(row.cells.get(vchNoCol)?.value) : null;

    const igstCol = roleToCol.get("igst");
    const cgstCol = roleToCol.get("cgst");
    const sgstCol = roleToCol.get("sgst");
    const cessCol = roleToCol.get("cess");

    const key = `${normUpper(cellStr(docNo) ?? cellStr(vchNo) ?? "")}|${normUpper(entryGstin)}`;

    entries.push({
      key,
      docNo,
      vchNo,
      date,
      party,
      gstin: entryGstin,
      tax: {
        igst: money(igstCol !== undefined ? row.cells.get(igstCol)?.value : undefined),
        cgst: money(cgstCol !== undefined ? row.cells.get(cgstCol)?.value : undefined),
        sgst: money(sgstCol !== undefined ? row.cells.get(sgstCol)?.value : undefined),
        cess: money(cessCol !== undefined ? row.cells.get(cessCol)?.value : undefined),
      },
    });
  }

  return { month, sheetName: sheet.name, entries, gstin };
}

export async function parseItc2bFolder(dirPath: string, warn: (msg: string) => void): Promise<Itc2bLists> {
  const lists = new Map<string, Itc2bEntry[]>();
  const gstinByMonth = new Map<string, string>();
  const seenPeriods = new Map<string, string>();

  const files = xlsxFiles(dirPath);
  for (const file of files) {
    const filePath = `${dirPath}/${file}`;
    const st = statSync(filePath);
    if (!st.isFile()) continue;
    const buf = await readFile(filePath);

    const sheets = readWorkbook(buf);
    const sheetName = sheets.find((s) => SHEET_RE.test(s.name)) ?? undefined;
    if (!sheetName) {
      const g = parseGstin(buf);
      let period = "";
      for (const row of sheets[0]?.rows ?? []) {
        if (row.row > 5) break;
        const c = row.cells.get(0);
        if (c?.value && PERIOD_RE.test(String(c.value))) { period = String(c.value); break; }
      }
      const m = period ? parsePeriodDate(period, filePath, sheetName ?? "unknown") : null;
      if (g && m) gstinByMonth.set(m, g);
      warn(`gst-adj 2B: ${file}: no "Not Reflected" sheet found`);
      continue;
    }

    const parsed = await parseSheet(buf, filePath);
    if (!parsed) continue;

    const { month, entries, gstin } = parsed;

    const filenameMonth = extractFileMonth(file, month);
    if (filenameMonth && filenameMonth !== month) {
      warn(`gst-adj 2B: ${file}: filename month ${filenameMonth} disagrees with A3 period ${month}`);
    }

    if (seenPeriods.has(month)) {
      warn(`gst-adj 2B: ignoring repeated period ${month} in ${file} (first from ${seenPeriods.get(month)})`);
      continue;
    }
    seenPeriods.set(month, file);

    const existing = lists.get(month);
    if (existing) {
      for (const e of entries) existing.push(e);
    } else {
      lists.set(month, entries);
    }
    gstinByMonth.set(month, gstin);
  }

  return { lists, gstinByMonth };
}

export function monthDiff(
  lists: Map<string, Itc2bEntry[]>,
  months: string[],
): Record<string, { newly: Itc2bEntry[]; dropped: Itc2bEntry[] }> {
  const result: Record<string, { newly: Itc2bEntry[]; dropped: Itc2bEntry[] }> = {};
  let prev: Itc2bEntry[] = [];
  for (const m of months) {
    const cur = lists.get(m) ?? [];
    const curKeys = new Set(cur.map((e) => e.key));
    const newly = cur.filter((e) => !prev.some((p) => p.key === e.key));
    const dropped = prev.filter((e) => !curKeys.has(e.key));
    result[m] = { newly, dropped };
    prev = cur;
  }
  return result;
}
