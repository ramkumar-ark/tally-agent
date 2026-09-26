import { parseVoucherRows, type VoucherRow } from "./downstream.js";
import { TDS_SECTIONS } from "./tds-law.js";
import { tcsNatureByWinman } from "./tcs-law.js";
import { readWorkbook, type GridCell, type GridRow, type GridSheet } from "./xlsx-read.js";

/**
 * The operator TDS file: the books-unavailable facts the gateway cannot read
 * from Tally. Its contents never transit the model — only its path does (the
 * M2 returnsPath pattern). TANs (the captain's Q7 choice B) live only inside
 * this file and are never echoed into any outbound string: no TAN field
 * exists on any row, and parser errors cite row indexes, never values.
 * Recorded verbatim in docs/design/2026-09-14-tds-compliance-review-design.md.
 */
export interface OperatorSectionMap {
  ledger: string;
  section: string;
  /**
   * Ledger Kind (design §6a): "duty" keeps the ledger off the expense side so
   * its duty credits are never re-counted as bookings when the verbose master
   * export fails. Absent = expense.
   */
  kind?: "expense" | "duty";
}

export interface OperatorParty {
  ledger: string;
  /**
   * The party-side yes/no question Tally itself asks (design §6b): N excludes
   * the ledger from the TDS party set even when the master flags it. The JSON
   * channel defaults to true when the key is absent — a row here has always
   * meant "this is a TDS party", and flipping existing files would delete
   * findings. The template's counterpart column is required instead.
   */
  tdsApplicable: boolean;
  /**
   * The template's typed PAN (§8.4's rate logic and the Winman-name
   * agreement check); the JSON channel never sets it (masters carry it).
   * Compacted on read; never echoed.
   */
  pan?: string;
  /** The Excel row of that PAN — the Parties-row citation in a §8.4 conflict error. */
  panRow?: number;
  /** 194C(6): suppresses the party's contract-payment TDS liability (review-only). */
  transporterDeclaration: boolean;
  /** The s.201(1) proviso fact: shields interest (i), never book-derived. */
  deducteeFiledReturn: boolean;
  /**
   * The declared Winman deductee name (template Parties only): the key the
   * Winman PAN channel joins on (design §8.4). JSON operator files have no
   * Winman name — the ledger name matches Winman's deductee column directly.
   */
  winmanName?: string;
}

export interface OperatorCertificate {
  ledger: string;
  section: string;
  rate: number;
  /** YYYYMMDD */
  from: string;
  to: string;
  limit: number;
}

export interface OperatorChallan {
  section: string;
  /** "2025-05" */
  forMonth: string;
  /** YYYYMMDD */
  depositDate: string;
}

export interface OperatorStatement {
  form: string;
  quarter: "Q1" | "Q2" | "Q3" | "Q4";
  /** YYYYMMDD */
  filedDate: string;
  tdsAmount: number;
  /**
   * The s.206AA(3)/129(1D) fact the books cannot carry: whether the return
   * was accurate. Absent means the consuming engine's default ("Yes").
   */
  returnAccurate?: "Yes" | "No";
}

export interface OperatorTcsSection {
  ledger: string;
  /** An exact TCS_NATURES winman string — never guessed, never normalised. */
  nature: string;
}

export interface OperatorInterestPaid {
  form: string;
  quarter: "Q1" | "Q2" | "Q3" | "Q4";
  amount: number;
  /** YYYYMMDD */
  paidOn: string;
}

/** The union of the two interest sheets' form dropdowns (clause-34 interest channel). */
export const INTEREST_FORMS: readonly string[] = ["24Q", "26A", "26Q", "26QB", "27Q", "27EQ"];

const TAN_SHAPE = /^[A-Z]{4}\d{5}[A-Z]$/;

export interface OperatorFile {
  sections: OperatorSectionMap[];
  parties: OperatorParty[];
  certificates: OperatorCertificate[];
  challans: OperatorChallan[];
  statements: OperatorStatement[];
  /**
   * Whether s.194Q applies at all. The captain's default: 194Q is checked
   * unless the operator expressly says the buyer did not meet the previous
   * year's ₹10 crore turnover condition. Absent in the JSON channel and blank
   * in the template both mean **applicable** (true). This is the whole-review
   * fact the books cannot carry (design §2.3); it suppresses every 194Q
   * booking, never one party's.
   */
  section194QApplicable: boolean;
  /**
   * The operator's TAN, shape-validated. Lives only in this file and is never
   * echoed into any outbound string (Q7 choice B); the template carries it as
   * a Settings row.
   */
  tan?: string;
  /**
   * Whether s.201(1A) 1%-per-month interest on a LATE DEDUCTION is computed
   * (2026-09-26r inbox 067). The captain's call: some companies treat the
   * charge as not applicable, so the operator may turn it off. Absent in the
   * JSON channel and blank in the template both mean **enabled** (true), so
   * other companies are unaffected. When off, no late-deduction interest is
   * computed, no such finding fires, and it is excluded from the 3CD Interest
   * on TDS payable; late-DEPOSIT interest (1.5%) stays unchanged.
   */
  lateDeductionInterest: boolean;
  /** TCS nature-of-receipt mapping: ledger → exact Winman nature string. */
  tcsSections?: OperatorTcsSection[];
  /** Interest the buyer paid on its own default (clause-34/interest channel). */
  interestPaid?: OperatorInterestPaid[];
}

const SECTIONS = new Set(TDS_SECTIONS.map((s) => s.section));
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const num = (v: unknown): number => {
  const n = Number(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const truthy = (v: unknown): boolean =>
  v === true || /^(yes|true|1)$/i.test(String(v ?? "").trim());

/** ISO dash (2025-05-16), slash or bare YYYYMMDD all normalize to YYYYMMDD. */
const normDate = (v: unknown): string => String(v ?? "").replace(/[-/.\s]/g, "");

const text = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

const str = (raw: unknown, at: string): string => {
  const s = text(raw);
  if (!s) throw new Error(`operator file ${at}: a required field is missing or blank`);
  return s;
};

/** Never echoes the value: an error message is an outbound string (R-P-9). */
function sectionOf(raw: unknown, at: string): string {
  const s = str(raw, at);
  if (!SECTIONS.has(s)) {
    throw new Error(`operator file ${at}: section is not a TDS section`);
  }
  return s;
}

function obj(raw: unknown, at: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`operator file ${at}: expected an object`);
  }
  return raw as Record<string, unknown>;
}

function list(doc: Record<string, unknown>, key: string): unknown[] {
  const v = doc[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`operator file "${key}" must be an array`);
  return v;
}

/**
 * Parse and validate the operator TDS file the gateway reads directly from
 * disk. Malformed input is rejected wholesale — no partial processing, so a
 * half-read file can never produce a confident-looking compliance review.
 * Errors cite the row index and never echo a value (a stray operator value
 * can still be a tax id).
 */
