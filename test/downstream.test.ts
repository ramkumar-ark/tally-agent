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
    expect(cfg.tdsRound100).toBe(true);
  });

  it("TALLY_AGENT_TDS_ROUND100_OFF=1 disables the Rule 119A(c) rounding", () => {
    const cfg = loadConfig({
      TALLY_MCP_COMMAND: "node",
      TALLY_AGENT_REPORT_DIR: "/tmp/out",
      TALLY_AGENT_TDS_ROUND100_OFF: "1",
    });
    expect(cfg.tdsRound100).toBe(false);
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

describe("loadConfig downstream timeout", () => {
  const base = { TALLY_MCP_COMMAND: "node", TALLY_AGENT_REPORT_DIR: "/tmp/out" };

  it("leaves the downstream timeout unset when the variable is absent", () => {
    expect(loadConfig(base).downstreamTimeoutMs).toBeUndefined();
  });

  it("treats an empty value as unset, like the other optional env values", () => {
    expect(
      loadConfig({ ...base, TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS: "" }).downstreamTimeoutMs,
    ).toBeUndefined();
  });

  it("reads a positive integer number of milliseconds", () => {
    expect(
      loadConfig({ ...base, TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS: "900000" })
        .downstreamTimeoutMs,
    ).toBe(900000);
  });

  it("refuses to start on a value that is not a positive integer", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "60s", "12 34"]) {
      expect(() =>
        loadConfig({ ...base, TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS: bad }),
      ).toThrow(/TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS/);
    }
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
    expect(tb.rows).toHaveLength(8);
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

import { makeDownstream, makeRawCaller, type ToolCallClient } from "../src/downstream.js";

describe("downstream request timeout", () => {
  function spyClient() {
    const seen: Array<{ params: unknown; options: unknown }> = [];
    const client: ToolCallClient = {
      async callTool(params, _resultSchema, options) {
        seen.push({ params, options });
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
    return { client, seen };
  }

  it("passes no request options when the timeout is unset, keeping the SDK default", async () => {
    const { client, seen } = spyClient();
    await makeRawCaller(client)("tally_list_companies", {});
    expect(seen[0].params).toEqual({ name: "tally_list_companies", arguments: {} });
    expect(seen[0].options).toBeUndefined();
  });

  it("passes the configured timeout as the request option on every call", async () => {
    const { client, seen } = spyClient();
    const call = makeRawCaller(client, 900000);
    await call("tally_list_companies", {});
    await call("tally_trial_balance", { asOnDate: "20260331" });
    expect(seen).toEqual([
      {
        params: { name: "tally_list_companies", arguments: {} },
        options: { timeout: 900000 },
      },
      {
        params: { name: "tally_trial_balance", arguments: { asOnDate: "20260331" } },
        options: { timeout: 900000 },
      },
    ]);
  });
});

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

describe("downstream ledger report typing (M3 scrutiny rows)", () => {
  it("signs amounts for the queried ledger, re-filters the range and counts dropped rows", async () => {
    responses.tally_get_ledger_vouchers = JSON.stringify({
      source: "ledger-vouchers-report",
      vouchers: [
        {
          date: "2026-01-15",
          voucherType: "Purchase",
          voucherNumber: "PUR/0012",
          reference: { "#text": "rich text object" },
          partyLedgerName: "Acme Traders",
          counterLedgerName: "",
          amount: "41250.00",
          matchedSide: "debit",
          matchStatus: "MATCHED",
          taxBreakup: {
            taxableAmount: "100.00",
            taxLedgers: [{ ledgerName: "Input CGST", amount: "9.00" }],
            totalTax: "18.00",
            effectiveRatePct: "18.00",
            taxStatus: "matched",
          },
        },
        {
          date: "20260120",
          voucherType: "Purchase",
          voucherNumber: "PUR/0031",
          reference: "ZL/77",
          counterLedgerName: "Zenith Logistics",
          matchedAmount: "12500.00",
          credit: "12500.00",
          taxBreakup: { effectiveRatePct: "", taxStatus: "no-tax-rows" },
        },
        { date: "20260405", voucherType: "Payment", matchedSide: "credit", amount: "1.00" },
        { date: "", voucherType: "Payment", matchedSide: "credit", amount: "1.00" },
        { date: "20260210", voucherType: "Memo", amount: "5.00", debit: "0", credit: "" },
      ],
    });
    const { rows, dropped } = await boot().ledgerVoucherRows(
      undefined,
      "Acme Traders",
      "20260101",
      "20260331",
    );
    expect(dropped).toBe(3);
    expect(rows).toEqual([
      {
        date: "20260115",
        voucherType: "Purchase",
        voucherNumber: "PUR/0012",
        reference: "",
        counterparty: "Acme Traders",
        amount: 41250,
        matchStatus: "matched",
        tax: { effectiveRatePct: 18, taxStatus: "matched" },
      },
      {
        date: "20260120",
        voucherType: "Purchase",
        voucherNumber: "PUR/0031",
        reference: "ZL/77",
        counterparty: "Zenith Logistics",
        amount: -12500,
        matchStatus: "unknown",
        tax: { effectiveRatePct: null, taxStatus: "no-tax-rows" },
      },
    ]);
  });
});
