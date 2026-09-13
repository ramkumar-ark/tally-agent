import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { connectDownstream } from "../src/downstream.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

describe("loadConfig", () => {
  it("refuses to start without a report directory", () => {
    expect(() => loadConfig({ TALLY_MCP_COMMAND: "node" })).toThrow(
      /TALLY_AGENT_REPORT_DIR/,
    );
  });

  it("refuses to start without a downstream command", () => {
    expect(() => loadConfig({ TALLY_AGENT_REPORT_DIR: "/tmp/out" })).toThrow(
      /TALLY_MCP_COMMAND/,
    );
  });

  it("reads command, args, report dir and default company", () => {
    const cfg = loadConfig({
      TALLY_MCP_COMMAND: "node",
      TALLY_MCP_ARGS: "dist/index.js --flag",
      TALLY_AGENT_REPORT_DIR: "/tmp/out",
      TALLY_DEFAULT_COMPANY: "Demo Traders Pvt Ltd",
    });
    expect(cfg.downstreamCommand).toBe("node");
    expect(cfg.downstreamArgs).toEqual(["dist/index.js", "--flag"]);
    expect(cfg.reportDir).toBe("/tmp/out");
    expect(cfg.defaultCompany).toBe("Demo Traders Pvt Ltd");
    expect(cfg.dumpVault).toBe(false);
  });

  it("keeps a JSON-array TALLY_MCP_ARGS value verbatim, so a path with a space survives as ONE argument", () => {
    const cfg = loadConfig({
      TALLY_MCP_COMMAND: "node",
      TALLY_MCP_ARGS: '["F:/Software Projects/tally_prime_mcp_server/dist/index.js"]',
      TALLY_AGENT_REPORT_DIR: "/tmp/out",
    });
    expect(cfg.downstreamArgs).toEqual([
      "F:/Software Projects/tally_prime_mcp_server/dist/index.js",
    ]);
  });

  it("still splits a plain single-token TALLY_MCP_ARGS value on whitespace", () => {
    const cfg = loadConfig({
      TALLY_MCP_COMMAND: "node",
      TALLY_MCP_ARGS: "dist/index.js --flag",
      TALLY_AGENT_REPORT_DIR: "/tmp/out",
    });
    expect(cfg.downstreamArgs).toEqual(["dist/index.js", "--flag"]);
  });

  it("falls back to whitespace splitting on malformed JSON instead of throwing", () => {
    expect(() =>
      loadConfig({
        TALLY_MCP_COMMAND: "node",
        TALLY_MCP_ARGS: "[oops this isnt json",
        TALLY_AGENT_REPORT_DIR: "/tmp/out",
      }),
    ).not.toThrow();
    const cfg = loadConfig({
      TALLY_MCP_COMMAND: "node",
      TALLY_MCP_ARGS: "[oops this isnt json",
      TALLY_AGENT_REPORT_DIR: "/tmp/out",
    });
    expect(cfg.downstreamArgs).toEqual(["[oops", "this", "isnt", "json"]);
  });
});

describe("connectDownstream error surfacing", () => {
  it("names the resolved command and argument list when the downstream child fails before the handshake", async () => {
    await expect(
      connectDownstream({
        downstreamCommand: "node",
        downstreamArgs: ["/definitely/does/not/exist/index.js", "--flag"],
        reportDir: "/tmp/out",
        dumpVault: false,
      }),
    ).rejects.toThrow(
      /node.*\/definitely\/does\/not\/exist\/index\.js.*--flag/s,
    );
  });
});

describe("downstream parsing", () => {
  it("parses trial balance rows into numbers", async () => {
    const d = fakeDownstream();
    const tb = await d.trialBalance("Demo Traders Pvt Ltd", "20260331");
    expect(tb.totalDebit).toBe(175000);
    expect(tb.totalCredit).toBe(174000);
    expect(tb.rows).toHaveLength(5);
    const acme = tb.rows.find((r) => r.name === "acme traders");
    expect(acme?.balance).toBe(41250);
    expect(acme?.parent).toBe("Sundry Creditors");
  });

  it("parses a credit balance as negative", async () => {
    const d = fakeDownstream();
    const tb = await d.trialBalance(undefined, "20260331");
    expect(tb.rows.find((r) => r.name === "petty cash")?.balance).toBe(-250);
  });

  it("parses the group tree", async () => {
    const groups = await fakeDownstream().groups();
    expect(groups).toContainEqual({ name: "Bank Accounts", parent: "Current Assets" });
  });

  it("parses ledger masters, flipping raw Tally master sign to positive = debit", async () => {
    const d = fakeDownstream();
    const ledgers = await d.ledgers();
    // Fixture raw master values: Acme "-41250.00" (debit in raw Tally sign),
    // HDFC "75000.00" (credit), Rent "-53500.00" (debit).
    const acme = ledgers.find((l) => l.name === "Acme Traders");
    const bank = ledgers.find((l) => l.name === "HDFC 50200012345678");
    const rent = ledgers.find((l) => l.name === "Rent");
    expect(acme?.openingBalance).toBe(41250);
    expect(acme?.closingBalance).toBe(41250);
    expect(bank?.closingBalance).toBe(-75000);
    expect(rent?.closingBalance).toBe(53500);
  });

  it("passes the company through to the downstream call", async () => {
    const d = fakeDownstream();
    await d.trialBalance("Demo Traders Pvt Ltd", "20260331");
    expect(d.calls[0]).toEqual({
      tool: "tally_trial_balance",
      args: { asOnDate: "20260331", company: "Demo Traders Pvt Ltd" },
    });
  });

  it("omits company when none is given", async () => {
    const d = fakeDownstream();
    await d.groups();
    expect(d.calls[0].args).toEqual({});
  });
});