export function parseOperatorFile(text: string): OperatorFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("operator TDS file is not valid JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error('operator TDS file must be an object with "sections"/"parties"/"certificates"/"challans"/"statements" arrays');
  }
  const d = doc as Record<string, unknown>;

  const sections: OperatorSectionMap[] = list(d, "sections").map((raw, i) => {
    const r = obj(raw, `sections row ${i + 1}`);
    const kind = String(r.kind ?? "expense").trim().toLowerCase();
    if (kind !== "expense" && kind !== "duty") {
      throw new Error(`operator file sections row ${i + 1}: ledger kind is not Expense or TDS Duty`);
    }
    return {
      ledger: str(r.ledger, `sections row ${i + 1}`),
      section: sectionOf(r.section, `sections row ${i + 1}`),
      ...(kind === "duty" ? { kind: "duty" as const } : {}),
    };
  });

  const parties: OperatorParty[] = list(d, "parties").map((raw, i) => {
    const at = `parties row ${i + 1}`;
    const r = obj(raw, at);
    // A legacy `section` key on a party row is accepted and ignored: no
    // party→section mapping exists any more (design §10).
    void r.section;
    return {
      ledger: str(r.ledger, at),
      tdsApplicable: r.tdsApplicable === undefined ? true : truthy(r.tdsApplicable),
      transporterDeclaration: truthy(r.transporterDeclaration),
      deducteeFiledReturn: truthy(r.deducteeFiledReturn),
    };
  });

  const certificates: OperatorCertificate[] = list(d, "certificates").map((raw, i) => {
    const at = `certificates row ${i + 1}`;
    const r = obj(raw, at);
    return {
      ledger: str(r.ledger, at),
      section: sectionOf(r.section, at),
      rate: num(r.rate),
      from: normDate(r.from),
      to: normDate(r.to),
      limit: num(r.limit),
    };
  });

  const challans: OperatorChallan[] = list(d, "challans").map((raw, i) => {
    const at = `challans row ${i + 1}`;
    const r = obj(raw, at);
    return {
      section: sectionOf(r.section, at),
      forMonth: str(r.forMonth, at),
      depositDate: normDate(r.depositDate),
    };
  });

  const statements: OperatorStatement[] = list(d, "statements").map((raw, i) => {
    const at = `statements row ${i + 1}`;
    const r = obj(raw, at);
    const quarter = str(r.quarter, at);
    if (!QUARTERS.includes(quarter)) {
      throw new Error(`operator file ${at}: quarter is not a calendar quarter`);
    }
    return {
      form: str(r.form, at),
      quarter: quarter as OperatorStatement["quarter"],
      filedDate: normDate(r.filedDate),
      tdsAmount: num(r.tdsAmount),
      ...(r.returnAccurate === undefined ? {} : { returnAccurate: returnAccurateOf(r.returnAccurate, at) }),
    };
  });

  const seenTcsLedgers = new Map<string, number>();
  const tcsSections: OperatorTcsSection[] = list(d, "tcsSections").map((raw, i) => {
    const at = `tcsSections row ${i + 1}`;
    const r = obj(raw, at);
    const ledger = str(r.ledger, at);
    const nature = str(r.nature, at);
    if (tcsNatureByWinman(nature) === null) {
      // Never echoes the value: an error message is an outbound string, and a
      // stray value can be anything — even a tax id planted in the wrong cell.
      throw new Error(`operator file ${at}: nature is not a TCS nature from the Winman dropdown`);
    }
    const key = normHeader(ledger);
    if (seenTcsLedgers.has(key)) {
      throw new Error(`operator file ${at}: this ledger already appears in row ${seenTcsLedgers.get(key)}`);
    }
    seenTcsLedgers.set(key, i + 1);
    return { ledger, nature };
  });

  const seenInterestKeys = new Map<string, number>();
  const interestPaid: OperatorInterestPaid[] = list(d, "interestPaid").map((raw, i) => {
    const at = `interestPaid row ${i + 1}`;
    const r = obj(raw, at);
    const form = str(r.form, at);
    const formKey = form.toUpperCase().replace(/\s+/g, "");
    if (!(INTEREST_FORMS as readonly string[]).includes(formKey)) {
      throw new Error(`operator file ${at}: form is not one of the interest statement forms`);
    }
    const quarter = str(r.quarter, at).toUpperCase();
    if (!QUARTERS.includes(quarter)) {
      throw new Error(`operator file ${at}: quarter is not a calendar quarter`);
    }
    const key = `${formKey}|${quarter}`;
    if (seenInterestKeys.has(key)) {
      throw new Error(`operator file ${at}: this form-and-quarter pair already appears in row ${seenInterestKeys.get(key)}`);
    }
    seenInterestKeys.set(key, i + 1);
    return {
      form: formKey,
      quarter: quarter as OperatorStatement["quarter"],
      amount: num(r.amount),
      paidOn: normDate(r.paidOn),
    };
  });

  const result: OperatorFile = {
    sections,
    parties,
    certificates,
    challans,
    statements,
    // Absent means applicable: the JSON channel's default is the captain's
    // "check 194Q unless told otherwise" (design §6).
    section194QApplicable: d.section194QApplicable === undefined ? true : truthy(d.section194QApplicable),
    // Absent means enabled: the operator may turn the s.201(1A) 1% late-
    // deduction interest off (inbox 067); the default leaves every other
    // company's behaviour unchanged.
    lateDeductionInterest: d.lateDeductionInterest === undefined ? true : truthy(d.lateDeductionInterest),
  };

  if (d.tan !== undefined) result.tan = tanOf(d.tan, 'operator file "tan"');
  if (d.tcsSections !== undefined) result.tcsSections = tcsSections;
  if (d.interestPaid !== undefined) result.interestPaid = interestPaid;
  return result;
}

/** Never echoes the value: a mangled operator string can still be its TAN. */
function tanOf(raw: unknown, at: string): string {
  const s = String(raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!TAN_SHAPE.test(s)) {
    throw new Error(`${at}: not a TAN (four letters, five digits, one letter)`);
  }
  return s;
}

function returnAccurateOf(raw: unknown, at: string): "Yes" | "No" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "yes" || s === "true" || s === "1" || s === "y") return "Yes";
  if (s === "no" || s === "false" || s === "0" || s === "n") return "No";
  throw new Error(`operator file ${at}: returnAccurate is not Yes or No`);
}

/**
 * Parse an operator day-book JSON export: the same `tally_get_vouchers` row
 * shape the upstream returns, so the session layer runs an identical code
 * path for in-tool vouchers and operator-exported ones. No date range is
 * applied here — the caller's period bounds the join, and dropping rows here
 * would hide a coverage gap the engine is meant to surface.
 */
export function parseDayBook(text: string): VoucherRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("operator day-book file is not valid JSON");
  }
  return parseVoucherRows(raw, null, null);
}

export const EMPTY_TDS_OPERATOR: OperatorFile = {
  sections: [],
  parties: [],
  certificates: [],
  challans: [],
  statements: [],
  section194QApplicable: true,
  lateDeductionInterest: true,
};

// ---------------------------------------------------------------------------
// The fillable template (.xlsx) channel: design §14 task 4 and §8.1. Every
// fault names sheet, row and column — never a cell value, which can be a
// mangled tax id (R-P-9).
// ---------------------------------------------------------------------------

