import { describe, expect, it } from "vitest";
import { parseReturns } from "../src/returns.js";

const row = (over: Record<string, unknown> = {}) => ({
  gstin: "27AAAAA0000A1Z5",
  partyName: "Acme Traders",
  kind: "outward",
  taxableValue: 1000,
  cgst: 90,
  sgst: 90,
  igst: 0,
  cess: 0,
  ...over,
});

describe("parseReturns", () => {
  it("parses string amounts and merges same (gstin, kind) rows by summation", () => {
    const rows = parseReturns(
      JSON.stringify({
        returns: [row({ taxableValue: "50,000", cgst: "9,000" }), row({ taxableValue: 1000 })],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taxableValue: 51000,
      cgst: 9090,
      partyName: "Acme Traders",
    });
  });

  it("fills a party name from a later row when the first row lacked one", () => {
    const rows = parseReturns(
      JSON.stringify({
        returns: [row({ partyName: "" }), row({})],
      }),
    );
    expect(rows[0].partyName).toBe("Acme Traders");
  });

  it("normalizes gstin case and whitespace so the join is exact", () => {
    const rows = parseReturns(JSON.stringify({ returns: [row({ gstin: " 27aaaaa0000a1z5 " })] }));
    expect(rows[0].gstin).toBe("27AAAAA0000A1Z5");
  });

  it("rejects a non-JSON file", () => {
    expect(() => parseReturns("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects wholesale when a row's gstin is malformed, and the error never echoes the value", () => {
    const bad = JSON.stringify({ returns: [row(), row({ gstin: "12SHORT1Z" })] });
    try {
      parseReturns(bad);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toMatch(/row 2: gstin/);
      expect(e.message).not.toContain("12SHORT");
    }
  });

  it("rejects an unknown kind, naming the row, without echoing any amount", () => {
    const bad = JSON.stringify({ returns: [row({ kind: "export" })] });
    expect(() => parseReturns(bad)).toThrow(/row 1: kind/);
  });

  it("rejects a file without a returns array", () => {
    expect(() => parseReturns(JSON.stringify({ rows: [] }))).toThrow(/"returns" array/);
  });
});
