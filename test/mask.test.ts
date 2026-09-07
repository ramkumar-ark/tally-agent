import { describe, expect, it } from "vitest";
import { buildClassifier } from "../src/classify.js";
import { createVault } from "../src/vault.js";
import { demaskText, maskFinding, maskLedgerName, scrubDigits } from "../src/mask.js";
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
