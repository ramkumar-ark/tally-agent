import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GatewayConfig } from "./config.js";
import type { GroupNode, LedgerMaster, TbRow } from "./types.js";

export type RawCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

export interface Downstream {
  callRaw(tool: string, args: Record<string, unknown>): Promise<string>;
  listCompanies(): Promise<string[]>;
  trialBalance(
    company: string | undefined,
    asOnDate: string,
  ): Promise<{ rows: TbRow[]; totalDebit: number; totalCredit: number }>;
  groups(company?: string): Promise<GroupNode[]>;
  ledgers(company?: string): Promise<LedgerMaster[]>;
  ledgerVouchers(
    company: string | undefined,
    ledgerName: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]>;
  close(): Promise<void>;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

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
      return raw.map((l) => ({
        name: String(l.name ?? ""),
        parent: String(l.parent ?? ""),
        openingBalance: num(l.openingBalance),
        closingBalance: num(l.closingBalance),
      }));
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
  await client.connect(transport);

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
