import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GatewayConfig } from "./config.js";
import type { GroupNode, LedgerMaster, TbRow } from "./types.js";

export type RawCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * The narrow slice of the MCP SDK client `makeRawCaller` needs. Narrowing it
 * lets a test assert what request options reach `callTool` without spawning
 * the downstream child or speaking to Tally.
 */
export interface ToolCallClient {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema: unknown,
    options: { timeout?: number } | undefined,
  ): Promise<unknown>;
}

/** One ledger line of a voucher. Amount is positive = debit (flipped once, here). */
export interface VoucherEntry {
  ledger: string;
  amount: number;
}

export interface VoucherRow {
  /** YYYYMMDD */
  date: string;
  voucherType: string;
  voucherNumber: string;
  partyLedgerName: string;
  cancelled: boolean;
  /** Narration text when the source voucher carries it (live + day-book). Empty when absent. */
  narration?: string;
  entries: VoucherEntry[];
}

/** Ledger-master scalars needed for tax work. No address/bank/email/phone — the tally_get_ledger ban (R-MCP-3) stands. */
export interface LedgerTaxInfo {
  name: string;
  parent: string;
  /** Normalized (trimmed, uppercased) or null when the master carries none. */
  gstin: string | null;
  state: string;
  /** Verbose IncomeTaxNumber (PAN), trimmed/uppercased; null when absent (pre-P1 upstream). */
  pan: string | null;
  isTdsApplicable: boolean;
  tdsDeducteeType: string;
  /** TDSRateName or TaxType, whichever the verbose shape carries. */
  natureOfPayment: string | null;
}

/** How the downstream joined a ledger-report row to its voucher; "unknown" when the field is absent. */
export type MatchStatus = "matched" | "ambiguous" | "unmatched" | "unknown";

/** The scalar part of a row's GST taxBreakup; tax ledger names are deliberately not carried. */
export interface LedgerVoucherTax {
  /** totalTax / taxableAmount * 100, or null when the downstream could not compute it. */
  effectiveRatePct: number | null;
  /** "matched" | "no-tax-rows" | "ambiguous-shared" | "inconsistent" as the downstream reports it. */
  taxStatus: string;
}

/** One typed row of tally_get_ledger_vouchers for the queried ledger. */
export interface LedgerVoucherRow {
  /** YYYYMMDD */
  date: string;
  voucherType: string;
  voucherNumber: string;
  reference: string;
  /** The other side of the entry (counterLedgerName). Real name: masked by the session. */
  counterparty: string;
  /** Signed for the queried ledger: positive = debit (R-MCP-5). */
  amount: number;
  matchStatus: MatchStatus;
  tax: LedgerVoucherTax | null;
}

export interface LedgerVoucherFetch {
  rows: LedgerVoucherRow[];
  /** Rows dropped at the boundary: undated, out of range, or with no readable side. */
  dropped: number;
}

