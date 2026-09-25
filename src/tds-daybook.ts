import type { LedgerVoucherRow, VoucherRow } from "./downstream.js";
import { canonicalKey } from "./key.js";
import type { TdsLedgerRows } from "./tds.js";

const ZERO = 0.005;

export function counterpartyOf(v: VoucherRow, index: number): string {
  const self = v.entries[index];
  if (!self) return "";
  let bestLedger = "";
  let bestAmount = 0;
  v.entries.forEach((e, i) => {
    if (i === index) return;
    if (Math.abs(e.amount) <= ZERO) return;
    if (Math.sign(e.amount) === Math.sign(self.amount)) return;
    if (Math.abs(e.amount) > Math.abs(bestAmount)) {
      bestLedger = e.ledger;
      bestAmount = e.amount;
    }
  });
  return bestLedger || v.partyLedgerName;
}

export function projectLedgerRows(
  vouchers: VoucherRow[],
  ledgers: string[],
): TdsLedgerRows[] {
  const byLedger = new Map<string, LedgerVoucherRow[]>();
  for (const l of ledgers) byLedger.set(canonicalKey(l), []);
  for (const v of vouchers) {
    if (v.cancelled) continue;
    v.entries.forEach((entry, i) => {
      const rows = byLedger.get(canonicalKey(entry.ledger));
      if (!rows) return;
      rows.push({
        date: String(v.date ?? ""),
        voucherType: String(v.voucherType ?? ""),
        voucherNumber: String(v.voucherNumber ?? ""),
        reference: "",
        counterparty: counterpartyOf(v, i),
        amount: entry.amount,
        matchStatus: "unknown",
        tax: null,
      });
    });
  }
  return ledgers.map((l) => ({
    ledger: l,
    rows: byLedger.get(canonicalKey(l)) ?? [],
  }));
}

import { readFile, stat } from "node:fs/promises";
import { parseVoucherRows } from "./downstream.js";
import { displayDate } from "./format.js";

const truthy = (v: unknown): boolean =>
  v === true || /^(yes|true|1)$/i.test(String(v ?? "").trim());

/**
 * Additive bundle ledger pair (2026-09-26): the base {name, parent} pair that
 * every consumer already handled, optionally enriched by the exporter with
 * identity fields and the opening balance. `openingBalance` follows the
 * gateway boundary convention — positive = debit — for the RUN's period, so
 * a loan-liability credit opening arrives negative; consumers resolve the
 * sign for their own side once, at their seam.
 */
export interface DayBookLedgerPair {
  name: string;
  parent: string;
  pan?: string | null;
  gstin?: string | null;
  address?: string | null;
  openingBalance?: number | null;
}

export interface DayBookInput {
  shape: "array" | "envelope" | "bundle" | "tallymessage";
  vouchers: VoucherRow[];
  /** Declared by a bundle; null for the shapes that cannot say. */
  company: string | null;
  groups: { name: string; parent: string }[] | null;
  ledgers: DayBookLedgerPair[] | null;
  /** YYYYMMDD, from the vouchers themselves. */
  observedFrom: string;
  observedTo: string;
  /** Array entries that did not become a voucher. Counted, never guessed at. */
  rejected: number;
  /** "YYYY-MM" keys inside the review period with no voucher at all. */
  emptyMonths: string[];
}

