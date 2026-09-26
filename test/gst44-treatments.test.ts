import { describe, expect, it } from "vitest";
import {
  CHECK_ORDINAL,
  findingId,
} from "../src/types.js";
import {
  GST44_TREATMENT_RULES,
  evidenceMatch,
  loadGst44TreatmentRules,
  patternMatch,
  policyMatch,
} from "../src/gst44-treatments.js";

describe("gst44 working-sheet check ids", () => {
  it("occupy ordinals 28-30 without disturbing the existing space", () => {
    expect(CHECK_ORDINAL.gst44_ws_unclassified).toBe(28);
    expect(CHECK_ORDINAL.gst44_ws_prior_year_changed).toBe(29);
    expect(CHECK_ORDINAL.gst44_ws_rule_conflict).toBe(30);
    expect(CHECK_ORDINAL.gst44_status_override_unknown_ledger).toBe(18);
    expect(findingId("gst44_ws_unclassified", 1)).toBe("TB-028-1");
    expect(findingId("gst44_ws_prior_year_changed", 2)).toBe("TB-029-2");
    expect(findingId("gst44_ws_rule_conflict", 1)).toBe("TB-030-1");
  });
});

describe("policy keyword rules", () => {
  it.each([
    "Taxes A/c",
    "Rates & Taxes A/c",
    "Rates and Taxes",
    "RATE & TAXES",
    "Income Tax A/c",
    "Depreciation A/c",
    "Salary & Bonus",
    "Salaries A/c",
    "Wages A/c",
    "EPF Employer Contribution",
    "ESI Contribution",
    "Partners Remuneration A/c",
    "Interest on Capital A/c",
    "Donations A/c",
    "Penalty on GST",
    "Penalties A/c",
    "EOT Fine",
    "Rounded Off",
    "Loss on Sale of Fixed Asset",
    "Bad Debts Written Off A/c",
  ])("seeds %s as not supply", (name) => {
    expect(policyMatch(name, GST44_TREATMENT_RULES)?.treatment).toBe("not_supply");
  });

  it("does not let a keyword match inside a larger word", () => {
    expect(policyMatch("Taxi Fare A/c", GST44_TREATMENT_RULES)).toBeNull();
    expect(policyMatch("Financing Charges A/c", GST44_TREATMENT_RULES)).toBeNull();
  });

  it("leaves spend ledgers unpoliced", () => {
    expect(policyMatch("Sub Contract Expenses - 18% A/c", GST44_TREATMENT_RULES)).toBeNull();
    expect(policyMatch("Fuel Expenses A/c", GST44_TREATMENT_RULES)).toBeNull();
    expect(policyMatch("Purchases A/c", GST44_TREATMENT_RULES)).toBeNull();
  });
});

describe("evidence rules", () => {
  it("URD marker -> unregistered", () => {
    expect(evidenceMatch("Labour Charges - URD A/c", GST44_TREATMENT_RULES)?.treatment).toBe("unregistered");
    expect(evidenceMatch("Transport - Unregistered Dealer", GST44_TREATMENT_RULES)?.treatment).toBe("unregistered");
  });
  it("explicit rate suffixes: 0% -> exempt, any other rate -> others", () => {
    expect(patternMatch("Fuel Expenses - 0% A/c", GST44_TREATMENT_RULES)?.treatment).toBe("exempt");
    expect(patternMatch("Sub Contract Expenses - 18% A/c", GST44_TREATMENT_RULES)?.treatment).toBe("others");
    expect(patternMatch("Freight -GST-28%", GST44_TREATMENT_RULES)?.treatment).toBe("others");
    expect(patternMatch("Hire Charges @ 5%", GST44_TREATMENT_RULES)?.treatment).toBe("others");
  });
  it("no suffix, no URD -> no evidence match", () => {
    expect(evidenceMatch("Purchases A/c", GST44_TREATMENT_RULES)).toBeNull();
    expect(patternMatch("Purchases A/c", GST44_TREATMENT_RULES)).toBeNull();
  });
  it("a bare 10% never reads as the zero-rate", () => {
    expect(patternMatch("Printing - 10% A/c", GST44_TREATMENT_RULES)?.treatment).toBe("others");
  });
});

describe("operator rules", () => {
  it("the built-ins stand alone when no path is given", async () => {
    const rules = await loadGst44TreatmentRules(undefined, () => {});
    expect(rules).toHaveLength(GST44_TREATMENT_RULES.length);
  });

  it("a missing file fails open with a warning", async () => {
    const warnings: string[] = [];
    const rules = await loadGst44TreatmentRules("/nonexistent/rules.json", (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(rules).toHaveLength(GST44_TREATMENT_RULES.length);
  });

  it("operator rules precede the built-ins within their kind", async () => {
    const dir = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(await dir.mkdtemp(path.join(os.tmpdir(), "ws-rules-")), "rules.json");
    await dir.writeFile(
      file,
      JSON.stringify({
        rules: [{ id: "fuel-op", kind: "evidence", treatment: "others", keywords: ["fuel"], note: "company fact" }],
      }),
    );
    const rules = await loadGst44TreatmentRules(file, () => {});
    expect(evidenceMatch("Fuel Expenses A/c", rules)?.rule.id).toBe("fuel-op");
  });

  it("a malformed file throws citing the rule index, never a value", async () => {
    const dir = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(await dir.mkdtemp(path.join(os.tmpdir(), "ws-rules-")), "rules.json");
    await dir.writeFile(
      file,
      JSON.stringify({ rules: [{ id: "a", kind: "policy", treatment: "not_supply" }] }),
    );
    await expect(loadGst44TreatmentRules(file, () => {})).rejects.toThrow(/rule 1/);
    await dir.writeFile(file, "{not json");
    await expect(loadGst44TreatmentRules(file, () => {})).rejects.toThrow(/not valid JSON/);
  });
});