export interface Downstream {
  callRaw(tool: string, args: Record<string, unknown>): Promise<string>;
  listCompanies(): Promise<string[]>;
  trialBalance(
    company: string | undefined,
    asOnDate: string,
  ): Promise<{ rows: TbRow[]; totalDebit: number; totalCredit: number }>;
  groups(company?: string): Promise<GroupNode[]>;
  ledgers(company?: string): Promise<LedgerMaster[]>;
  /** Verbose ledger masters: adds gstin/state scalars (never the banned per-ledger master tool). */
  ledgersTax(company?: string): Promise<LedgerTaxInfo[]>;
  ledgerVouchers(
    company: string | undefined,
    ledgerName: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]>;
  /** The same ledger report, typed for scrutiny: signed amounts, range re-filtered. */
  ledgerVoucherRows(
    company: string | undefined,
    ledgerName: string,
    fromDate: string,
    toDate: string,
  ): Promise<LedgerVoucherFetch>;
  /** Day Book with ledger lines for a period, typed and range-filtered at the boundary (R-MCP-5). */
  vouchers(
    company: string | undefined,
    fromDate: string,
    toDate: string,
  ): Promise<VoucherRow[]>;
  close(): Promise<void>;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const normDate = (v: unknown): string => String(v ?? "").replace(/[-/.\s]/g, "");

const truthy = (v: unknown): boolean =>
  v === true || /^(yes|true|1)$/i.test(String(v ?? "").trim());

/** A scalar text field; an object (Tally's rich-text narration/reference) reads as empty, never "[object Object]". */
const text = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

/**
 * +1 debit, -1 credit, 0 unreadable. The live server sends matchedSide
 * "debit"/"credit" (older recordings: "Dr"/"Cr") plus raw debit/credit
 * column strings, which are the fallback when the side is absent.
 */
const sideSign = (r: Record<string, unknown>): 1 | -1 | 0 => {
  const side = String(r.matchedSide ?? "").trim().toLowerCase();
  if (side.startsWith("d")) return 1;
  if (side.startsWith("c")) return -1;
  if (Math.abs(num(r.debit)) > 0) return 1;
  if (Math.abs(num(r.credit)) > 0) return -1;
  return 0;
};

const matchStatusOf = (v: unknown): MatchStatus => {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "matched" || s === "ambiguous" || s === "unmatched" ? s : "unknown";
};

const taxOf = (v: unknown): LedgerVoucherTax | null => {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  const pct = String(t.effectiveRatePct ?? "").trim();
  const n = Number(pct);
  return {
    effectiveRatePct: pct !== "" && Number.isFinite(n) ? n : null,
    taxStatus: text(t.taxStatus),
  };
};

const withCompany = (
  args: Record<string, unknown>,
  company: string | undefined,
): Record<string, unknown> => (company ? { ...args, company } : args);

/**
 * Parse a Day Book envelope into typed rows. A date range, when given,
 * re-filters at the boundary: the downstream already filters client-side,
 * but a tax period that silently absorbs an out-of-period voucher is worse
 * than one that drops a row with a malformed date. Raw Tally ledger lines
 * carry UPPERCASE keys; the flip to positive = debit happens here, once
 * (R-MCP-5), matching the trial-balance convention.
 */
export function parseVoucherRows(
  raw: unknown,
  from: string | null,
  to: string | null,
): VoucherRow[] {
  const out: VoucherRow[] = [];
  if (!Array.isArray(raw)) return out;
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const row = v as Record<string, unknown>;
    const date = normDate(row.date);
    if (!/^\d{8}$/.test(date) || (from && date < from) || (to && date > to)) continue;
    const rawEntries = row.entries;
    const list = Array.isArray(rawEntries)
      ? rawEntries
      : rawEntries && typeof rawEntries === "object"
        ? [rawEntries]
        : [];
    const entries: VoucherEntry[] = [];
    for (const e of list) {
      if (typeof e !== "object" || e === null) continue;
      const er = e as Record<string, unknown>;
      const ledger = String(er.LEDGERNAME ?? er.ledgerName ?? "").trim();
      if (!ledger) continue;
      entries.push({ ledger, amount: -num(er.AMOUNT ?? er.amount) });
    }
    out.push({
      date,
      voucherType: String(row.voucherType ?? ""),
      voucherNumber: String(row.voucherNumber ?? ""),
      partyLedgerName: String(row.partyLedgerName ?? "").trim(),
      cancelled: truthy(row.isCancelled),
      ...(text(row.narration) ? { narration: text(row.narration) } : {}),
      entries,
    });
  }
  return out;
}

