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
    "Late Fees on GST A/c",
    "Late Fee Charges",
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

describe("addendum 2026-09-26d generic rules", () => {
  it("bank/loan charges seed others across name variants, never exempt or unregistered", () => {
    for (const name of [
      "Bank Charges A/c",
      "Bank Charge - 18% IGST",
      "Bank Charge-18%",
      "Loan Charges A/c",
      "Loan Processing Charges",
      "Loan Processing Charge - HDFC",
      "Bank Commission A/c",
      "Forex Charges A/c",
      "Exchange Charges",
      "Cheque Collection Charges",
      "Annual Maintenance Charges - Bank",
    ]) {
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("others");
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe("bank-charges");
    }
  });

  it("electricity/EB charges seed exempt by the keyword rule", () => {
    for (const name of ["Electricity Charges A/c", "Electricity Expense - KSEB", "EB Charges", "EB Bill A/c"]) {
      expect(policyMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("exempt");
      expect(policyMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe("electricity");
    }
  });

  it("fuel expenses seed exempt across fuel/diesel/petrol/HSD variants", () => {
    for (const name of ["Fuel Expenses A/c", "Diesel Expenses", "Petrol A/c", "HSD Expenses", "Fuel Expenses - 0% A/c"]) {
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("exempt");
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe("fuel");
    }
  });

  it("every insurance ledger seeds others — including Ineligible ITC ones", () => {
    for (const name of [
      "Insurance Expense - Ineligible A/c",
      "Vehicle Insurance A/c",
      "Insurance Premium",
      "Insurance Expense - 18%",
      "Insurance Premium @ 5%",
    ]) {
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("others");
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe("insurance");
    }
  });

  it("interest/late fee on taxes or duties seeds not supply across variants", () => {
    for (const name of [
      "Interest on GST A/c",
      "Interest on TDS A/c",
      "Interest on Income Tax",
      "Interest on Professional Tax",
      "Interest on Tax A/c",
      "Interest on Duty",
      "Late Fee on GST",
      "Late Fee on TDS A/c",
      "Late Fee on Tax",
    ]) {
      expect(policyMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("not_supply");
      // names carrying a bare "tax" word fire the older 'taxes' rule first;
      // other late-fee names fire 'penalty' — same treatment either way
      if (!/tax/i.test(name)) {
        expect(policyMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe(
          /late fee/i.test(name) ? "penalty" : "interest-tax",
        );
      }
    }
  });

  it("interest on bank/NBFC loans seeds exempt across variants", () => {
    for (const name of [
      "Interest on Bank Loan A/c",
      "Interest on Non Bank Loans",
      "Interest on OD A/c",
      "Interest on CC A/c",
      "Bank Interest A/c",
      "NBFC Interest",
      "Loan Interest A/c",
      "Vehicle Loan Interest",
      "Equipment Loan Interest",
      "Finance Charges - Bank Loan",
      "Finance Cost A/c",
    ]) {
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("exempt");
      expect(evidenceMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe("loan-interest");
    }
  });

  it("interest on taxes (policy) beats any loan-interest reading of the name", () => {
    // structural precedence: policy runs before evidence in the seed chain
    expect(policyMatch("Interest on GST A/c", GST44_TREATMENT_RULES)?.rule.id).toBe("interest-tax");
    expect(evidenceMatch("Interest on Bank Loan A/c", GST44_TREATMENT_RULES)?.treatment).toBe("exempt");
    // a name both rules could claim resolves to the policy rule's treatment
    expect(policyMatch("Interest on Tax on Loan Processing Charges", GST44_TREATMENT_RULES)?.treatment).toBe("not_supply");
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

describe("addendum 2026-09-26e electricity policy", () => {
  it("electricity/EB seeds exempt via the POLICY rule across name variants", () => {
    for (const name of [
      "Electricity Charges Paid",
      "Electricity Charges A/c",
      "Electric Charge",
      "EB Charges",
      "EB Bill",
      "Power Charges A/c",
      "Current Charges A/c",
    ]) {
      expect(policyMatch(name, GST44_TREATMENT_RULES)?.treatment, name).toBe("exempt");
      expect(policyMatch(name, GST44_TREATMENT_RULES)?.rule.id, name).toBe("electricity");
    }
  });
});
