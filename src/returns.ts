import type { GstKind } from "./types.js";

/**
 * One row of the operator-prepared returns file, normalized. `gstin` is
 * trimmed and uppercased so the join in gst.ts is exact regardless of how the
 * file was typed. The amounts are numbers (R-MCP-5): a string figure from a
 * spreadsheet export parses the same as a JSON number.
 */
export interface ReturnRow {
  gstin: string;
  partyName: string;
  kind: GstKind;
  taxableValue: number;
  cgst: number;
  /** SGST and UTGST are merged, as GSTR-3B reports them. */
  sgst: number;
  igst: number;
  cess: number;
}

/** The 15-char GSTIN shape; see src/mask.ts for the redaction twin. */
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}$/;

const num = (v: unknown): number => {
  const n = Number(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse and validate the returns file the gateway reads directly from disk —
 * its contents never transit the model, only its path does (design doc §2.1).
 *
 * Validation errors cite the row index and never echo the offending value: an
 * error message is an outbound string, and a malformed GSTIN is still a tax id
 * (R-P-9). A malformed file is rejected wholesale — no partial processing, so
 * a half-read file can never produce a confident-looking mismatch report.
 *
 * Rows sharing a (gstin, kind) are merged by summation: a portal export that
 * lists the same supplier once per invoice collapses to one comparable total.
 */
export function parseReturns(text: string): ReturnRow[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("returns file is not valid JSON");
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error('returns file must be an object with a "returns" array');
  }
  const rows = (doc as { returns?: unknown }).returns;
  if (!Array.isArray(rows)) {
    throw new Error('returns file must contain a "returns" array');
  }

  const merged = new Map<string, ReturnRow>();
  rows.forEach((raw, i) => {
    const at = `row ${i + 1}`;
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`returns file ${at}: expected an object`);
    }
    const r = raw as Record<string, unknown>;

    const gstin = String(r.gstin ?? "").trim().toUpperCase();
    if (!GSTIN_SHAPE.test(gstin)) {
      // Never echo the value: a malformed GSTIN is still a tax id.
      throw new Error(`returns file ${at}: gstin is missing or not a valid 15-char GSTIN`);
    }

    const kindRaw = String(r.kind ?? "").trim().toLowerCase();
    if (kindRaw !== "outward" && kindRaw !== "inward") {
      throw new Error(`returns file ${at}: kind must be "outward" or "inward"`);
    }
    const kind: GstKind = kindRaw;

    const row: ReturnRow = {
      gstin,
      partyName: String(r.partyName ?? "").trim(),
      kind,
      taxableValue: num(r.taxableValue),
      cgst: num(r.cgst),
      sgst: num(r.sgst ?? r.utgst),
      igst: num(r.igst),
      cess: num(r.cess),
    };

    const key = `${gstin}|${kind}`;
    const prev = merged.get(key);
    if (prev) {
      prev.taxableValue += row.taxableValue;
      prev.cgst += row.cgst;
      prev.sgst += row.sgst;
      prev.igst += row.igst;
      prev.cess += row.cess;
      // Keep a party name if the first row lacked one.
      if (!prev.partyName && row.partyName) prev.partyName = row.partyName;
    } else {
      merged.set(key, row);
    }
  });

  return [...merged.values()];
}
