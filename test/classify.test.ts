import { describe, expect, it } from "vitest";
import { buildClassifier } from "../src/classify.js";
import type { GroupNode } from "../src/types.js";

const groups: GroupNode[] = [
  { name: "Current Assets", parent: "" },
  { name: "Current Liabilities", parent: "" },
  { name: "Indirect Expenses", parent: "" },
  { name: "Capital Account", parent: "" },
  { name: "Suspense A/c", parent: "" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Bank Accounts", parent: "Current Assets" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Unsecured Loans", parent: "Loans (Liability)" },
  // user groups
  { name: "Freight Outward", parent: "Indirect Expenses" },
  { name: "Loans - Directors", parent: "Unsecured Loans" },
  { name: "Zonal Debtors", parent: "Sundry Debtors" },
];

describe("ancestry", () => {
  it("walks a user group up to its predefined root", () => {
    const c = buildClassifier(groups);
    expect(c.ancestry("Loans - Directors")).toEqual([
      "Loans - Directors",
      "Unsecured Loans",
      "Loans (Liability)",
    ]);
  });

  it("terminates on a cycle instead of hanging", () => {
    const cyclic: GroupNode[] = [
      { name: "A", parent: "B" },
      { name: "B", parent: "A" },
    ];
    const c = buildClassifier(cyclic);
    expect(c.ancestry("A")).toEqual(["A", "B"]);
  });

  it("terminates at Tally's root-of-primaries marker instead of walking into a phantom node", () => {
    // Verified against a live company: a primary group's PARENT field is not
    // empty — it is a literal control character U+0004 followed by " Primary"
    // (Tally's internal "root of primaries" node), not a real group.
    const withRootMarker: GroupNode[] = [
      { name: "Current Liabilities", parent: " Primary" },
      { name: "Sundry Creditors", parent: "Current Liabilities" },
    ];
    const c = buildClassifier(withRootMarker);
    expect(c.ancestry("Sundry Creditors")).toEqual(["Sundry Creditors", "Current Liabilities"]);
    expect(c.isPrimaryGroup("Current Liabilities")).toBe(true);
    expect(c.maskPolicy("Sundry Creditors")).toBe("mask");
  });
});

describe("maskPolicy", () => {
  it("masks a user group nested under a masked root", () => {
    expect(buildClassifier(groups).maskPolicy("Loans - Directors")).toBe("mask");
  });

  it("clears a user group nested under an impersonal root", () => {
    expect(buildClassifier(groups).maskPolicy("Freight Outward")).toBe("clear");
  });

  it("masks a group it has never heard of", () => {
    expect(buildClassifier(groups).maskPolicy("Some New Group")).toBe("mask");
  });

  it("masks Bank Accounts, because names carry account numbers", () => {
    expect(buildClassifier(groups).maskPolicy("Bank Accounts")).toBe("mask");
  });

  it("clears Suspense A/c", () => {
    expect(buildClassifier(groups).maskPolicy("Suspense A/c")).toBe("clear");
  });

  it("matches group names case-insensitively", () => {
    expect(buildClassifier(groups).maskPolicy("sundry debtors")).toBe("mask");
  });
});

describe("overrides", () => {
  it("matches a ledger override even when the real name carries embedded whitespace variants", () => {
    // Same real-world issue as the vault: Tally can hand back a ledger name
    // with different internal whitespace than what the override file used.
    const c = buildClassifier(groups, {
      forceMaskLedgers: [],
      forceClearLedgers: ["Acme Traders"],
      forceMaskGroups: [],
      forceClearGroups: [],
    });
    expect(c.ledgerPolicy("Acme\r\nTraders", "Sundry Creditors")).toBe("clear");
  });

  it("force-clear beats the group rule", () => {
    const c = buildClassifier(groups, {
      forceMaskLedgers: [],
      forceClearLedgers: [],
      forceMaskGroups: [],
      forceClearGroups: ["Bank Accounts"],
    });
    expect(c.maskPolicy("Bank Accounts")).toBe("clear");
  });

  it("force-mask beats the group rule", () => {
    const c = buildClassifier(groups, {
      forceMaskLedgers: [],
      forceClearLedgers: [],
      forceMaskGroups: ["Freight Outward"],
      forceClearGroups: [],
    });
    expect(c.maskPolicy("Freight Outward")).toBe("mask");
  });
});

describe("role", () => {
  it("reports debtor for a group under Sundry Debtors", () => {
    expect(buildClassifier(groups).role("Zonal Debtors")).toBe("debtor");
  });

  it("reports cash for Cash-in-Hand", () => {
    expect(buildClassifier(groups).role("Cash-in-Hand")).toBe("cash");
  });

  it("reports other for an unrecognised group", () => {
    expect(buildClassifier(groups).role("Some New Group")).toBe("other");
  });
});

describe("isPrimaryGroup", () => {
  it("is true for a Tally primary group", () => {
    expect(buildClassifier(groups).isPrimaryGroup("Current Assets")).toBe(true);
  });

  it("is false for a sub-group", () => {
    expect(buildClassifier(groups).isPrimaryGroup("Sundry Debtors")).toBe(false);
  });

  it("matches Tally's real spelling of Branch / Divisions (spaces around the slash)", () => {
    expect(buildClassifier(groups).isPrimaryGroup("Branch / Divisions")).toBe(true);
  });
});
