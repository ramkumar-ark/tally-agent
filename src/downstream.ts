import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GatewayConfig } from "./config.js";
import type { GroupNode, LedgerMaster, TbRow } from "./types.js";

export type RawCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

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
  entries: VoucherEntry[];
}

/** Ledger-master scalars needed for GST work. No address/bank/email/phone — the tally_get_ledger ban (R-MCP-3) stands. */
export interface LedgerTaxInfo {
  name: string;
  parent: string;
  /** Normalized (trimmed, uppercased) or null when the master carries none. */
  gstin: string | null;
  state: string;
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

const withCompany = (
  args: Record<string, unknown>,
  company: string | undefined,
): Record<string, unknown> => (company ? { ...args, company } : args);

export function makeDownstream(call: RawCaller, close: () => Promise<void>): Downstream {
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
        out.push({
          name,
          parent: String(l.parent ?? ""),
          gstin: gstin || null,
          state: String(l.state ?? ""),
        });
      }
      return out;
    },

    async ledgerVouchers(company, ledgerName, fromDate, toDate) {
      const text = await call(
        "tally_get_ledger_vouchers",
        withCompany({ ledgerName, fromDate, toDate }, company),
      );
      // The downstream server wraps rows in a report envelope
      // ({ source, company, ledgerName, ..., vouchers: [...] }), not a bare
      // array as originally assumed — see the downstream's src/tools/reads.ts.
      const parsed = JSON.parse(text) as { vouchers?: unknown[] };
      return Array.isArray(parsed.vouchers) ? parsed.vouchers : [];
    },

    async vouchers(company, fromDate, toDate) {
      const raw = JSON.parse(
        await call(
          "tally_get_vouchers",
          withCompany({ fromDate, toDate, includeLines: true }, company),
        ),
      ) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("tally_get_vouchers: expected an array of vouchers");
      }
      const from = normDate(fromDate);
      const to = normDate(toDate);
      const out: VoucherRow[] = [];
      for (const v of raw) {
        if (typeof v !== "object" || v === null) continue;
        const row = v as Record<string, unknown>;
        const date = normDate(row.date);
        // Defensive re-filter at the boundary: the downstream already filters
        // client-side, but a tax period that silently absorbs an out-of-period
        // voucher is worse than one that drops a row with a malformed date.
        if (!/^\d{8}$/.test(date) || date < from || date > to) continue;
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
          // Raw Tally ledger lines carry UPPERCASE keys; the flip to
          // positive = debit happens here, once (R-MCP-5), matching the
          // trial-balance convention.
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
          entries,
        });
      }
      return out;
    },

    close,
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

  const call: RawCaller = async (tool, args) => {
    const res = (await client.callTool({ name: tool, arguments: args })) as {
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

  return makeDownstream(call, () => client.close());
}
