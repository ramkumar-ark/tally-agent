/**
 * The depreciation operator file: facts the books cannot supply — opening
 * written-down value per block, rate overrides, asset classification,
 * credit classifications, cost adjustments and the additional-depreciation
 * carry-forward. Its contents never transit the model — only its path does
 * (the M2 returnsPath pattern).
 *
 * Two rules are non-negotiable and are why this file exists separately from
 * the engine: malformed input is rejected wholesale (no partial processing,
 * so a half-read file can never produce a confident-looking review) and
 * errors cite the row index and never echo a value (a ledger name or amount
 * in an error message crosses the masking boundary).
 */
export type CreditKind =
  | "sale" | "discount" | "writeoff" | "transfer" | "depreciation";
const CREDIT_KINDS: readonly CreditKind[] = [
  "sale", "discount", "writeoff", "transfer", "depreciation",
];
const SCHEMA = "tally-agent-depreciation.v1";

export interface OpeningWdvRow { block: string; rate: number; amount: number; }
export interface RateOverrideRow { ledger: string; rate: number; reason: string; }
export interface AssetClassRow {
  ledger: string; class: string; newAsset: boolean; additionalDepreciation: boolean;
}
export interface CreditClassRow {
  ledger: string; date: string; amount: number; kind: CreditKind; block: string | null;
}
export interface CostAdjustmentRow { ledger: string; date: string; amount: number; reason: string; }
export interface CarryForwardRow { block: string; amount: number; }

export interface DepOperatorFile {
  openingWdv: OpeningWdvRow[];
  rateOverrides: RateOverrideRow[];
  assetClass: AssetClassRow[];
  creditClassifications: CreditClassRow[];
  costAdjustments: CostAdjustmentRow[];
  additionalDepreciationCarryForward: CarryForwardRow[];
}

export const EMPTY_DEP_OPERATOR: DepOperatorFile = {
  openingWdv: [], rateOverrides: [], assetClass: [],
  creditClassifications: [], costAdjustments: [], additionalDepreciationCarryForward: [],
};

const text = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

/** ISO dash (2025-06-30), slash or bare YYYYMMDD all normalize to YYYYMMDD. */
const normDate = (v: unknown): string => String(v ?? "").replace(/[-/.\s]/g, "");

const truthy = (v: unknown): boolean =>
  v === true || /^(yes|true|1)$/i.test(String(v ?? "").trim());

function obj(raw: unknown, at: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${at}: expected an object`);
  }
  return raw as Record<string, unknown>;
}

function list(doc: Record<string, unknown>, key: string): unknown[] {
  const v = doc[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`"${key}" must be an array`);
  return v;
}

/** Every field but the offending one: the value is never echoed. */
function field(r: Record<string, unknown>, key: string, at: string): unknown {
  const v = r[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`${at}: ${key} is missing or blank`);
  }
  return v;
}

const at = (key: string, i: number): string => `${key}[${i}]`;

/** rate/amount: finite numbers, strictly — a coerced it is not (no silent 0). */
function finiteNum(r: Record<string, unknown>, key: string, atStr: string): number {
  const v = field(r, key, atStr);
  const n = typeof v === "number" ? v : Number(text(v));
  if (!Number.isFinite(n)) throw new Error(`${atStr}: ${key} is not a finite number`);
  return n;
}

function nonEmptyStr(r: Record<string, unknown>, key: string, atStr: string): string {
  const s = text(field(r, key, atStr));
  if (!s) throw new Error(`${atStr}: ${key} is missing or blank`);
  return s;
}

function eightDigitDate(r: Record<string, unknown>, key: string, atStr: string): string {
  const d = normDate(field(r, key, atStr));
  if (!/^\d{8}$/.test(d)) throw new Error(`${atStr}: ${key} is not a YYYYMMDD date`);
  return d;
}

export function parseDepOperatorFile(
  raw: string, fromDate: string, toDate: string,
): DepOperatorFile {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error("depreciation operator file is not valid JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error('depreciation operator file must be an object with "schema"/"financialYear" and stanza arrays');
  }
  const d = doc as Record<string, unknown>;

  if (d.schema !== SCHEMA) {
    throw new Error("depreciation operator file: schema is not tally-agent-depreciation.v1");
  }

  const fy = obj(d.financialYear, "financialYear");
  const fyFrom = normDate(field(fy, "from", "financialYear"));
  const fyTo = normDate(field(fy, "to", "financialYear"));
  if (fyFrom !== fromDate || fyTo !== toDate) {
    throw new Error("financialYear does not match the review period");
  }

  const openingWdv: OpeningWdvRow[] = list(d, "openingWdv").map((rawRow, i) => {
    const key = "openingWdv";
    const r = obj(rawRow, at(key, i));
    return {
      block: nonEmptyStr(r, "block", at(key, i)),
      rate: finiteNum(r, "rate", at(key, i)),
      amount: finiteNum(r, "amount", at(key, i)),
    };
  });

  const rateOverrides: RateOverrideRow[] = list(d, "rateOverrides").map((rawRow, i) => {
    const key = "rateOverrides";
    const r = obj(rawRow, at(key, i));
    return {
      ledger: nonEmptyStr(r, "ledger", at(key, i)),
      rate: finiteNum(r, "rate", at(key, i)),
      reason: nonEmptyStr(r, "reason", at(key, i)),
    };
  });

  const assetClass: AssetClassRow[] = list(d, "assetClass").map((rawRow, i) => {
    const key = "assetClass";
    const r = obj(rawRow, at(key, i));
    return {
      ledger: nonEmptyStr(r, "ledger", at(key, i)),
      class: nonEmptyStr(r, "class", at(key, i)),
      newAsset: truthy(r.newAsset),
      additionalDepreciation: truthy(r.additionalDepreciation),
    };
  });

  const creditClassifications: CreditClassRow[] = list(d, "creditClassifications").map((rawRow, i) => {
    const key = "creditClassifications";
    const r = obj(rawRow, at(key, i));
    const kind = text(field(r, "kind", at(key, i)));
    if (!CREDIT_KINDS.includes(kind as CreditKind)) {
      throw new Error(`${at(key, i)}: kind is not one of sale|discount|writeoff|transfer|depreciation`);
    }
    return {
      ledger: nonEmptyStr(r, "ledger", at(key, i)),
      date: eightDigitDate(r, "date", at(key, i)),
      amount: finiteNum(r, "amount", at(key, i)),
      kind: kind as CreditKind,
      block: r.block === undefined ? null : nonEmptyStr(r, "block", at(key, i)),
    };
  });

  const costAdjustments: CostAdjustmentRow[] = list(d, "costAdjustments").map((rawRow, i) => {
    const key = "costAdjustments";
    const r = obj(rawRow, at(key, i));
    return {
      ledger: nonEmptyStr(r, "ledger", at(key, i)),
      date: eightDigitDate(r, "date", at(key, i)),
      amount: finiteNum(r, "amount", at(key, i)),
      reason: nonEmptyStr(r, "reason", at(key, i)),
    };
  });

  const additionalDepreciationCarryForward: CarryForwardRow[] =
    list(d, "additionalDepreciationCarryForward").map((rawRow, i) => {
      const key = "additionalDepreciationCarryForward";
      const r = obj(rawRow, at(key, i));
      return {
        block: nonEmptyStr(r, "block", at(key, i)),
        amount: finiteNum(r, "amount", at(key, i)),
      };
    });

  return {
    openingWdv, rateOverrides, assetClass, creditClassifications,
    costAdjustments, additionalDepreciationCarryForward,
  };
}