export const normHeader = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

export const colLetter = (n: number): string => {
  let out = "";
  let i = n + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    i = (i - r - 1) / 26;
  }
  return out;
};

export interface ColSpec {
  header: string;
  aliases?: string[];
}

export function locatedSheet(sheets: GridSheet[], name: string): GridSheet {
  const s = sheets.find((x) => normHeader(x.name) === normHeader(name));
  if (!s) {
    throw new Error(
      `template sheet missing: the workbook must carry Sections, Parties, Certificates, Challans and Statements — ` +
        `this file has: ${sheets.map((x) => x.name).join(", ")}`,
    );
  }
  return s;
}

/**
 * Bind each logical column to a physical 0-based index by header text (never
 * by position — an inserted helper column must not shift the mapping).
 */
export function bindColumns(sheet: GridSheet, spec: ColSpec[]): Array<{ col: number; header: string }> {
  const headerRow: GridRow | undefined = sheet.rows[0];
  const wanted = spec.map((c) => ({ ...c, norm: normHeader(c.header) }));
  const found: Array<{ col: number; header: string }> = [];
  const byHeader = new Map<string, number>();
  for (const [idx, c] of (headerRow?.cells ?? new Map())) {
    if (c.value === null || c.value === "" || typeof c.value !== "string") continue;
    const k = normHeader(c.value);
    if (!byHeader.has(k)) byHeader.set(k, idx);
  }
  for (const [idx, w] of wanted.entries()) {
    let col = byHeader.get(w.norm);
    if (col === undefined && w.aliases) {
      for (const a of w.aliases) {
        col = byHeader.get(normHeader(a));
        if (col !== undefined) break;
      }
    }
    if (col === undefined) {
      throw new Error(
        `template ${sheet.name}: column ${colLetter(idx)} (${w.header}) is missing — expected headers: ` +
          `${spec.map((s) => s.header).join(", ")}`,
      );
    }
    found.push({ col, header: w.header });
  }
  return found;
}

export type Bound = Array<{ col: number; header: string }>;

export function accessors(bound: Bound): Map<string, number> {
  return new Map(bound.map((b) => [b.header, b.col]));
}

export function dataRows(sheet: GridSheet): GridRow[] {
  // Skip fully-blank data rows: the writer emits every cell incl. empties,
  // so a trailing blank row is a normal End-of-table marker.
  return (sheet.rows.slice(1) as GridRow[]).filter(
    (r) => [...r.cells.values()].some((c) => c.value !== null && c.value !== ""),
  );
}

export interface CellRef {
  sheet: GridSheet;
  row: GridRow;
  col: number;
  header: string;
}

export function raw(cell: GridCell | undefined): GridCell {
  return cell ?? { value: null, isDate: false };
}

function flag(ref: CellRef, cell: GridCell | undefined): boolean {
  const s = String(raw(cell).value ?? "").trim().toLowerCase();
  if (s === "" || s === "n" || s === "no" || s === "off" || s === "false" || s === "0") return false;
  if (s === "y" || s === "yes" || s === "on" || s === "true" || s === "1") return true;
  throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): enter Y or N`);
}

/**
 * The optional Settings sheet: `Setting` / `Value` rows, one per whole-review
 * fact. Currently "194Q Applicable" (the captain's default 194Q check,
 * suppressible when the buyer did not meet the previous-year ₹10 crore
 * turnover condition), "TAN" (blank means absent) and "Late Deduction
 * Interest" (the s.201(1A) 1% charge, default enabled). A blank value means
 * the setting's default, so a template with the row but an empty cell behaves
 * like one without it. An unknown Setting label is rejected wholesale (never
 * guessed), and the error cites sheet/row/column, never a cell value.
 */
function settingsSheetFacts(sheet: GridSheet): { section194QApplicable: boolean; lateDeductionInterest: boolean; tan?: string } {
  const cols = accessors(bindColumns(sheet, [{ header: "Setting" }, { header: "Value" }]));
  let value = true;
  let lateDeductionInterest = true;
  let tan: string | undefined;
  for (const r of dataRows(sheet)) {
    const at = (col: number, header: string): CellRef => ({ sheet, row: r, col, header });
    const key = textCell(at(cols.get("Setting")!, "Setting"), r.cells.get(cols.get("Setting")!));
    if (key === undefined) {
      throw new Error(`template Settings row ${r.row}, column A (Setting): required cell is blank`);
    }
    const label = normHeader(key);
    if (label === "194q applicable") {
      const v = textCell(at(cols.get("Value")!, "Value"), r.cells.get(cols.get("Value")!));
      if (v !== undefined) value = flag(at(cols.get("Value")!, "Value"), r.cells.get(cols.get("Value")!));
      continue;
    }
    if (label === "late deduction interest") {
      const v = textCell(at(cols.get("Value")!, "Value"), r.cells.get(cols.get("Value")!));
      if (v !== undefined) lateDeductionInterest = flag(at(cols.get("Value")!, "Value"), r.cells.get(cols.get("Value")!));
      continue;
    }
    if (label === "tan") {
      const rawVal = raw(r.cells.get(cols.get("Value")!)).value;
      if (rawVal === null || String(rawVal).trim() === "") continue;
      const ref = at(cols.get("Value")!, "Value");
      if (typeof rawVal === "number") {
        throw new Error(`template ${ref.sheet.name} row ${r.row}, column ${colLetter(ref.col)} (${ref.header}): cell is numeric — retype the TAN as text`);
      }
      tan = tanOf(String(rawVal), `template ${ref.sheet.name} row ${r.row}, column ${colLetter(ref.col)} (${ref.header})`);
      continue;
    }
    throw new Error(`template Settings row ${r.row}, column A (Setting): not a known setting — the settings are "194Q Applicable", "Late Deduction Interest" and "TAN"`);
  }
  return { section194QApplicable: value, lateDeductionInterest, tan };
}

const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function pan(ref: CellRef, cell: GridCell | undefined): string | undefined {
  const v = raw(cell).value;
  if (v === null || String(v).trim() === "") return undefined;
  if (typeof v === "number") {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): cell is numeric — Excel converted the PAN; retype the column as text`);
  }
  const s = String(v).replace(/\s+/g, "").toUpperCase();
  if (!PAN_SHAPE.test(s)) {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): not a PAN (five letters, four digits, one letter)`);
  }
  return s;
}

function serialToYmd(n: number): string {
  const d = new Date((n - 25569) * 86400000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

export function dateCell(ref: CellRef, cell: GridCell | undefined): string {
  const v = raw(cell).value;
  if (v === null || String(v).trim() === "") {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): required cell is blank`);
  }
  if (typeof v === "number") {
    if (ref.sheet.name && raw(cell).isDate) return serialToYmd(v);
  }
  const s = String(v).trim();
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (dash) {
    const p = (x: string) => x.padStart(2, "0");
    return `${dash[1]}${p(dash[2])}${p(dash[3])}`;
  }
  if (/^\d{8}$/.test(s)) return s;
  const slash = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const year = slash[3].length <= 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
    if (day <= 12 && month <= 12) {
      throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): date is ambiguous — Excel read both parts as day and month; type it as 2026-01-16 or 20260116`);
    }
    const p = (x: number) => String(x).padStart(2, "0");
    return `${year}${p(month)}${p(day)}`;
  }
  throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): not a date — type it as 2026-01-16 or 20260116`);
}