import { makeDownstream } from "../src/downstream.js";

const boot = () =>
  makeDownstream(
    async (tool, _args) => {
      const body = responses[tool];
      if (body === undefined) throw new Error(`no fixture for ${tool}`);
      return body;
    },
    async () => {},
  );

const responses: Record<string, string> = {
  tally_get_vouchers: JSON.stringify([
    {
      date: "2026-01-15",
      voucherType: "Sales",
      voucherNumber: "S/0041",
      partyLedgerName: "Acme Traders",
      isCancelled: "no",
      entries: [
        { LEDGERNAME: "Acme Traders", AMOUNT: "-118000.00" },
        { LEDGERNAME: "Sales - Domestic", AMOUNT: "100000.00" },
      ],
    },
    { date: "20260405", voucherNumber: "S/later", voucherType: "Sales", partyLedgerName: "", entries: [] },
    { date: "", voucherNumber: "", voucherType: "", partyLedgerName: "", entries: [] },
  ]),
  tally_get_ledgers: JSON.stringify([
    { name: "Acme Traders", parent: "Sundry Creditors", gstin: " 27aaaaa0000a1z5 ", state: "Maharashtra" },
    { name: "Local Vendor", parent: "Sundry Creditors" },
    { parent: "Broken" },
  ]),
};

describe("downstream voucher parsing (M2 contracts, fixture-pinned)", () => {
  it("flips raw amounts to positive=debit once, and drops out-of-period and undated rows", async () => {
    const rows = await boot().vouchers(undefined, "20260101", "20260331");
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("20260115");
    expect(rows[0].entries[0]).toEqual({ ledger: "Acme Traders", amount: 118000 });
    expect(rows[0].entries[1]).toEqual({ ledger: "Sales - Domestic", amount: -100000 });
    expect(rows[0].cancelled).toBe(false);
  });

  it("recognizes the live single-object entries shape too", async () => {
    responses.tally_get_vouchers = JSON.stringify([
      { date: "20260115", voucherType: "J", voucherNumber: "J/1", partyLedgerName: "", isCancelled: "Yes", entries: { LEDGERNAME: "X", AMOUNT: "-50" } },
    ]);
    const rows = await boot().vouchers(undefined, "20260101", "20260131");
    expect(rows[0].cancelled).toBe(true);
    expect(rows[0].entries).toEqual([{ ledger: "X", amount: 50 }]);
  });

  it("passes company and includeLines through to the downstream call", async () => {
    const seen: Record<string, unknown>[] = [];
    const d = makeDownstream(
      async (tool, args) => {
        void tool;
        seen.push(args);
        return responses[tool];
      },
      async () => {},
    );
    await d.vouchers("Demo Traders Pvt Ltd", "20260101", "20260331");
    expect(seen[0]).toMatchObject({ company: "Demo Traders Pvt Ltd", fromDate: "20260101", toDate: "20260331", includeLines: true });
  });
});

describe("downstream verbose ledger parsing (M2 tax-id scalars)", () => {
  it("returns name/parent/gstin/state, normalizes the GSTIN, and skips broken rows", async () => {
    const ledgers = await boot().ledgersTax(undefined);
    expect(ledgers).toEqual([
      {
        name: "Acme Traders",
        parent: "Sundry Creditors",
        gstin: "27AAAAA0000A1Z5",
        state: "Maharashtra",
      },
      { name: "Local Vendor", parent: "Sundry Creditors", gstin: null, state: "" },
    ]);
  });

  it("still parses the plain (non-verbose) ledger masters", async () => {
    const ledgers = await boot().ledgers(undefined);
    expect(ledgers[0]).toMatchObject({ name: "Acme Traders", openingBalance: 0, closingBalance: 0 });
  });
});
