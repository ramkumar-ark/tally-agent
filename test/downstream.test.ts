import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
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

  it("parses ledger masters with opening and closing balances", async () => {
    const ledgers = await fakeDownstream().ledgers();
    const acme = ledgers.find((l) => l.name === "Acme Traders");
    expect(acme?.openingBalance).toBe(41250);
    expect(acme?.closingBalance).toBe(41250);
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