export function amountCell(ref: CellRef, cell: GridCell | undefined): number {
  const v = raw(cell).value;
  if (v === null || String(v).trim() === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^[₹]|^rs\b/i.test(s)) {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): remove the currency symbol — digits only`);
  }
  const n = Number(s.replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): not a number — type the amount as digits (Indian commas are fine)`);
  }
  return n;
}

function rateCell(ref: CellRef, cell: GridCell | undefined): number {
  const v = raw(cell).value;
  if (v === null || String(v).trim() === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[%\s]/g, ""));
  if (!Number.isFinite(n)) {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): not a rate — enter the percentage as a number (2.00)`);
  }
  return n;
}

/** The enum text families: sections, kind, quarter, form. */
export function enumCell(
  ref: CellRef,
  cell: GridCell | undefined,
  allowed: string[],
  msg: string,
): string {
  const s = String(raw(cell).value ?? "").trim().toLowerCase();
  if (s === "") {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): required cell is blank`);
  }
  const hit = allowed.find((a) => a.toLowerCase() === s);
  if (hit === undefined) throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): ${msg}`);
  return hit;
}

export function textCell(ref: CellRef, cell: GridCell | undefined): string | undefined {
  const v = raw(cell).value;
  if (v === null || String(v).trim() === "") return undefined;
  if (typeof v !== "string") {
    throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): cell is numeric — retype as text`);
  }
  return String(v).trim();
}

/**
 * Find an optional column by header text (or alias); absent header means
 * undefined, never an error — old templates keep parsing unchanged.
 */
function optionalColumn(sheet: GridSheet, header: string, aliases: string[] = []): number | undefined {
  const headerRow: GridRow | undefined = sheet.rows[0];
  const wanted = [header, ...aliases].map(normHeader);
  for (const [idx, c] of headerRow?.cells ?? new Map()) {
    if (typeof c.value === "string" && wanted.includes(normHeader(c.value))) return idx;
  }
  return undefined;
}

