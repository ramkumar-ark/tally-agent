import { describe, expect, it } from "vitest";
import { buildClassifier } from "../src/classify.js";
import { createVault } from "../src/vault.js";
import {
  demaskText,
  maskFinding,
  maskKnownNames,
  maskLedgerName,
  redactTaxIds,
  scrubDigits,
  scrubSecrets,
} from "../src/mask.js";
import type { Finding, GroupNode } from "../src/types.js";

const groups: GroupNode[] = [
  { name: "Current Assets", parent: "" },
  { name: "Current Liabilities", parent: "" },
  { name: "Indirect Expenses", parent: "" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Bank Accounts", parent: "Current Assets" },
];

describe("scrubDigits", () => {
  it("replaces a run of six or more digits", () => {
    expect(scrubDigits("HDFC 50200012345678")).toBe("HDFC [number]");
  });

  it("leaves short digit runs alone", () => {
    expect(scrubDigits("Rent - Unit 12")).toBe("Rent - Unit 12");
    expect(scrubDigits("Godown 12345")).toBe("Godown 12345");
  });

  it("scrubs every run in the string", () => {
    expect(scrubDigits("A 123456 B 7890123")).toBe("A [number] B [number]");
  });
});

describe("redactTaxIds", () => {
  it("redacts a 15-char GSTIN, which has no 6-digit run for scrubDigits to catch", () => {
    expect(scrubDigits("27AAAAA0000A1Z5")).toBe("27AAAAA0000A1Z5"); // proves the gap
    expect(redactTaxIds("27AAAAA0000A1Z5")).toBe("[tax-id]");
  });

  it("redacts a GSTIN embedded in free text and glued to a label", () => {
    expect(redactTaxIds("against GSTIN 27AAAAA0000A1Z5 as per invoice")).toBe(
      "against GSTIN [tax-id] as per invoice",
    );
    expect(redactTaxIds("GSTIN29ABCDE1234F1Z9")).toBe("GSTIN[tax-id]");
  });

  it("redacts a 10-char PAN", () => {
    expect(redactTaxIds("PAN ABCDE1234F")).toBe("PAN [tax-id]");
  });

  it("redacts a lowercase tax id", () => {
    expect(redactTaxIds("gstin 27aaaaa0000a1z5")).toBe("gstin [tax-id]");
  });

  it("redacts a GSTIN's embedded PAN as one token, not a half-eaten PAN", () => {
    expect(redactTaxIds("27AAAAA0000A1Z5")).toBe("[tax-id]");
  });

  it("leaves ordinary prose and short alphanumerics alone", () => {
    expect(redactTaxIds("Sale to Acme Traders as per invoice")).toBe(
      "Sale to Acme Traders as per invoice",
    );
    expect(redactTaxIds("INV-0041")).toBe("INV-0041");
  });
});

describe("scrubSecrets", () => {
  it("catches both a tax id and a digit run in one string", () => {
    expect(scrubSecrets("GSTIN 27AAAAA0000A1Z5 acct 50200012345678")).toBe(
      "GSTIN [tax-id] acct [number]",
    );
  });
});

describe("maskLedgerName", () => {
  it("replaces a masked-group ledger with a role pseudonym", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    expect(maskLedgerName("Acme Traders", "Sundry Creditors", c, v)).toBe("Creditor 1");
  });

  it("leaves a clear-group ledger readable but scrubs long digit runs", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    expect(maskLedgerName("Freight 987654321", "Indirect Expenses", c, v)).toBe(
      "Freight [number]",
    );
  });

  it("never leaks a bank account number", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    const out = maskLedgerName("HDFC 50200012345678", "Bank Accounts", c, v);
    expect(out).toBe("Bank 1");
    expect(out).not.toContain("50200012345678");
  });
});

describe("maskFinding", () => {
  const finding: Finding = {
    id: "TB-004-17",
    check: "wrong_side_balance",
    severity: "warning",
    ledger: "Acme Traders",
    group: "Sundry Creditors",
    amount: 41250,
    side: "Dr",
    expected: "Cr",
    detail: "Creditor Acme Traders carries a debit balance",
  };

  it("leaves a fleet-wide finding with no ledger alone", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    const masked = maskFinding(
      { ...finding, check: "out_of_balance", ledger: "", group: "", detail: "difference 1000.00 Dr" },
      c,
      v,
    );
    expect(masked.ledger).toBe("");
    expect(v.entries()).toHaveLength(0);
  });

  it("masks the ledger but not the group", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    const masked = maskFinding(finding, c, v);
    expect(masked.ledger).toBe("Creditor 1");
    expect(masked.group).toBe("Sundry Creditors");
  });

  it("masks the real name inside the detail text too", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    const masked = maskFinding(finding, c, v);
    expect(masked.detail).not.toContain("Acme Traders");
    expect(masked.detail).toContain("Creditor 1");
  });

  it("leaves amounts and ids untouched", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    const masked = maskFinding(finding, c, v);
    expect(masked.amount).toBe(41250);
    expect(masked.id).toBe("TB-004-17");
  });

  it("redacts a GSTIN typed into the detail text", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    const masked = maskFinding(
      { ...finding, detail: "Acme Traders filed under 27AAAAA0000A1Z5" },
      c,
      v,
    );
    expect(masked.detail).not.toContain("27AAAAA0000A1Z5");
    expect(masked.detail).toContain("[tax-id]");
  });

  it("masks an already-vaulted party name that appears in the detail of a fleet-wide finding", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    maskLedgerName("Acme Traders", "Sundry Creditors", c, v); // vault it
    const masked = maskFinding(
      { ...finding, ledger: "", group: "", detail: "Acme Traders is out of balance" },
      c,
      v,
    );
    expect(masked.detail).toContain("Creditor 1");
    expect(masked.detail).not.toContain("Acme Traders");
  });
});

describe("demaskText", () => {
  it("substitutes real names back into report text", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    maskLedgerName("Acme Traders", "Sundry Creditors", c, v);
    expect(demaskText("Creditor 1 carries a debit balance", v)).toBe(
      "Acme Traders carries a debit balance",
    );
  });

  it("prefers the longest alias so Creditor 12 is not read as Creditor 1", () => {
    const c = buildClassifier(groups);
    const v = createVault();
    for (let i = 1; i <= 12; i++) {
      maskLedgerName(`Party ${i}`, "Sundry Creditors", c, v);
    }
    expect(demaskText("Creditor 12 owes money", v)).toBe("Party 12 owes money");
  });

  it("leaves text with no aliases unchanged", () => {
    expect(demaskText("Nothing to see", createVault())).toBe("Nothing to see");
  });
});
