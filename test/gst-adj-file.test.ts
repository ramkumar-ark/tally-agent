import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gstAdjEnvelope, writeGstAdjImportFile } from "../src/gst-adj-file.js";
import type { GadjEntry } from "../src/gst-adj.js";
import type { ThreeBSummary } from "../src/gst-adj-3b.js";

const threeB: ThreeBSummary = {
  companyName: "Test Constructions",
  gstin: "33AAAAA0000A0Z0",
  state: "Tamil Nadu",
  months: ["2025-05"],
  outwardTaxable: {},
  outwardTax: {},
  rcmTax: {},
  itcRcm: {},
  itcOther: {},
  itcReversed: {},
  netItc: {},
  itcReclaimed: {},
  tdsSectionPresent: false,
};

const entryKind1: GadjEntry = {
  kind: 1,
  month: "2025-05",
  date: "20250531",
  narration: "being output gst for the month May 2025",
  legs: [
    { dr: "Output CGST A/c", cr: "CGST Payable A/c", amount: 400 },
    { dr: "Output SGST A/c", cr: "SGST Payable A/c", amount: 400 },
  ],
};

const entryKind2: GadjEntry = {
  kind: 2,
  month: "2025-05",
  date: "20250531",
  narration: "being input gst for the month May 2025",
  legs: [{ dr: "CGST Payable A/c", cr: "Input CGST A/c", amount: 100 }],
};

function decodeEnvelope(path: string): { tallymessage: Record<string, unknown>[] } {
  const raw = readFileSync(path);
  expect(raw[0]).toBe(0xff);
  expect(raw[1]).toBe(0xfe);
  const body = raw.slice(2).toString("utf16le").replace(/\r\n/g, "\n");
  return JSON.parse(body);
}

describe("gstAdjEnvelope", () => {
  it("builds a tallymessage with one voucher per entry", () => {
    const env = gstAdjEnvelope([entryKind1, entryKind2], threeB, "Journal");
    expect(env).toHaveProperty("tallymessage");
    expect((env as { tallymessage: unknown[] }).tallymessage.length).toBe(2);
  });

  it("omits vouchernumber from every voucher", () => {
    const env = gstAdjEnvelope([entryKind1, entryKind2], threeB, "Journal");
    for (const v of (env as { tallymessage: Record<string, unknown>[] }).tallymessage) {
      expect(v).not.toHaveProperty("vouchernumber");
    }
  });

  it("every voucher balances (sum of allledger amounts = 0)", () => {
    const env = gstAdjEnvelope([entryKind1, entryKind2], threeB, "Journal");
    for (const v of (env as { tallymessage: Record<string, unknown>[] }).tallymessage) {
      const entries = v.allledgerentries as Array<{ amount: string }>;
      const sum = entries.reduce((acc, e) => acc + Number(e.amount), 0);
      expect(sum).toBe(0);
    }
  });

  it("debit legs carry negative amounts", () => {
    const env = gstAdjEnvelope([entryKind1, entryKind2], threeB, "Journal");
    for (const v of (env as { tallymessage: Record<string, unknown>[] }).tallymessage) {
      const entries = v.allledgerentries as Array<{ ledgername: string; isdeemedpositive: boolean; amount: string }>;
      for (const e of entries) {
        if (e.isdeemedpositive) {
          expect(Number(e.amount)).toBeLessThan(0);
        }
      }
    }
  });

  it("narration and date round-trip", () => {
    const env = gstAdjEnvelope([entryKind1, entryKind2], threeB, "Journal");
    for (const v of (env as { tallymessage: Record<string, unknown>[] }).tallymessage) {
      expect(v.date).toBe("20250531");
      expect(v.vchstatusdate).toBe("20250531");
      expect(v.effectivedate).toBe("20250531");
      expect(typeof v.narration).toBe("string");
      expect(v.narration.length).toBeGreaterThan(0);
    }
  });

  it("gstregistration carries threeB state and gstin", () => {
    const env = gstAdjEnvelope([entryKind1], threeB, "Journal");
    const v = (env as { tallymessage: Record<string, unknown>[] }).tallymessage[0];
    expect(v.gstregistration).toEqual({
      value: "Tamil Nadu Registration",
      taxtype: "GST",
      taxregistration: "33AAAAA0000A0Z0",
    });
    expect(v["cmpgstin"]).toBe("33AAAAA0000A0Z0");
    expect(v["cmpgststate"]).toBe("Tamil Nadu");
    expect(v["cmpgstregistrationtype"]).toBe("Regular");
  });

  it("metadata, vchtype, numberingstyle, vouchernumberseries set", () => {
    const env = gstAdjEnvelope([entryKind1], threeB, "Journal");
    const v = (env as { tallymessage: Record<string, unknown>[] }).tallymessage[0];
    expect(v.metadata).toEqual({ type: "Voucher", action: "Create", objview: "Accounting Voucher View" });
    expect(v.vchtype).toBe("Journal");
    expect(v.numberingstyle).toBe("Auto Renumber");
    expect(v.vouchernumberseries).toBe("Default");
  });
});

describe("gstAdjEnvelope — UTF-16 LE BOM round-trip via writeGstAdjImportFile", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "gst-adj-"));

  it("writes BOM, UTF-16 LE, CRLF, and the file parses", async () => {
    const path = await writeGstAdjImportFile({
      reportDir: tmpDir,
      fy: "25-26",
      entries: [entryKind1, entryKind2],
      threeB,
      voucherType: "Journal",
    });

    const env = decodeEnvelope(path);
    expect(env.tallymessage.length).toBe(2);

    for (const v of env.tallymessage) {
      const entries = v.allledgerentries as Array<{ amount: string }>;
      const sum = entries.reduce((acc, e) => acc + Number(e.amount), 0);
      expect(sum).toBe(0);
      expect(v).not.toHaveProperty("vouchernumber");
    }
  });

  it("returns the full path", async () => {
    const path = await writeGstAdjImportFile({
      reportDir: tmpDir,
      fy: "25-26",
      entries: [entryKind1],
      threeB,
      voucherType: "Journal",
    });
    expect(path).toBe(join(tmpDir, "gst-adjustments-25-26.json"));
  });
});