/** The Yes/No family normalised to "Yes"/"No"; blank means absent. */
function yesNoCell(ref: CellRef, cell: GridCell | undefined): "Yes" | "No" | undefined {
  const s = String(raw(cell).value ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  if (s === "yes" || s === "y" || s === "true" || s === "1") return "Yes";
  if (s === "no" || s === "n" || s === "false" || s === "0") return "No";
  throw new Error(`template ${ref.sheet.name} row ${ref.row.row}, column ${colLetter(ref.col)} (${ref.header}): enter Yes or No`);
}

/**
 * Parse the fillable template produced by `tb_write_tds_template` back into
 * the same OperatorFile the JSON channel yields, so the session merges both
 * sources identically (design §8.1: same schema after parse, template wins
 * conflicts, JSON channels default true on absent keys). Nested inside a
 * template download or a named sheet, hidden included, the missing-sheet
 * error still names what was found instead. A Winman export has none of the
 * five sheets — its missing-sheet error lists the sheet names the file HAS.
 * Faults cite sheet, row and column but never echo a cell value: a stray
 * operator value can still be a PAN or a TAN.
 */
export function parseOperatorTemplate(buf: Buffer): OperatorFile {
  const sheets = readWorkbook(buf);

  const sectionEnums = TDS_SECTIONS.map((s) => s.section);
  const sectionsSheet = locatedSheet(sheets, "Sections");
  const sectionCols = accessors(
    bindColumns(sectionsSheet, [
      { header: "Tally Ledger Name" },
      { header: "Section" },
      { header: "Ledger Kind", aliases: ["Ledger kind", "Kind"] },
    ]),
  );
  const seenSectionKeys = new Map<string, number>();
  const sections: OperatorSectionMap[] = [];
  for (const r of dataRows(sectionsSheet)) {
    const ledger = textCell({ sheet: sectionsSheet, row: r, col: sectionCols.get("Tally Ledger Name")!, header: "Tally Ledger Name" }, r.cells.get(sectionCols.get("Tally Ledger Name")!));
    if (ledger === undefined) {
      throw new Error(`template Sections row ${r.row}, column ${colLetter(sectionCols.get("Tally Ledger Name")!)} (Tally Ledger Name): required cell is blank`);
    }
    const sectionCell = r.cells.get(sectionCols.get("Section")!);
    const sectionVal = String(raw(sectionCell).value ?? "").trim();
    if (sectionVal === "") {
      // Blank section means not applicable for TDS per template instructions ("Leave a cell blank to mean 'not applicable'")
      continue;
    }
    const ref: CellRef = { sheet: sectionsSheet, row: r, col: sectionCols.get("Section")!, header: "Section" };
    const section = enumCell(ref, sectionCell, sectionEnums, "not a TDS section — use the dropdown");
    const kindRef: CellRef = { sheet: sectionsSheet, row: r, col: sectionCols.get("Ledger Kind")!, header: "Ledger Kind" };
    const kindRaw = textCell(kindRef, r.cells.get(sectionCols.get("Ledger Kind")!));
    if (kindRaw !== undefined) {
      const k = normHeader(kindRaw).replace(/^tds /, "");
      if (k !== "expense" && k !== "duty") {
        throw new Error(`template Sections row ${r.row}, column ${colLetter(sectionCols.get("Ledger Kind")!)} (Ledger Kind): not Expense or TDS Duty`);
      }
    }
    const key = `${normHeader(ledger)}|${normHeader(section)}`;
    if (seenSectionKeys.has(key)) {
      throw new Error(`template Sections row ${r.row}, column A (Tally Ledger Name): this ledger-and-section pair already appears in row ${seenSectionKeys.get(key)}`);
    }
    seenSectionKeys.set(key, r.row);
    sections.push(
      kindRaw !== undefined && normHeader(kindRaw).replace(/^tds /, "") === "duty"
        ? { ledger, section, kind: "duty" as const }
        : { ledger, section },
    );
  }

  const partiesSheet = locatedSheet(sheets, "Parties");
  const partyCols = accessors(
    bindColumns(partiesSheet, [
      { header: "Tally Ledger Name" },
      { header: "TDS Applicable", aliases: ["Applicable", "Tds Applicable?"] },
      { header: "PAN" },
      { header: "Transporter Declaration 194C(6)", aliases: ["Transporter Declaration 194c(6)", "194C(6) Declaration"] },
      { header: "Deductee Filed Return s.201(1)", aliases: ["Deductee Filed Return s.201(1)", "Filed Return u/s 201(1)"] },
      { header: "Winman Deductee Name", aliases: ["Winman Name"] },
    ]),
  );
  const seenParties = new Map<string, number>();
  const parties: OperatorParty[] = dataRows(partiesSheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({ sheet: partiesSheet, row: r, col, header });
    const ledger = textCell(at(partyCols.get("Tally Ledger Name")!, "Tally Ledger Name"), r.cells.get(partyCols.get("Tally Ledger Name")!));
    if (ledger === undefined) {
      throw new Error(`template Parties row ${r.row}, column ${colLetter(partyCols.get("Tally Ledger Name")!)} (Tally Ledger Name): required cell is blank`);
    }
    const key = normHeader(ledger);
    if (seenParties.has(key)) {
      throw new Error(`template Parties row ${r.row}, column A (Tally Ledger Name): this ledger already appears in row ${seenParties.get(key)} — one row per party`);
    }
    seenParties.set(key, r.row);
    // PAN is validated (and any Excel mangling rejected) but never echoed;
    // the template's own PAN feeds the Winman-name PAN agreement check (§8.4)
    // and nothing else downstream uses it directly.
    const panValue = pan(at(partyCols.get("PAN")!, "PAN"), r.cells.get(partyCols.get("PAN")!));
    const row: OperatorParty = {
      ledger,
      tdsApplicable: flag(at(partyCols.get("TDS Applicable")!, "TDS Applicable"), r.cells.get(partyCols.get("TDS Applicable")!)),
      transporterDeclaration: flag(at(partyCols.get("Transporter Declaration 194C(6)")!, "Transporter Declaration 194C(6)"), r.cells.get(partyCols.get("Transporter Declaration 194C(6)")!)),
      deducteeFiledReturn: flag(at(partyCols.get("Deductee Filed Return s.201(1)")!, "Deductee Filed Return s.201(1)"), r.cells.get(partyCols.get("Deductee Filed Return s.201(1)")!)),
    };
    if (panValue !== undefined) {
      row.pan = panValue;
      row.panRow = r.row;
    }
    const winman = textCell(at(partyCols.get("Winman Deductee Name")!, "Winman Deductee Name"), r.cells.get(partyCols.get("Winman Deductee Name")!));
    if (winman !== undefined) row.winmanName = winman;
    return row;
  });

  const certsSheet = locatedSheet(sheets, "Certificates");
  const certCols = accessors(
    bindColumns(certsSheet, [
      { header: "Tally Ledger Name" },
      { header: "Section" },
      { header: "Rate %", aliases: ["Rate", "Rate (%)"] },
      { header: "From Date", aliases: ["Valid From"] },
      { header: "To Date", aliases: ["Valid To"] },
      { header: "Limit" },
    ]),
  );
  const seenCerts = new Map<string, number>();
  const certificates: OperatorCertificate[] = dataRows(certsSheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({ sheet: certsSheet, row: r, col, header });
    const ledger = textCell(at(certCols.get("Tally Ledger Name")!, "Tally Ledger Name"), r.cells.get(certCols.get("Tally Ledger Name")!));
    if (ledger === undefined) {
      throw new Error(`template Certificates row ${r.row}, column ${colLetter(certCols.get("Tally Ledger Name")!)} (Tally Ledger Name): required cell is blank`);
    }
    const section = enumCell(
      at(certCols.get("Section")!, "Section"),
      r.cells.get(certCols.get("Section")!),
      sectionEnums,
      "not a TDS section — use the dropdown",
    );
    const key = `${normHeader(ledger)}|${normHeader(section)}`;
    if (seenCerts.has(key)) {
      throw new Error(`template Certificates row ${r.row}, column A (Tally Ledger Name): this ledger-and-section pair already appears in row ${seenCerts.get(key)}`);
    }
    seenCerts.set(key, r.row);
    return {
      ledger,
      section,
      rate: rateCell(at(certCols.get("Rate %")!, "Rate %"), r.cells.get(certCols.get("Rate %")!)),
      from: dateCell(at(certCols.get("From Date")!, "From Date"), r.cells.get(certCols.get("From Date")!)),
      to: dateCell(at(certCols.get("To Date")!, "To Date"), r.cells.get(certCols.get("To Date")!)),
      limit: amountCell(at(certCols.get("Limit")!, "Limit"), r.cells.get(certCols.get("Limit")!)),
    };
  });

  const challansSheet = locatedSheet(sheets, "Challans");
  const challanCols = accessors(
    bindColumns(challansSheet, [
      { header: "Section" },
      { header: "For Month", aliases: ["Month", "for Month"] },
      { header: "Deposit Date", aliases: ["Deposited On"] },
    ]),
  );
  const seenChallans = new Map<string, number>();
  const challans: OperatorChallan[] = dataRows(challansSheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({ sheet: challansSheet, row: r, col, header });
    const section = enumCell(
      at(challanCols.get("Section")!, "Section"),
      r.cells.get(challanCols.get("Section")!),
      sectionEnums,
      "not a TDS section — use the dropdown",
    );
    const forMonth = textCell(at(challanCols.get("For Month")!, "For Month"), r.cells.get(challanCols.get("For Month")!));
    if (forMonth === undefined || !/^\d{4}-\d{2}$/.test(forMonth)) {
      throw new Error(`template Challans row ${r.row}, column ${colLetter(challanCols.get("For Month")!)} (For Month): not a month — enter it as 2025-05`);
    }
    const key = `${normHeader(section)}|${forMonth}`;
    if (seenChallans.has(key)) {
      throw new Error(`template Challans row ${r.row}, column B (For Month): this section-and-month pair already appears in row ${seenChallans.get(key)}`);
    }
    seenChallans.set(key, r.row);
    return { section, forMonth, depositDate: dateCell(at(challanCols.get("Deposit Date")!, "Deposit Date"), r.cells.get(challanCols.get("Deposit Date")!)) };
  });

  const stmtsSheet = locatedSheet(sheets, "Statements");
  const stmtCols = accessors(
    bindColumns(stmtsSheet, [
      { header: "Form" },
      { header: "Quarter" },
      { header: "Filed Date", aliases: ["Filed On"] },
      { header: "TDS Amount" },
    ]),
  );
  // The Return Accurate column is OPTIONAL: a template filled before it
  // existed parses unchanged, the facts then absent everywhere.
  const returnAccurateCol = optionalColumn(stmtsSheet, "Return Accurate? (Yes/No)", ["Return Accurate"]);
  const seenStatements = new Map<string, number>();
  const statements: OperatorStatement[] = dataRows(stmtsSheet).map((r) => {
    const at = (col: number, header: string): CellRef => ({ sheet: stmtsSheet, row: r, col, header });
    const form = enumCell(
      at(stmtCols.get("Form")!, "Form"),
      r.cells.get(stmtCols.get("Form")!),
      ["24Q", "26Q", "27Q"],
      "not a TDS Form — use the dropdown (24Q, 26Q, 27Q)",
    );
    const quarter = enumCell(
      at(stmtCols.get("Quarter")!, "Quarter"),
      r.cells.get(stmtCols.get("Quarter")!),
      ["Q1", "Q2", "Q3", "Q4"],
      "not a quarter — enter Q1, Q2, Q3 or Q4",
    );
    const key = `${normHeader(form)}|${normHeader(quarter)}`;
    if (seenStatements.has(key)) {
      throw new Error(`template Statements row ${r.row}, column B (Quarter): this Form-and-quarter pair already appears in row ${seenStatements.get(key)}`);
    }
    seenStatements.set(key, r.row);
    const row: OperatorStatement = {
      form,
      quarter: quarter as OperatorStatement["quarter"],
      filedDate: dateCell(at(stmtCols.get("Filed Date")!, "Filed Date"), r.cells.get(stmtCols.get("Filed Date")!)),
      tdsAmount: amountCell(at(stmtCols.get("TDS Amount")!, "TDS Amount"), r.cells.get(stmtCols.get("TDS Amount")!)),
    };
    if (returnAccurateCol !== undefined) {
      const v = yesNoCell(at(returnAccurateCol, "Return Accurate? (Yes/No)"), r.cells.get(returnAccurateCol));
      if (v !== undefined) row.returnAccurate = v;
    }
    return row;
  });

  // The Settings sheet carries the whole-review facts. It is OPTIONAL: a
  // template filled before it existed (or one an operator deleted) defaults
  // every setting to its captain-approved value, here "194Q applicable".
  const settingsSheet = sheets.find((x) => normHeader(x.name) === normHeader("Settings"));
  const settings = settingsSheet === undefined
    ? { section194QApplicable: true as const, lateDeductionInterest: true as const, tan: undefined }
    : settingsSheetFacts(settingsSheet);

  const out: OperatorFile = {
    sections,
    parties,
    certificates,
    challans,
    statements,
    section194QApplicable: settings.section194QApplicable,
    lateDeductionInterest: settings.lateDeductionInterest,
  };
  if (settings.tan !== undefined) out.tan = settings.tan;

  // The clause-34 sheets are OPTIONAL too: a template filled before they
  // existed parses unchanged, its new facts simply absent.
  const tcsSheet = sheets.find((x) => normHeader(x.name) === normHeader("TCS Sections"));
  const tcsRows = tcsSheet === undefined ? [] : dataRows(tcsSheet);
  if (tcsRows.length > 0 && tcsSheet) {
    const tcsCols = accessors(bindColumns(tcsSheet, [
      { header: "Ledger" },
      { header: "Nature of receipt (exact Winman text)", aliases: ["Nature of receipt", "Nature"] },
    ]));
    const seenTcs = new Map<string, number>();
    out.tcsSections = tcsRows.map((r) => {
      const ledgerRef: CellRef = { sheet: tcsSheet, row: r, col: tcsCols.get("Ledger")!, header: "Ledger" };
      const ledger = textCell(ledgerRef, r.cells.get(tcsCols.get("Ledger")!));
      if (ledger === undefined) {
        throw new Error(`template TCS Sections row ${r.row}, column A (Ledger): required cell is blank`);
      }
      const key = normHeader(ledger);
      if (seenTcs.has(key)) {
        throw new Error(`template TCS Sections row ${r.row}, column A (Ledger): this ledger already appears in row ${seenTcs.get(key)}`);
      }
      seenTcs.set(key, r.row);
      const natureRef: CellRef = { sheet: tcsSheet, row: r, col: tcsCols.get("Nature of receipt (exact Winman text)")!, header: "Nature of receipt (exact Winman text)" };
      const nature = textCell(natureRef, r.cells.get(tcsCols.get("Nature of receipt (exact Winman text)")!));
      if (nature === undefined || tcsNatureByWinman(nature) === null) {
        // Never echoes the value: a stray operator cell can be anything.
        throw new Error(`template TCS Sections row ${r.row}, column B (Nature of receipt (exact Winman text)): not a TCS nature — use the dropdown`);
      }
      return { ledger, nature };
    });
  }

  const interestSheet = sheets.find((x) => normHeader(x.name) === normHeader("Interest Paid"));
  const interestRows = interestSheet === undefined ? [] : dataRows(interestSheet);
  if (interestRows.length > 0 && interestSheet) {
    const interestCols = accessors(bindColumns(interestSheet, [
      { header: "Form" },
      { header: "Quarter (Q1-Q4)", aliases: ["Quarter"] },
      { header: "Amount" },
      { header: "Paid on", aliases: ["Paid On"] },
    ]));
    const seenInterest = new Map<string, number>();
    out.interestPaid = interestRows.map((r) => {
      const at = (col: number, header: string): CellRef => ({ sheet: interestSheet, row: r, col, header });
      const form = enumCell(
        at(interestCols.get("Form")!, "Form"),
        r.cells.get(interestCols.get("Form")!),
        [...INTEREST_FORMS],
        "not one of the interest statement forms — use the dropdown (24Q, 26A, 26Q, 26QB, 27Q, 27EQ)",
      );
      const quarterHeader = "Quarter (Q1-Q4)";
      const quarter = enumCell(
        at(interestCols.get(quarterHeader)!, quarterHeader),
        r.cells.get(interestCols.get(quarterHeader)!),
        QUARTERS,
        "not a quarter — enter Q1, Q2, Q3 or Q4",
      ) as OperatorStatement["quarter"];
      const key = `${form}|${quarter}`;
      if (seenInterest.has(key)) {
        throw new Error(`template Interest Paid row ${r.row}, column B (Quarter (Q1-Q4)): this form-and-quarter pair already appears in row ${seenInterest.get(key)}`);
      }
      seenInterest.set(key, r.row);
      return {
        form,
        quarter,
        amount: amountCell(at(interestCols.get("Amount")!, "Amount"), r.cells.get(interestCols.get("Amount")!)),
        paidOn: dateCell(at(interestCols.get("Paid on")!, "Paid on"), r.cells.get(interestCols.get("Paid on")!)),
      };
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// The Winman TDS-summary export (.xlsx). Layout of record is §2 of
// docs/design/2026-09-16-tds-spreadsheet-input-design.md, examined one Excel
// sheet at a time there. Five sheets listded by workbook.xml only — `List` is
// veryHidden scratch and is skipped **by state**, never by name.
// ---------------------------------------------------------------------------

/** The §8.2 detail: what a Winman file yields, after labels have been stripped. */
export interface WinmanFacts {
  /** §8.3: derived from the Deduction sheet's own allocation, not its bare list. */
  challans: OperatorChallan[];
  /**
   * The Deduction sheet's challan-to-deductee allocation, one row per joined
   * Deduction row (2026-09-26i): the Winman deductee name, the §8.2-split
   * section, the row's own deducted tax, the deduction date and the joined
   * challan's deposit date. Deposit evidence alongside the books' deposit
   * debits — a deduction it covers, deposited after the FY end, is
   * "deposited in the subsequent year". Names are Winman spellings; the
   * template's Winman Deductee Name column joins them to Tally ledgers.
   */
  allocations: WinmanAllocation[];
  /** Deductee sheet rows, spaces compacted; the join the template declares. */
  deductees: Array<{ name: string; pan: string | null }>;
  /** The meta row's `Form : 26Q` — read only. */
  formType: string | null;
  /**
   * The Deductor block's TAN, shape-validated (the 2026-09-26 addendum's item
   * 1: it was parsed and dropped before). Null when the block is absent or
   * the TAN cell is blank. Lives only in this file, like every other TAN.
   */
  tan: string | null;
  /**
   * The Deductor block's name (2026-09-26r, inbox 065): the 3CD sheets must
   * show the deductor as the return does, not the Tally company name. The
   * `Name` label wins; `Name as per department records` is the fallback. Null
   * when absent — the caller then fails rather than showing the Tally name.
   */
  deductorName: string | null;
  skipped: { noSection: number; noJoin: number };
}

const normWin = (v: unknown): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().toLowerCase() : "";

/** One joined Deduction-sheet row: who the challan's tax was deducted for. */
export interface WinmanAllocation {
  /** The Deduction sheet's Name cell, trimmed (Winman spelling). */
  name: string;
  /** The §8.2-split section key (never a bare label). */
  section: string;
  /** The row's own "Deducted and deposited - Tax". */
  tax: number;
  /** The row's Deduction Date (YYYYMMDD). */
  dedDate: string;
  /**
   * The row's own "Paid / Credited Date" (YYYYMMDD), the date the sum was
   * paid or credited. The s.201(1A)(i) late-deduction 1% interest runs from
   * this date to the deduction date (2026-09-26u); empty when Winman omits it.
   */
  paidDate: string;
  /** The joined challan's deposit date (YYYYMMDD). */
  depositDate: string;
  /**
   * The joined challan's own Interest column (2026-09-26p), 0 when absent —
   * the interest actually paid on a late deposit, read from the Winman
   * challan rather than hard-coded.
   */
  interestPaid: number;
  /**
   * The joined challan's `ID No.` (2026-09-26p): the challan identity, so a
   * single challan covering several deductions of the same section has its
   * interest counted once.
   */
  challanId: string;
}

/**
 * §8.2 section normalisation with **no guessing**: the token before " - "
 * maps `194I(a)`/`194I(b)` onto the split keys and the rest straight onto the
 * law table; a bare `194I` (or anything else Winman says) resolves to null —
 * such a row is counted into `skipped.noSection`, never key-hacked.
 */
export function winmanSectionKey(label: unknown): string | null {
  const s = typeof label === "string" ? label : "";
  const token = s.split(" - ")[0].replace(/[^A-Za-z0-9()]/g, "").toUpperCase(); // "194I(A)"
  if (/^194I\(A\)$/.test(token)) return "194-I(a)";
  if (/^194I\(B\)$/.test(token)) return "194-I(b)";
  if (/^194[AHQCJT]$/.test(token)) return token; // 194C 194J 194A 194H 194Q 194T — I(on its own) excluded
  return null;
}

interface WinCols {
  byHeader: Map<string, number>;
  headerIdx: number;
}

/**
 * Marker-header location (§2): the header row is found by matching marker
 * texts — never position, which the Deductor block's shape proves unstable —
 * and columns map by normalised header text (blank styled padding cells absorb
 * that; the reader ignores blanks).
 */
function locateWinman(sheet: GridSheet, sheetName: string, markers: string[]): WinCols {
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const cells = sheet.rows[i].cells;
    if (markers.every((m) => [...cells.values()].some((c) => c.value === m))) {
      const byHeader = new Map<string, number>();
      for (const [idx, c] of cells) {
        if (typeof c.value === "string" && !byHeader.has(normWin(c.value))) {
          byHeader.set(normWin(c.value), idx);
        }
      }
      return { byHeader, headerIdx: i };
    }
  }
  throw new Error(
    `template ${sheet.name} sheet missing or unreadable: no header row says ^<${markers.join("|")}>`,
  );
}

function rowAt(sheet: GridSheet, start: WinCols): GridRow[] {
  return sheet.rows.slice(start.headerIdx + 1);
}

/**
 * Parse a Winman `tds summary <company> <fy>.xlsx` export (its five-sheet
 * shape is §2 of the design). Sheets are located by name among **visible**
 * state only — the veryHidden `List` scratch sheet is skipped by state, so
 * even a hidden marker-header twin never misleads the reader. The Deductor
 * block's TAN is read and **immediately dropped**: it is never bound to a
 * variable the caller can see (Q7 choice B — TANs live in files, never in
 * strings). Challans come from the Deduction sheet's allocation joined to the
 * Challan sheet by `(id, quarter)` — ids restart each quarter, so that pair
 * is the unique key. Both sheets' section columns key only through §8.2
 * normalisation; the Challan sheet's bare `194I - Rent` is never a section
 * key. Errors cite the sheet and column, never a cell value.
 */
export function parseWinmanExport(buf: Buffer): WinmanFacts {
  const sheets = readWorkbook(buf);
  const visible = sheets.filter((s) => s.state === "visible");
  const byName = (name: string): GridSheet => {
    const s = visible.find((x) => normWin(x.name) === normWin(name));
    if (!s) {
      throw new Error(
        `template sheet missing: the Winman export must carry a ${name} sheet — this file has: ` +
          `${sheets.map((x) => x.name).join(", ")}`,
      );
    }
    return s;
  };

  // Deductor block: labels in one column, values the next. The TAN is read,
  // shape-validated and carried (the 2026-09-26 addendum's item 1: it used
  // to be parsed and dropped here). A blank or absent cell means absent; a
  // non-blank value that fails the TAN shape throws citing the sheet, row
  // and column — never the value (a stray operator cell can be a TAN).
  let tan: string | null = null;
  let deductorName: string | null = null;
  const deductor = visible.find((s) => normWin(s.name) === "deductor");
  if (deductor) {
    // Name: the `Name` label wins, `Name as per department records` is the
    // fallback (inbox 065). Free text — never shape-validated.
    const nameVal = (label: string): string | null => {
      for (const r of deductor.rows) {
        for (const [col, c] of [...r.cells.entries()].sort(([a], [b]) => a - b)) {
          if (typeof c.value === "string" && normWin(c.value) === label && r.cells.get(col + 1)) {
            const v = String(r.cells.get(col + 1)!.value ?? "").trim();
            if (v !== "") return v;
          }
        }
      }
      return null;
    };
    deductorName = nameVal("name") ?? nameVal("name as per department records");
    for (const r of deductor.rows) {
      for (const [col, c] of [...r.cells.entries()].sort(([a], [b]) => a - b)) {
        if (typeof c.value === "string" && normWin(c.value) === "tan" && r.cells.get(col + 1)) {
          const rawVal = r.cells.get(col + 1)!.value;
          if (typeof rawVal === "number") {
            throw new Error(
              `Winman ${deductor.name} sheet row ${r.row}, column ${colLetter(col + 1)}: cell is numeric — retype the TAN as text`,
            );
          }
          const rawStr = String(rawVal ?? "").trim();
          if (rawStr === "") continue; // blank means absent
          tan = tanOf(rawStr, `Winman ${deductor.name} sheet row ${r.row}, column ${colLetter(col + 1)}`);
          break;
        }
      }
      if (tan !== null) break;
    }
  }

  // formType from any data sheet's meta row (`Form : 26Q`).
  let formType: string | null = null;
  for (const name of ["Deductee", "Challan", "Deduction"]) {
    const s = byName(name);
    for (const r of s.rows) {
      for (const c of r.cells.values()) {
        const fm = typeof c.value === "string" ? /^form\s*:\s*(\S+)/i.exec(c.value.trim()) : null;
        if (fm) formType = fm[1];
      }
    }
  }

  // Deductor MAY be absent from a Winman file (it is block-shaped and only
  // carries the TAN we drop); the three data sheets are required.
  const deducteesSheet = byName("Deductee");
  const challanSheet = byName("Challan");
  const deductionSheet = byName("Deduction");

  // Challan sheet → (id, quarter) → deposit date. `ID No.` and Quarter are
  // numeric here; `Date of Challan` a serial. The hostile verification-blob
  // column (an HTML table echoing bank/challan/amount data) is never read.
  const challanCols = locateWinman(challanSheet, "Challan", ["ID No.", "Date of Challan"]);
  const interestCol = challanCols.byHeader.get("interest");
  const depositByJoin = new Map<string, { date: string; interest: number }>();
  for (const r of rowAt(challanSheet, challanCols)) {
    const idCell = r.cells.get(challanCols.byHeader.get("id no.")!);
    const dateCellRaw = r.cells.get(challanCols.byHeader.get("date of challan")!);
    const quarterCell = r.cells.get(challanCols.byHeader.get("quarter")!);
    if (!idCell || dateCellRaw === undefined) continue;
    const id = typeof idCell.value === "number" ? String(Math.trunc(idCell.value)) : String(idCell.value ?? "").trim();
    const quarter = typeof quarterCell?.value === "number" ? String(Math.trunc(quarterCell.value)) : String(quarterCell?.value ?? "").trim();
    const date = dateCellRaw.isDate && typeof dateCellRaw.value === "number" ? serialToYmd(dateCellRaw.value) : String(dateCellRaw.value ?? "");
    if (!id || !/^\d{8}$/.test(date)) continue;
    const rawInterest = interestCol === undefined ? undefined : r.cells.get(interestCol)?.value;
    const interest = typeof rawInterest === "number" && Number.isFinite(rawInterest) ? rawInterest : 0;
    depositByJoin.set(`${id}|${quarter}`, { date, interest });
  }

  // Deduction sheet → group by (§8.3-split section, deduction-date month),
  // each group's earliest deposit date. The same joined rows also yield the
  // per-deductee allocation (2026-09-26i).
  const deductionCols = locateWinman(deductionSheet, "Deduction", ["Deduction Date", "Section"]);
  const idCol = deductionCols.byHeader.get("challan id no. / details");
  const allocNameCol = deductionCols.byHeader.get("name");
  const allocTaxCol = deductionCols.byHeader.get("deducted and deposited - tax");
  const sectionCol = deductionCols.byHeader.get("section");
  const dateIdx = deductionCols.byHeader.get("deduction date");
  const paidDateCol = deductionCols.byHeader.get("paid / credited date");
  const quarterCol = deductionCols.byHeader.get("quarter");
  const earliest = new Map<string, { date: string; interest: number }>(); // `${section|YYYY-MM}` → challan
  const allocations: WinmanAllocation[] = [];
  let noSection = 0;
  let noJoin = 0;
  for (const r of rowAt(deductionSheet, deductionCols)) {
    const label = r.cells.get(sectionCol!)?.value;
    const section = winmanSectionKey(label);
    if (section === null) {
      // A row that cannot say its section is counted, never guessed — but a
      // wholly blank trailing row is not evidence of anything.
      const nonBlank = [...r.cells.values()].some((c) => c.value !== null && String(c.value).trim() !== "");
      if (nonBlank) noSection += 1;
      continue;
    }
    const idCell = r.cells.get(idCol!);
    const rawId = idCell?.value === undefined || idCell.value === null ? "" : String(idCell.value);
    const id = /^(\d+)/.exec(rawId)?.[1] ?? "";
    const dateCellRaw = r.cells.get(dateIdx!);
    const dedDate =
      dateCellRaw?.isDate && typeof dateCellRaw.value === "number"
        ? serialToYmd(dateCellRaw.value)
        : String(dateCellRaw?.value ?? "");
    const paidCellRaw = paidDateCol === undefined ? undefined : r.cells.get(paidDateCol);
    const paidDate =
      paidCellRaw?.isDate && typeof paidCellRaw.value === "number"
        ? serialToYmd(paidCellRaw.value)
        : String(paidCellRaw?.value ?? "");
    const quarter = `${Math.trunc(Number(r.cells.get(quarterCol!)?.value ?? 0))}`;
    const deposit = depositByJoin.get(`${id}|${quarter}`);
    const forMonth = /^\d{8}$/.test(dedDate) ? dedDate.slice(0, 6) : "";
    if (!/^\d{8}$/.test(dedDate) || deposit === undefined) {
      noJoin += 1;
      continue;
    }
    const key = `${section}|${forMonth}`;
    const prev = earliest.get(key);
    // Earliest deposit wins the aggregate challan; its interest is carried with
    // it so a late deposit's s.201(1A) interest can be reported (2026-09-26p).
    if (prev === undefined || deposit.date < prev.date) earliest.set(key, deposit);
    // The challan-to-deductee link: a row with a readable name and tax joins
    // the engine's deductions; a row without either still counts for the
    // challan above but carries no allocation.
    const allocName = r.cells.get(allocNameCol!)?.value;
    const allocTax = r.cells.get(allocTaxCol!)?.value;
    if (
      typeof allocName === "string" && allocName.trim() !== "" &&
      typeof allocTax === "number" && Number.isFinite(allocTax) && allocTax >= 0
    ) {
      allocations.push({ name: allocName.trim(), section, tax: allocTax, dedDate, paidDate, depositDate: deposit.date, interestPaid: deposit.interest, challanId: id });
    }
  }
  const challans: OperatorChallan[] = [...earliest.entries()]
    .map(([key, entry]) => {
      const [section, forMonth] = key.split("|");
      return { section, forMonth: `${forMonth.slice(0, 4)}-${forMonth.slice(4, 6)}`, depositDate: entry.date };
    })
    .sort((a, b) => (a.section === b.section ? a.forMonth.localeCompare(b.forMonth) : a.section.localeCompare(b.section)));

  // Deductee sheet rows, spaces compacted. The blank padding header cells
  // reveal nothing (they are never bound); a row with no PAN still yields the
  // name — the join declares it, the code never guesses it.
  const dedCols = locateWinman(deducteesSheet, "Deductee", ["Name", "PAN"]);
  const nameCol = dedCols.byHeader.get("name");
  const panCol = dedCols.byHeader.get("pan");
  const deductees: WinmanFacts["deductees"] = [];
  for (const r of rowAt(deducteesSheet, dedCols)) {
    const name = r.cells.get(nameCol!)?.value;
    if (typeof name !== "string" || name.trim() === "") continue;
    const panRaw = r.cells.get(panCol!)?.value ?? null;
    const pan = typeof panRaw === "string" ? panRaw.replace(/\s+/g, "").toUpperCase() : null;
    deductees.push({ name: name.trim(), pan });
  }

  return { challans, allocations, deductees, formType, tan, deductorName, skipped: { noSection, noJoin } };
}