export function makeDownstream(call: RawCaller, close: () => Promise<void>): Downstream {
  const ledgerVoucherEnvelope = async (
    company: string | undefined,
    ledgerName: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]> => {
    const body = await call(
      "tally_get_ledger_vouchers",
      withCompany({ ledgerName, fromDate, toDate }, company),
    );
    // The downstream server wraps rows in a report envelope
    // ({ source, company, ledgerName, ..., vouchers: [...] }), not a bare
    // array as originally assumed — see the downstream's src/tools/reads.ts.
    const parsed = JSON.parse(body) as { vouchers?: unknown[] };
    return Array.isArray(parsed.vouchers) ? parsed.vouchers : [];
  };

  return {
    callRaw: call,

    async listCompanies() {
      const raw = JSON.parse(await call("tally_list_companies", {})) as Array<{
        name?: string;
      }>;
      return raw.map((c) => String(c.name ?? "")).filter(Boolean);
    },

    async trialBalance(company, asOnDate) {
      const raw = JSON.parse(
        await call("tally_trial_balance", withCompany({ asOnDate }, company)),
      ) as {
        totalDebit: string;
        totalCredit: string;
        rows: Array<{ name: string; parent: string; balance: string }>;
      };
      return {
        totalDebit: num(raw.totalDebit),
        totalCredit: num(raw.totalCredit),
        rows: raw.rows.map((r) => ({
          name: String(r.name ?? ""),
          parent: String(r.parent ?? ""),
          balance: num(r.balance),
        })),
      };
    },

    async groups(company) {
      const raw = JSON.parse(
        await call("tally_get_groups", withCompany({}, company)),
      ) as Array<{ name: string; parent?: string }>;
      return raw.map((g) => ({
        name: String(g.name ?? ""),
        parent: String(g.parent ?? ""),
      }));
    },

    async ledgers(company) {
      const raw = JSON.parse(
        await call("tally_get_ledgers", withCompany({}, company)),
      ) as Array<{
        name: string;
        parent?: string;
        openingBalance?: string;
        closingBalance?: string;
      }>;
      // Tally's ledger master balances are raw Tally sign (negative = debit).
      // Flip once here so everything downstream sees the gateway convention,
      // positive = debit (R-MCP-5), exactly like tally_trial_balance.
      // The trailing "|| 0" normalizes a flipped zero back to plain 0, not -0.
      return raw.map((l) => ({
        name: String(l.name ?? ""),
        parent: String(l.parent ?? ""),
        openingBalance: -num(l.openingBalance) || 0,
        closingBalance: -num(l.closingBalance) || 0,
      }));
    },

    async ledgersTax(company) {
      const raw = JSON.parse(
        await call("tally_get_ledgers", withCompany({ verbose: true }, company)),
      ) as Array<Record<string, unknown>>;
      const out: LedgerTaxInfo[] = [];
      for (const l of Array.isArray(raw) ? raw : []) {
        const name = String(l?.name ?? "");
        if (!name) continue;
        const gstin = String(l.gstin ?? "").trim().toUpperCase();
        const pan = String(l.IncomeTaxNumber ?? "").trim().toUpperCase();
        const nature = text(l.TDSRateName) || text(l.TaxType) || null;
        out.push({
          name,
          parent: String(l.parent ?? ""),
          gstin: gstin || null,
          state: String(l.state ?? ""),
          pan: pan || null,
          isTdsApplicable: truthy(l.IsTDSApplicable ?? l.TDSApplicable),
          tdsDeducteeType: text(l.TDSDeducteeType),
          natureOfPayment: nature || null,
        });
      }
      return out;
    },

    ledgerVouchers: ledgerVoucherEnvelope,

    async ledgerVoucherRows(company, ledgerName, fromDate, toDate) {
      const raw = await ledgerVoucherEnvelope(company, ledgerName, fromDate, toDate);
      const from = normDate(fromDate);
      const to = normDate(toDate);
      const rows: LedgerVoucherRow[] = [];
      let dropped = 0;
      for (const v of raw) {
        if (typeof v !== "object" || v === null) {
          dropped += 1;
          continue;
        }
        const r = v as Record<string, unknown>;
        const date = normDate(r.date);
        // Same defensive re-filter as vouchers(): an out-of-period row would
        // corrupt the opening-to-closing reconciliation.
        const sign = sideSign(r);
        if (!/^\d{8}$/.test(date) || date < from || date > to || sign === 0) {
          dropped += 1;
          continue;
        }
        rows.push({
          date,
          voucherType: text(r.voucherType),
          voucherNumber: text(r.voucherNumber),
          reference: text(r.reference),
          counterparty: text(r.counterLedgerName) || text(r.partyLedgerName),
          amount: sign * Math.abs(num(r.amount ?? r.matchedAmount)),
          matchStatus: matchStatusOf(r.matchStatus),
          tax: taxOf(r.taxBreakup),
        });
      }
      return { rows, dropped };
    },

    async vouchers(company, fromDate, toDate) {
      const raw = JSON.parse(
        await call(
          "tally_get_vouchers",
          withCompany({ fromDate, toDate, includeLines: true }, company),
        ),
      ) as unknown;
      const from = normDate(fromDate);
      const to = normDate(toDate);
      return parseVoucherRows(raw, from, to);
    },

    close,
  };
}

/**
 * Build the raw downstream tool caller. When `timeoutMs` is set it is passed
 * as the request option on every call; when it is undefined the call is made
 * without options, so the SDK's own default timeout applies unchanged.
 */
export function makeRawCaller(client: ToolCallClient, timeoutMs?: number): RawCaller {
  const options = timeoutMs === undefined ? undefined : { timeout: timeoutMs };
  return async (tool, args) => {
    const res = (await client.callTool({ name: tool, arguments: args }, undefined, options)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (res.isError) throw new Error(`downstream ${tool} failed: ${text}`);
    return text;
  };
}

export async function connectDownstream(cfg: GatewayConfig): Promise<Downstream> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Never inherit the downstream write switch.
    if (k === "TALLY_ALLOW_WRITES") continue;
    if (v !== undefined) env[k] = v;
  }

  const transport = new StdioClientTransport({
    command: cfg.downstreamCommand,
    args: cfg.downstreamArgs,
    env,
  });
  const client = new Client({ name: "tally-agent", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (e: unknown) {
    const cmdLine = [cfg.downstreamCommand, ...cfg.downstreamArgs].join(" ");
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to start the downstream Tally MCP server. Command tried: ${cmdLine} — ${reason}`,
    );
  }

  return makeDownstream(
    makeRawCaller(client, cfg.downstreamTimeoutMs),
    () => client.close(),
  );
}
