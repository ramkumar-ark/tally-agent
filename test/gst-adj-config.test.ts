import { describe, expect, it } from "vitest";
import { loadGstAdjConfig } from "../src/gst-adj-config.js";

describe("loadGstAdjConfig", () => {
  it("missing file → defaults + warn (as26-map semantics)", () => {
    const warnings: string[] = [];
    const c = loadGstAdjConfig(undefined, (m) => warnings.push(m));
    expect(c.voucherType).toBe("Journal");
    expect(c.heads.cgst!.input).toBe("Input CGST A/c");
    expect(warnings.length).toBe(1);
  });
  it("unknown key or bad value throws citing the key, never a file value", () => {
    expect(() => loadGstAdjConfig("test/fixtures/gst-adj-bad.json", () => {})).toThrow(/heads\.cgst\.nosuchrole/i);
  });
  it("operator overrides win per field", () => {
    const c = loadGstAdjConfig("test/fixtures/gst-adj-ok.json", () => {});
    expect(c.voucherType).toBe("GST Adj. Voucher");
    expect(c.heads.sgst!.output).toBe("My Output SGST");
    expect(c.gstTdsCredit["2025-05"]?.cgst).toBe(500);
    expect(c.residualMarks["2025-08"]?.sgst).toBe("reversed");
  });
});