const monthKey = (yyyymmdd: string): string =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}`;

/**
 * Tally's own day-book export carries its lines across three containers:
 * `allledgerentries` and `ledgerentries` (one OR the other per voucher) hold
 * the accounting lines, but on item invoices the expense lines live only in
 * `allinventoryentries[].accountingallocations[]` — reading the ledger lists
 * alone drops the debit on most purchases, exactly the rows the TDS booking
 * rule needs. Amounts are strings on raw Tally sign (negative = debit); the
 * flip happens in parseVoucherRows, once, as at the gateway. The
 * isdeemedpositive flag is NOT trusted: entries exist on which it disagrees
 * with the amount's sign, and the sign is authoritative.
 */
function normalizeTallyRow(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  const row = v as Record<string, unknown>;
  const sweep = (list: unknown): unknown[] =>
    Array.isArray(list) ? list : typeof list === "object" && list !== null ? [list] : [];
  return {
    date: row.date,
    voucherType: row.vouchertypename,
    voucherNumber: row.vouchernumber,
    narration: row.narration,
    partyLedgerName: row.partyledgername,
    isCancelled: truthy(row.iscancelled) || truthy(row.isdeleted),
    entries: [
      ...sweep(row.allledgerentries),
      ...sweep(row.ledgerentries),
      ...sweep(row.allinventoryentries).flatMap((item) =>
        sweep((item as Record<string, unknown>)?.accountingallocations),
      ),
    ]
      .filter((e) => e && typeof e === "object")
      .map((e) => {
        const er = e as Record<string, unknown>;
        return { LEDGERNAME: er.ledgername, AMOUNT: er.amount };
      }),
  };
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4, 6));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(4, 6));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Read an operator day-book export. Every refusal here happens before any
 * downstream call, so a bad file costs nothing and leaves no partial artifact.
 * No message ever quotes a value out of the file: positions, counts and month
 * labels only.
 */
export function readDayBook(
  text: string,
  opts: { company?: string; fromDate: string; toDate: string },
): DayBookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "the day-book file is not valid JSON — it is most likely truncated or was copied while Tally was still writing it; re-export it and try again",
    );
  }

  let shape: DayBookInput["shape"];
  let rawRows: unknown[];
  let envelope: Record<string, unknown> = {};
  if (Array.isArray(parsed)) {
    shape = "array";
    rawRows = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).tallymessage)
  ) {
    envelope = parsed as Record<string, unknown>;
    shape = "tallymessage";
    const raw = envelope.tallymessage as unknown[];
    rawRows = raw.map(normalizeTallyRow);
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).vouchers)
  ) {
    envelope = parsed as Record<string, unknown>;
    shape =
      envelope.tallyAgentExport !== undefined || envelope.company !== undefined
        ? "bundle"
        : "envelope";
    rawRows = envelope.vouchers as unknown[];
  } else {
    throw new Error(
      "the day-book file must be a JSON array of vouchers, an object with a `vouchers` array, a tallymessage export, or a tally-agent export bundle",
    );
  }

  const company =
    typeof envelope.company === "string" && envelope.company.trim()
      ? envelope.company.trim()
      : null;
  if (company && opts.company && canonicalKey(company) !== canonicalKey(opts.company)) {
    throw new Error(
      "the day-book file was exported from a different company than the one under review; re-export it from the company under review",
    );
  }

  const vouchers = parseVoucherRows(rawRows, null, null);
  const rejected = rawRows.length - vouchers.length;

  const dates = vouchers
    .map((v) => String(v.date))
    .filter((d) => /^\d{8}$/.test(d))
    .sort();
  const observedFrom = dates[0] ?? "";
  const observedTo = dates[dates.length - 1] ?? "";

  const declaredFrom = typeof envelope.fromDate === "string" ? envelope.fromDate : null;
  const declaredTo = typeof envelope.toDate === "string" ? envelope.toDate : null;
  if (declaredFrom && declaredTo) {
    if (declaredFrom > opts.fromDate || declaredTo < opts.toDate) {
      throw new Error(
        `the day-book file declares a period that does not cover the review period ${displayDate(opts.fromDate)} to ${displayDate(opts.toDate)}; export the whole period or narrow the review`,
      );
    }
    if (observedFrom && (observedFrom < declaredFrom || observedTo > declaredTo)) {
      throw new Error(
        "the day-book file misdescribes itself: it holds vouchers outside the period it declares; re-export it",
      );
    }
  }

  const present = new Set(dates.map(monthKey));
  const wanted = monthsBetween(opts.fromDate, opts.toDate);
  const emptyMonths = wanted.filter((m) => !present.has(m));
  if (emptyMonths.length === wanted.length) {
    throw new Error(
      `the day-book file holds no voucher in any month of ${displayDate(opts.fromDate)} to ${displayDate(opts.toDate)}; it is for a different period`,
    );
  }

  const masters = (
    key: "groups" | "ledgers",
  ): DayBookLedgerPair[] | null => {
    const v = envelope[key];
    if (!Array.isArray(v)) return null;
    return v
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        name: String(x.name ?? ""),
        parent: String(x.parent ?? ""),
        // Additive (2026-09-26): identity fields ride only when present, so
        // older bundles parse identically.
        ...(key === "ledgers"
          ? {
              pan: normTaxId(x.pan),
              gstin: normTaxId(x.gstin),
              address:
                typeof x.address === "string" && x.address.trim() !== ""
                  ? x.address.trim()
                  : null,
              openingBalance:
                typeof x.openingBalance === "number" && Number.isFinite(x.openingBalance)
                  ? x.openingBalance
                  : null,
            }
          : {}),
      }))
      .filter((x) => x.name !== "");
  };

  return {
    shape,
    vouchers,
    company,
    groups: masters("groups"),
    ledgers: masters("ledgers"),
    observedFrom,
    observedTo,
    rejected,
    emptyMonths,
  };
}

/**
 * The ledger master names a day-book bundle declares, without the period
 * validation `readDayBook` applies: the 26AS mapping template only needs the
 * ledger list, not the vouchers or an accounting period. A non-bundle day book
 * (a bare array or a `vouchers` envelope) carries no masters and yields [].
 */
export function readDayBookLedgerNames(text: string, company?: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const env = parsed as Record<string, unknown>;
  const declared = typeof env.company === "string" ? env.company.trim() : "";
  if (declared && company && canonicalKey(declared) !== canonicalKey(company)) {
    throw new Error(
      "the day-book file was exported from a different company than the one under review; re-export it from the company under review",
    );
  }
  if (!Array.isArray(env.ledgers)) return [];
  return env.ledgers
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => String(x.name ?? "").trim())
    .filter((n) => n !== "");
}

/**
 * Addendum 2 (2026-09-26): the ledger-master pairs (+ groups) a bundle
 * declares, without the period validation `readDayBook` applies — the loans
 * template generator needs groups + parents to compute the Exempt pre-fill.
 * Mirrors readDayBookLedgerNames' envelope checks; not a bundle ⇒ nulls.
 */
/** 4d (2026-09-26): PAN/GSTIN arrive from Tally with un-decoded XML escapes
 * ("AMCPK6481D&#13;&#10;" in a real export); strip literal entity runs and
 * control characters, then trim/uppercase — or PAN_SHAPE rejects the value
 * and the party's PAN cell renders blank. */
export function normTaxId(v: unknown): string | null {
  const s =
    typeof v === "string"
      ? v
          .replace(/&#(?:\d+|x[0-9a-fA-F]+);/g, "")
          .replace(/[\u0000-\u001F\u007F]/g, "")
          .trim()
          .toUpperCase()
      : "";
  return s !== "" ? s : null;
}

export function readDayBookMasterPairs(
  text: string,
  company?: string,
): { ledgers: DayBookLedgerPair[]; groups: { name: string; parent: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ledgers: [], groups: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ledgers: [], groups: [] };
  }
  const env = parsed as Record<string, unknown>;
  const declared = typeof env.company === "string" ? env.company.trim() : "";
  if (declared && company && canonicalKey(declared) !== canonicalKey(company)) {
    throw new Error(
      "the day-book file was exported from a different company than the one under review; re-export it from the company under review",
    );
  }
  const pairs = (key: "ledgers" | "groups") => {
    if (!Array.isArray(env[key])) return [];
    return (env[key] as unknown[])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        name: String(x.name ?? "").trim(),
        parent: String(x.parent ?? "").trim(),
        ...(key === "ledgers"
          ? {
              pan: normTaxId(x.pan),
              gstin: normTaxId(x.gstin),
              address:
                typeof x.address === "string" && x.address.trim() !== ""
                  ? x.address.trim()
                  : null,
              openingBalance:
                typeof x.openingBalance === "number" && Number.isFinite(x.openingBalance)
                  ? x.openingBalance
                  : null,
            }
          : {}),
      }))
      .filter((x) => x.name !== "");
  };
  return { ledgers: pairs("ledgers") as DayBookLedgerPair[], groups: pairs("groups") };
}

/** Read the file, refusing anything over the configured ceiling before it is read into memory.
 *  A real Tally export can arrive UTF-16 LE with a BOM; decode by what the bytes say. */
export async function loadDayBookText(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  if (info.size > maxBytes) {
    throw new Error(
      `the day-book file is too large for this gateway (limit ${Math.round(maxBytes / (1024 * 1024))} MB); export it one quarter at a time, or raise TALLY_AGENT_DAYBOOK_MAX_MB`,
    );
  }
  const buf = await readFile(path);
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  }
  return buf.toString("utf8");
}
