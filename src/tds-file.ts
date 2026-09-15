import { parseVoucherRows, type VoucherRow } from "./downstream.js";
import { TDS_SECTIONS } from "./tds-law.js";

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
}

export interface OperatorParty {
  ledger: string;
  section: string;
  /** 194C(6): suppresses the party's contract-payment TDS liability (review-only). */
  transporterDeclaration: boolean;
  /** The s.201(1) proviso fact: shields interest (i), never book-derived. */
  deducteeFiledReturn: boolean;
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
}

export interface OperatorFile {
  sections: OperatorSectionMap[];
  parties: OperatorParty[];
  certificates: OperatorCertificate[];
  challans: OperatorChallan[];
  statements: OperatorStatement[];
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
    return {
      ledger: str(r.ledger, `sections row ${i + 1}`),
      section: sectionOf(r.section, `sections row ${i + 1}`),
    };
  });

  const parties: OperatorParty[] = list(d, "parties").map((raw, i) => {
    const at = `parties row ${i + 1}`;
    const r = obj(raw, at);
    return {
      ledger: str(r.ledger, at),
      section: sectionOf(r.section, at),
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
    };
  });

  return { sections, parties, certificates, challans, statements };
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
};
