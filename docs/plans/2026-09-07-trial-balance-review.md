# Trial Balance Review Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP gateway that stands between a chat harness and the existing Tally Prime MCP server, masks party-bearing ledger identities, runs seven trial balance checks in code, and writes de-masked reports to disk.

**Architecture:** The gateway is an MCP server on stdio (facing the harness) and an MCP client on stdio (facing `tally_prime_mcp_server`, spawned as a child process). Checks are pure functions over trial balance rows, the group tree and opening balances; they run on unmasked data, and only their findings are masked. De-masking happens in exactly two places, neither of which the model occupies: downward when a pseudonym enters a tool call bound for Tally, and outward when report text is written to disk.

**Tech Stack:** TypeScript 5.7, Node 22, `@modelcontextprotocol/sdk` ^1.12.0, `zod` ^3.24, `vitest` ^2 for tests. No other runtime dependencies.

**Spec:** `docs/design/2026-09-07-trial-balance-review-design.md`

## Global Constraints

- **Node 22, ESM only.** `"type": "module"` in `package.json`; every relative import carries a `.js` extension, matching `tally_prime_mcp_server`.
- **No write tools.** The gateway exposes no tool that mutates Tally, and spawns the downstream server without `TALLY_ALLOW_WRITES`.
- **Masking is default-on.** Any group whose ancestry does not reach a recognised impersonal root is masked. A new or unrecognised group masks.
- **These four tools, and no others, are exposed:** `tb_review`, `tb_ledger_activity`, `tb_list_companies`, `tb_write_report`. The downstream `tally_get_ledger` is never proxied — it returns address, bank account number, IFSC, email and phone.
- **Every outbound payload passes through the masker.** No tool result reaches the harness except through `maskFinding` or `maskRow`.
- **The vault is memory-only.** Never written to disk unless `TALLY_AGENT_DUMP_VAULT=1`.
- **Amounts are numbers, not strings, inside the gateway.** The downstream returns `"41250.00"`; parse once at the boundary. Positive = debit, negative = credit, matching the downstream convention.
- **Dates are `YYYYMMDD` strings** throughout, matching the downstream `asOnDate` contract.
- **Rounding threshold:** balances with `Math.abs(balance) < 0.005` are treated as zero. Totals are compared with a tolerance of `0.05`, matching the downstream `balanced` flag.
- **Report output directory** comes from `TALLY_AGENT_REPORT_DIR` and must resolve outside the harness working directory. The server refuses to start if it is unset.

---

### Task 1: Project scaffold and types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (replace)
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: every type below. All later tasks import from `src/types.js`.

- [ ] **Step 1: Replace `.gitignore`**

The committed `.gitignore` is Python-shaped and wrong for this project.

```
node_modules/
dist/
*.tsbuildinfo
.env
reports/out/
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "tally-agent",
  "version": "0.1.0",
  "description": "Masking MCP gateway and trial balance review for Tally Prime",
  "type": "module",
  "main": "dist/index.js",
  "bin": { "tally-agent": "dist/index.js" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write `src/types.ts`**

```ts
export type Severity = "critical" | "warning" | "review";

export type CheckId =
  | "out_of_balance"
  | "suspense_balance"
  | "negative_cash"
  | "wrong_side_balance"
  | "overdrawn_bank"
  | "ledger_under_primary_group"
  | "dormant_balance";

/** Ordinal used to build stable finding ids. Never renumber. */
export const CHECK_ORDINAL: Record<CheckId, number> = {
  out_of_balance: 1,
  suspense_balance: 2,
  negative_cash: 3,
  wrong_side_balance: 4,
  overdrawn_bank: 5,
  ledger_under_primary_group: 6,
  dormant_balance: 7,
};

export type Side = "Dr" | "Cr";

/** Semantic role of a group, used by the checks. Distinct from mask policy. */
export type GroupRole =
  | "debtor"
  | "creditor"
  | "bank"
  | "bank_od"
  | "cash"
  | "expense"
  | "income"
  | "stock"
  | "suspense"
  | "capital"
  | "duties"
  | "other";

export type MaskPolicy = "mask" | "clear";

/** One trial balance row, amounts parsed. Positive = debit. */
export interface TbRow {
  name: string;
  parent: string;
  balance: number;
}

export interface GroupNode {
  name: string;
  parent: string;
}

export interface LedgerMaster {
  name: string;
  parent: string;
  openingBalance: number;
  closingBalance: number;
}

export interface Finding {
  id: string;
  check: CheckId;
  severity: Severity;
  ledger: string;
  group: string;
  amount: number;
  side: Side | null;
  expected: Side | null;
  detail: string;
}

/** Everything a check needs. Checks are pure functions of this. */
export interface ReviewInput {
  asOnDate: string;
  rows: TbRow[];
  ledgers: LedgerMaster[];
  totalDebit: number;
  totalCredit: number;
  roleOf(group: string): GroupRole;
  isPrimaryGroup(group: string): boolean;
}

export type Check = (input: ReviewInput) => Finding[];

export const ZERO_TOLERANCE = 0.005;
export const TOTALS_TOLERANCE = 0.05;

export function sideOf(balance: number): Side | null {
  if (Math.abs(balance) < ZERO_TOLERANCE) return null;
  return balance > 0 ? "Dr" : "Cr";
}

export function findingId(check: CheckId, ordinal: number): string {
  return `TB-${String(CHECK_ORDINAL[check]).padStart(3, "0")}-${ordinal}`;
}
```

- [ ] **Step 6: Write the failing test**

`test/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findingId, sideOf } from "../src/types.js";

describe("sideOf", () => {
  it("returns Dr for a positive balance", () => {
    expect(sideOf(41250)).toBe("Dr");
  });

  it("returns Cr for a negative balance", () => {
    expect(sideOf(-41250)).toBe("Cr");
  });

  it("returns null inside the rounding tolerance", () => {
    expect(sideOf(0.004)).toBeNull();
    expect(sideOf(-0.004)).toBeNull();
  });
});

describe("findingId", () => {
  it("builds a stable id from check ordinal and row ordinal", () => {
    expect(findingId("wrong_side_balance", 17)).toBe("TB-004-17");
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm install && npx vitest run test/types.test.ts`
Expected: PASS. (Types plus two pure helpers; this task's test guards the id format and tolerance, which later tasks depend on.)

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/types.ts test/types.test.ts
git commit -m "feat: project scaffold and shared types"
```

---

### Task 2: Group classifier

**Files:**
- Create: `src/classify.ts`
- Test: `test/classify.test.ts`

**Interfaces:**
- Consumes: `GroupNode`, `GroupRole`, `MaskPolicy` from `src/types.js`
- Produces:
  - `buildClassifier(groups: GroupNode[], overrides?: Overrides): Classifier`
  - `interface Classifier { ancestry(group: string): string[]; rootOf(group: string): string | null; maskPolicy(group: string): MaskPolicy; role(group: string): GroupRole; isPrimaryGroup(group: string): boolean; }`
  - `interface Overrides { forceMaskLedgers: string[]; forceClearLedgers: string[]; forceMaskGroups: string[]; forceClearGroups: string[]; }`
  - `const CLEAR_ROOTS: readonly string[]`, `const PRIMARY_GROUPS: readonly string[]`

- [ ] **Step 1: Write the failing test**

`test/classify.test.ts`:

```ts
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
  { name: "Unsecured Loans", parent: "Current Liabilities" },
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
      "Current Liabilities",
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL — `Cannot find module '../src/classify.js'`

- [ ] **Step 3: Write `src/classify.ts`**

```ts
import type { GroupNode, GroupRole, MaskPolicy } from "./types.js";

export interface Overrides {
  forceMaskLedgers: string[];
  forceClearLedgers: string[];
  forceMaskGroups: string[];
  forceClearGroups: string[];
}

export const EMPTY_OVERRIDES: Overrides = {
  forceMaskLedgers: [],
  forceClearLedgers: [],
  forceMaskGroups: [],
  forceClearGroups: [],
};

/** Tally's predefined primary groups. */
export const PRIMARY_GROUPS = [
  "Branch/Divisions",
  "Capital Account",
  "Current Assets",
  "Current Liabilities",
  "Direct Expenses",
  "Direct Incomes",
  "Fixed Assets",
  "Indirect Expenses",
  "Indirect Incomes",
  "Investments",
  "Loans (Liability)",
  "Misc. Expenses (ASSET)",
  "Purchase Accounts",
  "Sales Accounts",
  "Suspense A/c",
] as const;

/**
 * Groups whose descendants are left unmasked. Everything else masks,
 * including anything not listed here at all. See design doc section 4.2.
 */
export const CLEAR_ROOTS = [
  "Sales Accounts",
  "Purchase Accounts",
  "Direct Expenses",
  "Indirect Expenses",
  "Direct Incomes",
  "Indirect Incomes",
  "Duties & Taxes",
  "Stock-in-Hand",
  "Cash-in-Hand",
  "Reserves & Surplus",
  "Provisions",
  "Suspense A/c",
  "Misc. Expenses (ASSET)",
] as const;

const ROLE_BY_GROUP: ReadonlyArray<readonly [string, GroupRole]> = [
  ["Sundry Debtors", "debtor"],
  ["Sundry Creditors", "creditor"],
  ["Bank Accounts", "bank"],
  ["Bank OD A/c", "bank_od"],
  ["Cash-in-Hand", "cash"],
  ["Direct Expenses", "expense"],
  ["Indirect Expenses", "expense"],
  ["Purchase Accounts", "expense"],
  ["Direct Incomes", "income"],
  ["Indirect Incomes", "income"],
  ["Sales Accounts", "income"],
  ["Stock-in-Hand", "stock"],
  ["Suspense A/c", "suspense"],
  ["Capital Account", "capital"],
  ["Duties & Taxes", "duties"],
];

const norm = (s: string) => s.trim().toLowerCase();

export interface Classifier {
  ancestry(group: string): string[];
  rootOf(group: string): string | null;
  maskPolicy(group: string): MaskPolicy;
  role(group: string): GroupRole;
  isPrimaryGroup(group: string): boolean;
  /** Mask policy for one ledger, applying ledger-level overrides first. */
  ledgerPolicy(ledger: string, group: string): MaskPolicy;
}

export function buildClassifier(
  groups: GroupNode[],
  overrides: Overrides = EMPTY_OVERRIDES,
): Classifier {
  const parentOf = new Map<string, string>();
  for (const g of groups) parentOf.set(norm(g.name), g.parent);

  const primary = new Set(PRIMARY_GROUPS.map(norm));
  const clearRoots = new Set(CLEAR_ROOTS.map(norm));
  const roleByGroup = new Map(ROLE_BY_GROUP.map(([g, r]) => [norm(g), r]));

  const fmGroups = new Set(overrides.forceMaskGroups.map(norm));
  const fcGroups = new Set(overrides.forceClearGroups.map(norm));
  const fmLedgers = new Set(overrides.forceMaskLedgers.map(norm));
  const fcLedgers = new Set(overrides.forceClearLedgers.map(norm));

  function ancestry(group: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = group;
    while (cur && !seen.has(norm(cur))) {
      seen.add(norm(cur));
      chain.push(cur);
      cur = parentOf.get(norm(cur)) ?? "";
    }
    return chain;
  }

  function rootOf(group: string): string | null {
    for (const g of ancestry(group)) {
      if (primary.has(norm(g))) return g;
    }
    return null;
  }

  function maskPolicy(group: string): MaskPolicy {
    for (const g of ancestry(group)) {
      if (fcGroups.has(norm(g))) return "clear";
      if (fmGroups.has(norm(g))) return "mask";
    }
    for (const g of ancestry(group)) {
      if (clearRoots.has(norm(g))) return "clear";
    }
    return "mask";
  }

  function ledgerPolicy(ledger: string, group: string): MaskPolicy {
    if (fcLedgers.has(norm(ledger))) return "clear";
    if (fmLedgers.has(norm(ledger))) return "mask";
    return maskPolicy(group);
  }

  function role(group: string): GroupRole {
    for (const g of ancestry(group)) {
      const r = roleByGroup.get(norm(g));
      if (r) return r;
    }
    return "other";
  }

  function isPrimaryGroup(group: string): boolean {
    return primary.has(norm(group));
  }

  return { ancestry, rootOf, maskPolicy, role, isPrimaryGroup, ledgerPolicy };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "feat: group ancestry classifier with default-mask policy"
```

---

### Task 3: Vault and masker

**Files:**
- Create: `src/vault.ts`, `src/mask.ts`
- Test: `test/vault.test.ts`, `test/mask.test.ts`

**Interfaces:**
- Consumes: `Classifier` from `src/classify.js`; `Finding`, `GroupRole` from `src/types.js`
- Produces:
  - `createVault(): Vault`
  - `interface Vault { pseudonym(real: string, role: GroupRole): string; resolve(alias: string): string | undefined; entries(): Array<{ real: string; alias: string }>; }`
  - `scrubDigits(text: string): string`
  - `maskLedgerName(ledger: string, group: string, c: Classifier, v: Vault): string`
  - `maskFinding(f: Finding, c: Classifier, v: Vault): Finding`
  - `demaskText(text: string, v: Vault): string`

- [ ] **Step 1: Write the failing vault test**

`test/vault.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createVault } from "../src/vault.js";

describe("vault", () => {
  it("gives the same alias for the same name", () => {
    const v = createVault();
    const a = v.pseudonym("Acme Traders Pvt Ltd", "creditor");
    const b = v.pseudonym("Acme Traders Pvt Ltd", "creditor");
    expect(a).toBe(b);
  });

  it("gives different aliases to different names", () => {
    const v = createVault();
    expect(v.pseudonym("Acme", "creditor")).not.toBe(v.pseudonym("Beta", "creditor"));
  });

  it("labels the alias by role and numbers within that role", () => {
    const v = createVault();
    expect(v.pseudonym("Acme", "creditor")).toBe("Creditor 1");
    expect(v.pseudonym("Beta", "creditor")).toBe("Creditor 2");
    expect(v.pseudonym("HDFC 50200012345678", "bank")).toBe("Bank 1");
  });

  it("matches names case-insensitively", () => {
    const v = createVault();
    expect(v.pseudonym("Acme", "creditor")).toBe(v.pseudonym("ACME", "creditor"));
  });

  it("resolves an alias back to the real name", () => {
    const v = createVault();
    const alias = v.pseudonym("Acme Traders Pvt Ltd", "creditor");
    expect(v.resolve(alias)).toBe("Acme Traders Pvt Ltd");
  });

  it("returns undefined for an alias it never issued", () => {
    expect(createVault().resolve("Creditor 99")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/vault.test.ts`
Expected: FAIL — `Cannot find module '../src/vault.js'`

- [ ] **Step 3: Write `src/vault.ts`**

```ts
import type { GroupRole } from "./types.js";

const ROLE_LABEL: Record<GroupRole, string> = {
  debtor: "Debtor",
  creditor: "Creditor",
  bank: "Bank",
  bank_od: "Bank OD",
  cash: "Cash",
  expense: "Ledger",
  income: "Ledger",
  stock: "Stock",
  suspense: "Suspense",
  capital: "Capital",
  duties: "Ledger",
  other: "Ledger",
};

export interface Vault {
  pseudonym(real: string, role: GroupRole): string;
  resolve(alias: string): string | undefined;
  entries(): Array<{ real: string; alias: string }>;
}

export function createVault(): Vault {
  const aliasByReal = new Map<string, string>();
  const realByAlias = new Map<string, string>();
  const counters = new Map<string, number>();

  function pseudonym(real: string, role: GroupRole): string {
    const key = real.trim().toLowerCase();
    const existing = aliasByReal.get(key);
    if (existing) return existing;

    const label = ROLE_LABEL[role];
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    const alias = `${label} ${n}`;

    aliasByReal.set(key, alias);
    realByAlias.set(alias.toLowerCase(), real);
    return alias;
  }

  return {
    pseudonym,
    resolve: (alias) => realByAlias.get(alias.trim().toLowerCase()),
    entries: () =>
      [...realByAlias.entries()].map(([alias, real]) => ({ real, alias })),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/vault.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing masker test**

`test/mask.test.ts`:

```ts
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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test/mask.test.ts`
Expected: FAIL — `Cannot find module '../src/mask.js'`

- [ ] **Step 7: Write `src/mask.ts`**

```ts
import type { Classifier } from "./classify.js";
import type { Finding } from "./types.js";
import type { Vault } from "./vault.js";

const DIGIT_RUN = /\d{6,}/g;

export function scrubDigits(text: string): string {
  return text.replace(DIGIT_RUN, "[number]");
}

export function maskLedgerName(
  ledger: string,
  group: string,
  c: Classifier,
  v: Vault,
): string {
  if (c.ledgerPolicy(ledger, group) === "mask") {
    return v.pseudonym(ledger, c.role(group));
  }
  return scrubDigits(ledger);
}

export function maskFinding(f: Finding, c: Classifier, v: Vault): Finding {
  // Fleet-wide findings such as out_of_balance carry no ledger; masking an
  // empty name would mint a pseudonym for nothing.
  if (!f.ledger) return { ...f, detail: scrubDigits(f.detail) };
  const ledger = maskLedgerName(f.ledger, f.group, c, v);
  const detail = scrubDigits(replaceAll(f.detail, f.ledger, ledger));
  return { ...f, ledger, detail };
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

export function demaskText(text: string, v: Vault): string {
  // Longest alias first, so "Creditor 12" is not matched by "Creditor 1".
  const entries = v
    .entries()
    .sort((a, b) => b.alias.length - a.alias.length);
  let out = text;
  for (const { alias, real } of entries) {
    out = replaceAll(out, alias, real);
  }
  return out;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run test/mask.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/vault.ts src/mask.ts test/vault.test.ts test/mask.test.ts
git commit -m "feat: vault and masker with digit scrubbing and longest-alias de-masking"
```

---

### Task 4: Critical checks — out of balance, suspense, negative cash

**Files:**
- Create: `src/checks/index.ts`, `src/checks/outOfBalance.ts`, `src/checks/suspenseBalance.ts`, `src/checks/negativeCash.ts`
- Test: `test/checks-critical.test.ts`

**Interfaces:**
- Consumes: `ReviewInput`, `Finding`, `Check`, `findingId`, `sideOf`, `ZERO_TOLERANCE`, `TOTALS_TOLERANCE` from `src/types.js`
- Produces:
  - `outOfBalance: Check`, `suspenseBalance: Check`, `negativeCash: Check`
  - `ALL_CHECKS: Check[]` in `src/checks/index.ts` (grows in Tasks 5 and 6)
  - `runChecks(input: ReviewInput): Finding[]`

- [ ] **Step 1: Write the failing test**

`test/checks-critical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { negativeCash, outOfBalance, suspenseBalance } from "../src/checks/index.js";
import type { GroupRole, ReviewInput, TbRow } from "../src/types.js";

function input(over: Partial<ReviewInput> & { rows?: TbRow[] }): ReviewInput {
  const roles: Record<string, GroupRole> = {
    "Suspense A/c": "suspense",
    "Cash-in-Hand": "cash",
    "Sundry Debtors": "debtor",
  };
  return {
    asOnDate: "20260331",
    rows: [],
    ledgers: [],
    totalDebit: 0,
    totalCredit: 0,
    roleOf: (g) => roles[g] ?? "other",
    isPrimaryGroup: () => false,
    ...over,
  };
}

describe("outOfBalance", () => {
  it("flags a difference beyond tolerance", () => {
    const f = outOfBalance(input({ totalDebit: 100000, totalCredit: 99000 }));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("out_of_balance");
    expect(f[0].severity).toBe("critical");
    expect(f[0].amount).toBe(1000);
    expect(f[0].side).toBe("Dr");
  });

  it("reports the credit direction when credits exceed debits", () => {
    const f = outOfBalance(input({ totalDebit: 99000, totalCredit: 100000 }));
    expect(f[0].side).toBe("Cr");
    expect(f[0].amount).toBe(1000);
  });

  it("is silent inside tolerance", () => {
    expect(outOfBalance(input({ totalDebit: 100000, totalCredit: 100000.04 }))).toEqual([]);
  });
});

describe("suspenseBalance", () => {
  it("flags any non-zero suspense balance", () => {
    const f = suspenseBalance(
      input({ rows: [{ name: "Suspense", parent: "Suspense A/c", balance: 5000 }] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("suspense_balance");
    expect(f[0].severity).toBe("critical");
    expect(f[0].ledger).toBe("Suspense");
  });

  it("is silent when suspense is nil", () => {
    const f = suspenseBalance(
      input({ rows: [{ name: "Suspense", parent: "Suspense A/c", balance: 0.004 }] }),
    );
    expect(f).toEqual([]);
  });

  it("ignores non-suspense groups", () => {
    const f = suspenseBalance(
      input({ rows: [{ name: "Acme", parent: "Sundry Debtors", balance: 5000 }] }),
    );
    expect(f).toEqual([]);
  });
});

describe("negativeCash", () => {
  it("flags a credit balance in cash", () => {
    const f = negativeCash(
      input({ rows: [{ name: "Petty Cash", parent: "Cash-in-Hand", balance: -250 }] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("negative_cash");
    expect(f[0].severity).toBe("critical");
    expect(f[0].amount).toBe(250);
    expect(f[0].expected).toBe("Dr");
  });

  it("is silent on a positive cash balance", () => {
    const f = negativeCash(
      input({ rows: [{ name: "Petty Cash", parent: "Cash-in-Hand", balance: 250 }] }),
    );
    expect(f).toEqual([]);
  });

  it("is silent on a nil cash balance", () => {
    const f = negativeCash(
      input({ rows: [{ name: "Petty Cash", parent: "Cash-in-Hand", balance: 0 }] }),
    );
    expect(f).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/checks-critical.test.ts`
Expected: FAIL — `Cannot find module '../src/checks/index.js'`

- [ ] **Step 3: Write `src/checks/outOfBalance.ts`**

```ts
import { findingId, TOTALS_TOLERANCE, type Check } from "../types.js";

export const outOfBalance: Check = (input) => {
  const diff = input.totalDebit - input.totalCredit;
  if (Math.abs(diff) <= TOTALS_TOLERANCE) return [];
  return [
    {
      id: findingId("out_of_balance", 1),
      check: "out_of_balance",
      severity: "critical",
      ledger: "",
      group: "",
      amount: Math.abs(diff),
      side: diff > 0 ? "Dr" : "Cr",
      expected: null,
      detail:
        `Trial balance does not balance as of ${input.asOnDate}: ` +
        `debits ${input.totalDebit.toFixed(2)}, credits ${input.totalCredit.toFixed(2)}, ` +
        `difference ${Math.abs(diff).toFixed(2)} ${diff > 0 ? "Dr" : "Cr"}`,
    },
  ];
};
```

- [ ] **Step 4: Write `src/checks/suspenseBalance.ts`**

```ts
import { findingId, sideOf, type Check } from "../types.js";

export const suspenseBalance: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (input.roleOf(row.parent) !== "suspense") continue;
    const side = sideOf(row.balance);
    if (!side) continue;
    n += 1;
    out.push({
      id: findingId("suspense_balance", n),
      check: "suspense_balance" as const,
      severity: "critical" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side,
      expected: null,
      detail:
        `${row.name} carries a suspense balance of ${Math.abs(row.balance).toFixed(2)} ${side} ` +
        `as of ${input.asOnDate}; suspense must be nil at finalization`,
    });
  }
  return out;
};
```

- [ ] **Step 5: Write `src/checks/negativeCash.ts`**

```ts
import { findingId, sideOf, type Check } from "../types.js";

export const negativeCash: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (input.roleOf(row.parent) !== "cash") continue;
    if (sideOf(row.balance) !== "Cr") continue;
    n += 1;
    out.push({
      id: findingId("negative_cash", n),
      check: "negative_cash" as const,
      severity: "critical" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side: "Cr" as const,
      expected: "Dr" as const,
      detail:
        `${row.name} shows a negative cash balance of ${Math.abs(row.balance).toFixed(2)} ` +
        `as of ${input.asOnDate}; cash cannot be negative, so receipts are unrecorded or a payment is misdated`,
    });
  }
  return out;
};
```

- [ ] **Step 6: Write `src/checks/index.ts`**

```ts
import type { Check, Finding, ReviewInput } from "../types.js";
import { negativeCash } from "./negativeCash.js";
import { outOfBalance } from "./outOfBalance.js";
import { suspenseBalance } from "./suspenseBalance.js";

export { negativeCash, outOfBalance, suspenseBalance };

export const ALL_CHECKS: Check[] = [outOfBalance, suspenseBalance, negativeCash];

export function runChecks(input: ReviewInput): Finding[] {
  return ALL_CHECKS.flatMap((check) => check(input));
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `npx vitest run test/checks-critical.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/checks test/checks-critical.test.ts
git commit -m "feat: critical trial balance checks"
```

---

### Task 5: Warning checks — wrong side, overdrawn bank

**Files:**
- Create: `src/checks/wrongSideBalance.ts`, `src/checks/overdrawnBank.ts`
- Modify: `src/checks/index.ts`
- Test: `test/checks-warning.test.ts`

**Interfaces:**
- Consumes: `ReviewInput`, `GroupRole`, `Side` from `src/types.js`
- Produces: `wrongSideBalance: Check`, `overdrawnBank: Check`; both appended to `ALL_CHECKS`

- [ ] **Step 1: Write the failing test**

`test/checks-warning.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overdrawnBank, wrongSideBalance } from "../src/checks/index.js";
import type { GroupRole, ReviewInput, TbRow } from "../src/types.js";

const roles: Record<string, GroupRole> = {
  "Sundry Debtors": "debtor",
  "Sundry Creditors": "creditor",
  "Indirect Expenses": "expense",
  "Sales Accounts": "income",
  "Stock-in-Hand": "stock",
  "Bank Accounts": "bank",
  "Bank OD A/c": "bank_od",
};

function input(rows: TbRow[]): ReviewInput {
  return {
    asOnDate: "20260331",
    rows,
    ledgers: [],
    totalDebit: 0,
    totalCredit: 0,
    roleOf: (g) => roles[g] ?? "other",
    isPrimaryGroup: () => false,
  };
}

describe("wrongSideBalance", () => {
  it("flags a creditor with a debit balance", () => {
    const f = wrongSideBalance(input([{ name: "Acme", parent: "Sundry Creditors", balance: 41250 }]));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("wrong_side_balance");
    expect(f[0].severity).toBe("warning");
    expect(f[0].side).toBe("Dr");
    expect(f[0].expected).toBe("Cr");
  });

  it("flags a debtor with a credit balance", () => {
    const f = wrongSideBalance(input([{ name: "Beta", parent: "Sundry Debtors", balance: -900 }]));
    expect(f[0].expected).toBe("Dr");
    expect(f[0].side).toBe("Cr");
  });

  it("flags an expense with a credit balance", () => {
    const f = wrongSideBalance(input([{ name: "Rent", parent: "Indirect Expenses", balance: -500 }]));
    expect(f).toHaveLength(1);
  });

  it("flags an income with a debit balance", () => {
    const f = wrongSideBalance(input([{ name: "Sales", parent: "Sales Accounts", balance: 500 }]));
    expect(f).toHaveLength(1);
  });

  it("flags negative stock", () => {
    const f = wrongSideBalance(input([{ name: "Closing Stock", parent: "Stock-in-Hand", balance: -12 }]));
    expect(f).toHaveLength(1);
  });

  it("is silent when a debtor is at exactly zero", () => {
    expect(wrongSideBalance(input([{ name: "Beta", parent: "Sundry Debtors", balance: 0 }]))).toEqual([]);
  });

  it("is silent on correct sides", () => {
    const f = wrongSideBalance(
      input([
        { name: "Acme", parent: "Sundry Creditors", balance: -41250 },
        { name: "Beta", parent: "Sundry Debtors", balance: 900 },
        { name: "Rent", parent: "Indirect Expenses", balance: 500 },
      ]),
    );
    expect(f).toEqual([]);
  });

  it("does not judge groups with no expected side", () => {
    expect(wrongSideBalance(input([{ name: "Odd", parent: "Unknown Group", balance: -1 }]))).toEqual([]);
  });

  it("does not double-report a bank, which overdrawnBank owns", () => {
    expect(wrongSideBalance(input([{ name: "HDFC", parent: "Bank Accounts", balance: -100 }]))).toEqual([]);
  });
});

describe("overdrawnBank", () => {
  it("flags a credit balance in Bank Accounts", () => {
    const f = overdrawnBank(input([{ name: "HDFC", parent: "Bank Accounts", balance: -75000 }]));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("overdrawn_bank");
    expect(f[0].severity).toBe("warning");
    expect(f[0].amount).toBe(75000);
  });

  it("is silent on Bank OD, where a credit balance is expected", () => {
    expect(overdrawnBank(input([{ name: "OD A/c", parent: "Bank OD A/c", balance: -75000 }]))).toEqual([]);
  });

  it("is silent on a positive bank balance", () => {
    expect(overdrawnBank(input([{ name: "HDFC", parent: "Bank Accounts", balance: 75000 }]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/checks-warning.test.ts`
Expected: FAIL — `overdrawnBank is not a function` (or a missing export error)

- [ ] **Step 3: Write `src/checks/wrongSideBalance.ts`**

```ts
import { findingId, sideOf, type Check, type GroupRole, type Side } from "../types.js";

/** Bank is deliberately absent: overdrawnBank owns it, with OD-aware wording. */
const EXPECTED_SIDE: Partial<Record<GroupRole, Side>> = {
  debtor: "Dr",
  creditor: "Cr",
  expense: "Dr",
  income: "Cr",
  stock: "Dr",
};

export const wrongSideBalance: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    const expected = EXPECTED_SIDE[input.roleOf(row.parent)];
    if (!expected) continue;
    const side = sideOf(row.balance);
    if (!side || side === expected) continue;
    n += 1;
    out.push({
      id: findingId("wrong_side_balance", n),
      check: "wrong_side_balance" as const,
      severity: "warning" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side,
      expected,
      detail:
        `${row.name} in ${row.parent} carries a ${side === "Dr" ? "debit" : "credit"} balance of ` +
        `${Math.abs(row.balance).toFixed(2)} as of ${input.asOnDate}, where a ` +
        `${expected === "Dr" ? "debit" : "credit"} balance is expected`,
    });
  }
  return out;
};
```

- [ ] **Step 4: Write `src/checks/overdrawnBank.ts`**

```ts
import { findingId, sideOf, type Check } from "../types.js";

export const overdrawnBank: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (input.roleOf(row.parent) !== "bank") continue;
    if (sideOf(row.balance) !== "Cr") continue;
    n += 1;
    out.push({
      id: findingId("overdrawn_bank", n),
      check: "overdrawn_bank" as const,
      severity: "warning" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side: "Cr" as const,
      expected: "Dr" as const,
      detail:
        `${row.name} is overdrawn by ${Math.abs(row.balance).toFixed(2)} as of ${input.asOnDate}. ` +
        `Correct if an overdraft facility exists; otherwise the account is misposted or unreconciled`,
    });
  }
  return out;
};
```

- [ ] **Step 5: Extend `src/checks/index.ts`**

Replace the file with:

```ts
import type { Check, Finding, ReviewInput } from "../types.js";
import { negativeCash } from "./negativeCash.js";
import { outOfBalance } from "./outOfBalance.js";
import { overdrawnBank } from "./overdrawnBank.js";
import { suspenseBalance } from "./suspenseBalance.js";
import { wrongSideBalance } from "./wrongSideBalance.js";

export { negativeCash, outOfBalance, overdrawnBank, suspenseBalance, wrongSideBalance };

export const ALL_CHECKS: Check[] = [
  outOfBalance,
  suspenseBalance,
  negativeCash,
  wrongSideBalance,
  overdrawnBank,
];

export function runChecks(input: ReviewInput): Finding[] {
  return ALL_CHECKS.flatMap((check) => check(input));
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run test/checks-warning.test.ts test/checks-critical.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/checks test/checks-warning.test.ts
git commit -m "feat: wrong-side and overdrawn-bank checks"
```

---

### Task 6: Review checks — ledger under primary group, dormant balance

**Files:**
- Create: `src/checks/ledgerUnderPrimaryGroup.ts`, `src/checks/dormantBalance.ts`
- Modify: `src/checks/index.ts`
- Test: `test/checks-review.test.ts`

**Interfaces:**
- Consumes: `ReviewInput.isPrimaryGroup`, `ReviewInput.ledgers` (`LedgerMaster[]`)
- Produces: `ledgerUnderPrimaryGroup: Check`, `dormantBalance: Check`; both appended to `ALL_CHECKS`

- [ ] **Step 1: Write the failing test**

`test/checks-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dormantBalance, ledgerUnderPrimaryGroup } from "../src/checks/index.js";
import type { LedgerMaster, ReviewInput, TbRow } from "../src/types.js";

const PRIMARY = new Set(["Current Assets", "Current Liabilities", "Indirect Expenses"]);

function input(rows: TbRow[], ledgers: LedgerMaster[] = []): ReviewInput {
  return {
    asOnDate: "20260331",
    rows,
    ledgers,
    totalDebit: 0,
    totalCredit: 0,
    roleOf: () => "other",
    isPrimaryGroup: (g) => PRIMARY.has(g),
  };
}

describe("ledgerUnderPrimaryGroup", () => {
  it("flags a ledger parked directly under a primary group", () => {
    const f = ledgerUnderPrimaryGroup(input([{ name: "Odds", parent: "Current Assets", balance: 10 }]));
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe("ledger_under_primary_group");
    expect(f[0].severity).toBe("review");
  });

  it("is silent for a ledger under a proper sub-group", () => {
    expect(
      ledgerUnderPrimaryGroup(input([{ name: "Acme", parent: "Sundry Debtors", balance: 10 }])),
    ).toEqual([]);
  });

  it("flags even a nil-balance ledger, because this is a master defect", () => {
    const f = ledgerUnderPrimaryGroup(input([{ name: "Odds", parent: "Current Assets", balance: 0 }]));
    expect(f).toHaveLength(1);
  });
});

describe("dormantBalance", () => {
  const ledgers: LedgerMaster[] = [
    { name: "Old Advance", parent: "Sundry Debtors", openingBalance: 25000, closingBalance: 25000 },
    { name: "Active Party", parent: "Sundry Debtors", openingBalance: 25000, closingBalance: 31000 },
    { name: "Moved By One", parent: "Sundry Debtors", openingBalance: 25000, closingBalance: 25001 },
    { name: "Nil Both Ends", parent: "Sundry Debtors", openingBalance: 0, closingBalance: 0 },
  ];

  it("flags a non-zero balance that never moved", () => {
    const f = dormantBalance(input([], ledgers));
    expect(f.map((x) => x.ledger)).toEqual(["Old Advance"]);
    expect(f[0].severity).toBe("review");
    expect(f[0].amount).toBe(25000);
  });

  it("does not flag an account that moved by one rupee", () => {
    const f = dormantBalance(input([], ledgers));
    expect(f.map((x) => x.ledger)).not.toContain("Moved By One");
  });

  it("does not flag an account with no balance at either end", () => {
    const f = dormantBalance(input([], ledgers));
    expect(f.map((x) => x.ledger)).not.toContain("Nil Both Ends");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/checks-review.test.ts`
Expected: FAIL — missing exports

- [ ] **Step 3: Write `src/checks/ledgerUnderPrimaryGroup.ts`**

```ts
import { findingId, sideOf, type Check } from "../types.js";

export const ledgerUnderPrimaryGroup: Check = (input) => {
  const out = [];
  let n = 0;
  for (const row of input.rows) {
    if (!input.isPrimaryGroup(row.parent)) continue;
    n += 1;
    out.push({
      id: findingId("ledger_under_primary_group", n),
      check: "ledger_under_primary_group" as const,
      severity: "review" as const,
      ledger: row.name,
      group: row.parent,
      amount: Math.abs(row.balance),
      side: sideOf(row.balance),
      expected: null,
      detail:
        `${row.name} sits directly under the primary group ${row.parent} rather than a sub-group. ` +
        `Balances are unaffected, but it is grouped wrongly in every report`,
    });
  }
  return out;
};
```

- [ ] **Step 4: Write `src/checks/dormantBalance.ts`**

```ts
import { findingId, sideOf, ZERO_TOLERANCE, type Check } from "../types.js";

export const dormantBalance: Check = (input) => {
  const out = [];
  let n = 0;
  for (const l of input.ledgers) {
    if (Math.abs(l.openingBalance) < ZERO_TOLERANCE) continue;
    if (Math.abs(l.closingBalance - l.openingBalance) >= ZERO_TOLERANCE) continue;
    n += 1;
    out.push({
      id: findingId("dormant_balance", n),
      check: "dormant_balance" as const,
      severity: "review" as const,
      ledger: l.name,
      group: l.parent,
      amount: Math.abs(l.closingBalance),
      side: sideOf(l.closingBalance),
      expected: null,
      detail:
        `${l.name} opened and closed at ${Math.abs(l.closingBalance).toFixed(2)} with no movement ` +
        `in the period; a stale advance or an old balance carried forward unreviewed`,
    });
  }
  return out;
};
```

- [ ] **Step 5: Extend `src/checks/index.ts`**

Replace the file with:

```ts
import type { Check, Finding, ReviewInput } from "../types.js";
import { dormantBalance } from "./dormantBalance.js";
import { ledgerUnderPrimaryGroup } from "./ledgerUnderPrimaryGroup.js";
import { negativeCash } from "./negativeCash.js";
import { outOfBalance } from "./outOfBalance.js";
import { overdrawnBank } from "./overdrawnBank.js";
import { suspenseBalance } from "./suspenseBalance.js";
import { wrongSideBalance } from "./wrongSideBalance.js";

export {
  dormantBalance,
  ledgerUnderPrimaryGroup,
  negativeCash,
  outOfBalance,
  overdrawnBank,
  suspenseBalance,
  wrongSideBalance,
};

export const ALL_CHECKS: Check[] = [
  outOfBalance,
  suspenseBalance,
  negativeCash,
  wrongSideBalance,
  overdrawnBank,
  ledgerUnderPrimaryGroup,
  dormantBalance,
];

export function runChecks(input: ReviewInput): Finding[] {
  return ALL_CHECKS.flatMap((check) => check(input));
}
```

- [ ] **Step 6: Run the whole check suite**

Run: `npx vitest run test/checks-critical.test.ts test/checks-warning.test.ts test/checks-review.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/checks test/checks-review.test.ts
git commit -m "feat: grouping and dormancy review checks"
```

---

### Task 7: Downstream MCP client

**Files:**
- Create: `src/downstream.ts`, `src/config.ts`
- Create: `test/fixtures/downstream-fake.ts`, `test/fixtures/tally-responses.json`
- Test: `test/downstream.test.ts`

**Interfaces:**
- Consumes: `TbRow`, `GroupNode`, `LedgerMaster` from `src/types.js`
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): GatewayConfig`
  - `interface GatewayConfig { downstreamCommand: string; downstreamArgs: string[]; reportDir: string; defaultCompany?: string; dumpVault: boolean; }`
  - `connectDownstream(cfg: GatewayConfig): Promise<Downstream>`
  - `interface Downstream { callRaw(tool: string, args: Record<string, unknown>): Promise<string>; listCompanies(): Promise<string[]>; trialBalance(company: string | undefined, asOnDate: string): Promise<{ rows: TbRow[]; totalDebit: number; totalCredit: number }>; groups(company?: string): Promise<GroupNode[]>; ledgers(company?: string): Promise<LedgerMaster[]>; ledgerVouchers(company: string | undefined, ledgerName: string, fromDate: string, toDate: string): Promise<unknown[]>; close(): Promise<void>; }`
  - `parseTrialBalance(text: string)`, `parseGroups(text: string)`, `parseLedgers(text: string)` — exported for tests

- [ ] **Step 1: Record the fixture**

`test/fixtures/tally-responses.json` holds one sanitized response per downstream tool. Real shapes, invented names. Create it by hand from the shapes below; replace with real recorded output later if the shapes drift.

```json
{
  "tally_list_companies": "[{\"name\":\"Demo Traders Pvt Ltd\"}]",
  "tally_trial_balance": "{\"asOnDate\":\"20260331\",\"rowCount\":5,\"totalDebit\":\"175000.00\",\"totalCredit\":\"174000.00\",\"balanced\":false,\"rows\":[{\"name\":\"acme traders\",\"parent\":\"Sundry Creditors\",\"balance\":\"41250.00\",\"debit\":\"41250.00\"},{\"name\":\"hdfc 50200012345678\",\"parent\":\"Bank Accounts\",\"balance\":\"-75000.00\",\"credit\":\"75000.00\"},{\"name\":\"petty cash\",\"parent\":\"Cash-in-Hand\",\"balance\":\"-250.00\",\"credit\":\"250.00\"},{\"name\":\"suspense\",\"parent\":\"Suspense A/c\",\"balance\":\"5000.00\",\"debit\":\"5000.00\"},{\"name\":\"rent\",\"parent\":\"Indirect Expenses\",\"balance\":\"53500.00\",\"debit\":\"53500.00\"}]}",
  "tally_get_groups": "[{\"name\":\"Current Assets\",\"parent\":\"\"},{\"name\":\"Current Liabilities\",\"parent\":\"\"},{\"name\":\"Indirect Expenses\",\"parent\":\"\"},{\"name\":\"Suspense A/c\",\"parent\":\"\"},{\"name\":\"Sundry Creditors\",\"parent\":\"Current Liabilities\"},{\"name\":\"Bank Accounts\",\"parent\":\"Current Assets\"},{\"name\":\"Cash-in-Hand\",\"parent\":\"Current Assets\"}]",
  "tally_get_ledgers": "[{\"name\":\"Acme Traders\",\"parent\":\"Sundry Creditors\",\"openingBalance\":\"41250.00\",\"closingBalance\":\"41250.00\"},{\"name\":\"HDFC 50200012345678\",\"parent\":\"Bank Accounts\",\"openingBalance\":\"-75000.00\",\"closingBalance\":\"-75000.00\"},{\"name\":\"Rent\",\"parent\":\"Indirect Expenses\",\"openingBalance\":\"0.00\",\"closingBalance\":\"53500.00\"}]",
  "tally_get_ledger_vouchers": "[{\"date\":\"20260115\",\"voucherNumber\":\"PUR/0012\",\"counterparty\":\"Acme Traders\",\"amount\":\"41250.00\",\"side\":\"Dr\"}]"
}
```

**Note on names:** the downstream lowercases `name` in trial balance rows but not in `tally_get_ledgers`. The gateway must match rows to ledger masters case-insensitively.

- [ ] **Step 2: Write the fake downstream**

`test/fixtures/downstream-fake.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Downstream } from "../../src/downstream.js";
import {
  makeDownstream,
  type RawCaller,
} from "../../src/downstream.js";

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL("./tally-responses.json", import.meta.url)), "utf8"),
) as Record<string, string>;

export function fakeDownstream(
  overrides: Record<string, string> = {},
): Downstream & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const caller: RawCaller = async (tool, args) => {
    calls.push({ tool, args });
    const body = overrides[tool] ?? raw[tool];
    if (body === undefined) throw new Error(`fake downstream has no fixture for ${tool}`);
    return body;
  };
  return Object.assign(makeDownstream(caller, async () => {}), { calls });
}
```

- [ ] **Step 3: Write the failing test**

`test/downstream.test.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/downstream.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 5: Write `src/config.ts`**

```ts
export interface GatewayConfig {
  downstreamCommand: string;
  downstreamArgs: string[];
  reportDir: string;
  defaultCompany?: string;
  dumpVault: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const downstreamCommand = env.TALLY_MCP_COMMAND;
  if (!downstreamCommand) {
    throw new Error(
      "TALLY_MCP_COMMAND is required: the command that starts tally_prime_mcp_server",
    );
  }
  const reportDir = env.TALLY_AGENT_REPORT_DIR;
  if (!reportDir) {
    throw new Error(
      "TALLY_AGENT_REPORT_DIR is required and must point outside the harness working directory",
    );
  }
  return {
    downstreamCommand,
    downstreamArgs: (env.TALLY_MCP_ARGS ?? "").split(" ").filter(Boolean),
    reportDir,
    defaultCompany: env.TALLY_DEFAULT_COMPANY || undefined,
    dumpVault: env.TALLY_AGENT_DUMP_VAULT === "1",
  };
}
```

- [ ] **Step 6: Write `src/downstream.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GatewayConfig } from "./config.js";
import type { GroupNode, LedgerMaster, TbRow } from "./types.js";

export type RawCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

export interface Downstream {
  callRaw(tool: string, args: Record<string, unknown>): Promise<string>;
  listCompanies(): Promise<string[]>;
  trialBalance(
    company: string | undefined,
    asOnDate: string,
  ): Promise<{ rows: TbRow[]; totalDebit: number; totalCredit: number }>;
  groups(company?: string): Promise<GroupNode[]>;
  ledgers(company?: string): Promise<LedgerMaster[]>;
  ledgerVouchers(
    company: string | undefined,
    ledgerName: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]>;
  close(): Promise<void>;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const withCompany = (
  args: Record<string, unknown>,
  company: string | undefined,
): Record<string, unknown> => (company ? { ...args, company } : args);

export function makeDownstream(call: RawCaller, close: () => Promise<void>): Downstream {
  return {
    callRaw: call,

    async listCompanies() {
      const raw = JSON.parse(await call("tally_list_companies", {})) as Array<{
        name?: string;
      }>;
      return raw.map((c) => String(c.name ?? "")).filter(Boolean);
    },

    async trialBalance(company, asOnDate) {
      const raw = JSON.parse(
        await call("tally_trial_balance", withCompany({ asOnDate }, company)),
      ) as {
        totalDebit: string;
        totalCredit: string;
        rows: Array<{ name: string; parent: string; balance: string }>;
      };
      return {
        totalDebit: num(raw.totalDebit),
        totalCredit: num(raw.totalCredit),
        rows: raw.rows.map((r) => ({
          name: String(r.name ?? ""),
          parent: String(r.parent ?? ""),
          balance: num(r.balance),
        })),
      };
    },

    async groups(company) {
      const raw = JSON.parse(
        await call("tally_get_groups", withCompany({}, company)),
      ) as Array<{ name: string; parent?: string }>;
      return raw.map((g) => ({
        name: String(g.name ?? ""),
        parent: String(g.parent ?? ""),
      }));
    },

    async ledgers(company) {
      const raw = JSON.parse(
        await call("tally_get_ledgers", withCompany({}, company)),
      ) as Array<{
        name: string;
        parent?: string;
        openingBalance?: string;
        closingBalance?: string;
      }>;
      return raw.map((l) => ({
        name: String(l.name ?? ""),
        parent: String(l.parent ?? ""),
        openingBalance: num(l.openingBalance),
        closingBalance: num(l.closingBalance),
      }));
    },

    async ledgerVouchers(company, ledgerName, fromDate, toDate) {
      const text = await call(
        "tally_get_ledger_vouchers",
        withCompany({ ledgerName, fromDate, toDate }, company),
      );
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    },

    close,
  };
}

export async function connectDownstream(cfg: GatewayConfig): Promise<Downstream> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Never inherit the downstream write switch.
    if (k === "TALLY_ALLOW_WRITES") continue;
    if (v !== undefined) env[k] = v;
  }

  const transport = new StdioClientTransport({
    command: cfg.downstreamCommand,
    args: cfg.downstreamArgs,
    env,
  });
  const client = new Client({ name: "tally-agent", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const call: RawCaller = async (tool, args) => {
    const res = (await client.callTool({ name: tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (res.isError) throw new Error(`downstream ${tool} failed: ${text}`);
    return text;
  };

  return makeDownstream(call, () => client.close());
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `npx vitest run test/downstream.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/downstream.ts test/downstream.test.ts test/fixtures
git commit -m "feat: downstream MCP client with typed parsing and recorded fixtures"
```

---

### Task 8: Review orchestration

**Files:**
- Create: `src/review.ts`, `src/overrides.ts`, `config/overrides.json`
- Test: `test/review.test.ts`

**Interfaces:**
- Consumes: `Downstream`, `buildClassifier`, `runChecks`, `maskFinding`, `createVault`
- Produces:
  - `loadOverrides(path: string): Overrides` (returns `EMPTY_OVERRIDES` if the file is absent)
  - `createSession(d: Downstream, overrides: Overrides): Session`
  - `interface Session { review(company: string | undefined, asOnDate: string): Promise<ReviewResult>; ledgerActivity(findingId: string, from: string, to: string): Promise<unknown[]>; vault: Vault; }`
  - `interface ReviewResult { asOnDate: string; company?: string; totalDebit: number; totalCredit: number; balanced: boolean; counts: Record<Severity, number>; findings: Finding[]; }`

- [ ] **Step 1: Write the failing test**

`test/review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

describe("review", () => {
  it("returns findings for the fixture company", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review("Demo Traders Pvt Ltd", "20260331");
    expect(r.balanced).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.counts.critical).toBeGreaterThan(0);
  });

  it("masks the creditor but not its group", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const wrongSide = r.findings.find((f) => f.check === "wrong_side_balance");
    expect(wrongSide?.ledger).toMatch(/^Creditor \d+$/);
    expect(wrongSide?.group).toBe("Sundry Creditors");
  });

  it("never leaks the bank account number in any finding", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    expect(JSON.stringify(r)).not.toContain("50200012345678");
  });

  it("leaves a nominal ledger readable", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const suspense = r.findings.find((f) => f.check === "suspense_balance");
    expect(suspense?.ledger).toBe("suspense");
  });

  it("fetches the trial balance once per review", async () => {
    const d = fakeDownstream();
    const s = createSession(d, EMPTY_OVERRIDES);
    await s.review(undefined, "20260331");
    expect(d.calls.filter((c) => c.tool === "tally_trial_balance")).toHaveLength(1);
  });

  it("resolves a finding id back to the real ledger when drilling in", async () => {
    const d = fakeDownstream();
    const s = createSession(d, EMPTY_OVERRIDES);
    const r = await s.review(undefined, "20260331");
    const wrongSide = r.findings.find((f) => f.check === "wrong_side_balance")!;
    await s.ledgerActivity(wrongSide.id, "20250401", "20260331");
    const call = d.calls.find((c) => c.tool === "tally_get_ledger_vouchers");
    expect(call?.args.ledgerName).toBe("acme traders");
  });

  it("rejects an unknown finding id", async () => {
    const s = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    await s.review(undefined, "20260331");
    await expect(s.ledgerActivity("TB-999-1", "20250401", "20260331")).rejects.toThrow(
      /unknown finding/i,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/review.test.ts`
Expected: FAIL — `Cannot find module '../src/review.js'`

- [ ] **Step 3: Write `src/overrides.ts`**

```ts
import { readFileSync } from "node:fs";
import { EMPTY_OVERRIDES, type Overrides } from "./classify.js";

export function loadOverrides(path: string): Overrides {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return EMPTY_OVERRIDES;
  }
  const raw = JSON.parse(text) as Partial<Overrides>;
  return {
    forceMaskLedgers: raw.forceMaskLedgers ?? [],
    forceClearLedgers: raw.forceClearLedgers ?? [],
    forceMaskGroups: raw.forceMaskGroups ?? [],
    forceClearGroups: raw.forceClearGroups ?? [],
  };
}
```

- [ ] **Step 4: Write `config/overrides.json`**

```json
{
  "forceMaskLedgers": [],
  "forceClearLedgers": [],
  "forceMaskGroups": [],
  "forceClearGroups": []
}
```

- [ ] **Step 5: Write `src/review.ts`**

```ts
import { buildClassifier, type Overrides } from "./classify.js";
import { runChecks } from "./checks/index.js";
import type { Downstream } from "./downstream.js";
import { maskFinding } from "./mask.js";
import { createVault, type Vault } from "./vault.js";
import { TOTALS_TOLERANCE, type Finding, type Severity } from "./types.js";

export interface ReviewResult {
  asOnDate: string;
  company?: string;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  counts: Record<Severity, number>;
  findings: Finding[];
}

export interface Session {
  review(company: string | undefined, asOnDate: string): Promise<ReviewResult>;
  ledgerActivity(findingId: string, fromDate: string, toDate: string): Promise<unknown[]>;
  vault: Vault;
}

export function createSession(d: Downstream, overrides: Overrides): Session {
  const vault = createVault();
  /** finding id -> real ledger name, for drill-down without the model holding it. */
  const realLedgerByFinding = new Map<string, string>();
  let lastCompany: string | undefined;

  async function review(
    company: string | undefined,
    asOnDate: string,
  ): Promise<ReviewResult> {
    lastCompany = company;
    const [tb, groups, ledgers] = await Promise.all([
      d.trialBalance(company, asOnDate),
      d.groups(company),
      d.ledgers(company),
    ]);

    const classifier = buildClassifier(groups, overrides);

    const raw = runChecks({
      asOnDate,
      rows: tb.rows,
      ledgers,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      roleOf: (g) => classifier.role(g),
      isPrimaryGroup: (g) => classifier.isPrimaryGroup(g),
    });

    const findings = raw.map((f) => {
      if (f.ledger) realLedgerByFinding.set(f.id, f.ledger);
      return maskFinding(f, classifier, vault);
    });

    const counts: Record<Severity, number> = { critical: 0, warning: 0, review: 0 };
    for (const f of findings) counts[f.severity] += 1;

    return {
      asOnDate,
      company,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      balanced: Math.abs(tb.totalDebit - tb.totalCredit) <= TOTALS_TOLERANCE,
      counts,
      findings,
    };
  }

  async function ledgerActivity(
    findingId: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]> {
    const real = realLedgerByFinding.get(findingId);
    if (!real) throw new Error(`unknown finding id: ${findingId}`);
    return d.ledgerVouchers(lastCompany, real, fromDate, toDate);
  }

  return { review, ledgerActivity, vault };
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run test/review.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/review.ts src/overrides.ts config/overrides.json test/review.test.ts
git commit -m "feat: review session with masked findings and id-keyed drill-down"
```

---

### Task 9: Report writer and audit log

**Files:**
- Create: `src/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `Vault`, `Finding`, `demaskText`
- Produces:
  - `writeReport(opts: WriteReportOptions): Promise<{ markdownPath: string; csvPath: string }>`
  - `interface WriteReportOptions { reportDir: string; company: string; asOnDate: string; markdown: string; findings: Finding[]; vault: Vault; }`
  - `appendAudit(reportDir: string, sessionId: string, entry: AuditEntry): Promise<void>`
  - `interface AuditEntry { at: string; tool: string; args: Record<string, unknown>; rows: number; masked: number; }`
  - `writeVaultDump(reportDir: string, sessionId: string, vault: Vault): Promise<string>`
  - `findingsCsv(findings: Finding[], vault: Vault): string`

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, findingsCsv, writeReport, writeVaultDump } from "../src/report.js";
import { createVault } from "../src/vault.js";
import type { Finding } from "../src/types.js";

function fixture() {
  const vault = createVault();
  const alias = vault.pseudonym("Acme Traders", "creditor");
  const findings: Finding[] = [
    {
      id: "TB-004-1",
      check: "wrong_side_balance",
      severity: "warning",
      ledger: alias,
      group: "Sundry Creditors",
      amount: 41250,
      side: "Dr",
      expected: "Cr",
      detail: `${alias} carries a debit balance`,
    },
  ];
  return { vault, findings, alias };
}

describe("findingsCsv", () => {
  it("writes real names, not aliases", () => {
    const { vault, findings } = fixture();
    const csv = findingsCsv(findings, vault);
    expect(csv).toContain("Acme Traders");
    expect(csv).not.toContain("Creditor 1");
  });

  it("quotes fields containing commas", () => {
    const { vault, findings } = fixture();
    findings[0].detail = "one, two";
    expect(findingsCsv(findings, vault)).toContain('"one, two"');
  });

  it("starts with a header row", () => {
    const { vault, findings } = fixture();
    expect(findingsCsv(findings, vault).split("\n")[0]).toBe(
      "id,check,severity,ledger,group,amount,side,expected,detail",
    );
  });
});

describe("writeReport", () => {
  it("de-masks the narrative on the way to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault, findings, alias } = fixture();
    const { markdownPath } = await writeReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: `# Review\n\n${alias} needs attention.`,
      findings,
      vault,
    });
    const body = readFileSync(markdownPath, "utf8");
    expect(body).toContain("Acme Traders needs attention.");
    expect(body).not.toContain("Creditor 1");
  });

  it("returns both artifact paths and names them by company and date", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault, findings } = fixture();
    const paths = await writeReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: "# Review",
      findings,
      vault,
    });
    expect(paths.markdownPath).toMatch(/trial-balance-review-demo-traders-pvt-ltd-20260331\.md$/);
    expect(paths.csvPath).toMatch(/findings-demo-traders-pvt-ltd-20260331\.csv$/);
  });
});

describe("appendAudit", () => {
  it("appends one JSON line per call, into this session's own file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    await appendAudit(dir, "20260331T100000Z", { at: "2026-03-31T10:00:00Z", tool: "tb_review", args: {}, rows: 5, masked: 2 });
    await appendAudit(dir, "20260331T100000Z", { at: "2026-03-31T10:00:05Z", tool: "tb_write_report", args: {}, rows: 0, masked: 0 });
    const lines = readFileSync(join(dir, "session-20260331T100000Z.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("tb_review");
  });
});

describe("writeVaultDump", () => {
  it("writes the mapping only when asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault } = fixture();
    const path = await writeVaultDump(dir, "20260331T100000Z", vault);
    const dump = JSON.parse(readFileSync(path, "utf8")) as Array<{ real: string; alias: string }>;
    expect(dump).toEqual([{ real: "Acme Traders", alias: "Creditor 1" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL — `Cannot find module '../src/report.js'`

- [ ] **Step 3: Write `src/report.ts`**

```ts
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demaskText } from "./mask.js";
import type { Finding } from "./types.js";
import type { Vault } from "./vault.js";

export interface WriteReportOptions {
  reportDir: string;
  company: string;
  asOnDate: string;
  markdown: string;
  findings: Finding[];
  vault: Vault;
}

export interface AuditEntry {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  rows: number;
  masked: number;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const csvField = (v: unknown): string => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function findingsCsv(findings: Finding[], vault: Vault): string {
  const header = "id,check,severity,ledger,group,amount,side,expected,detail";
  const rows = findings.map((f) =>
    [
      f.id,
      f.check,
      f.severity,
      demaskText(f.ledger, vault),
      f.group,
      f.amount.toFixed(2),
      f.side ?? "",
      f.expected ?? "",
      demaskText(f.detail, vault),
    ]
      .map(csvField)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export async function writeReport(
  opts: WriteReportOptions,
): Promise<{ markdownPath: string; csvPath: string }> {
  await mkdir(opts.reportDir, { recursive: true });
  const stem = `${slug(opts.company)}-${opts.asOnDate}`;
  const markdownPath = join(opts.reportDir, `trial-balance-review-${stem}.md`);
  const csvPath = join(opts.reportDir, `findings-${stem}.csv`);

  await writeFile(markdownPath, demaskText(opts.markdown, opts.vault), "utf8");
  await writeFile(csvPath, findingsCsv(opts.findings, opts.vault), "utf8");

  return { markdownPath, csvPath };
}

export async function appendAudit(
  reportDir: string,
  sessionId: string,
  entry: AuditEntry,
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  await appendFile(
    join(reportDir, `session-${sessionId}.jsonl`),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

/**
 * The vault mapping reverses every other protection, so this is written only
 * when TALLY_AGENT_DUMP_VAULT=1 — see the design document, section 7.
 */
export async function writeVaultDump(
  reportDir: string,
  sessionId: string,
  vault: Vault,
): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `vault-${sessionId}.json`);
  await writeFile(path, JSON.stringify(vault.entries(), null, 2), "utf8");
  return path;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report.ts test/report.test.ts
git commit -m "feat: de-masking report writer, findings CSV and audit log"
```

---

### Task 10: The MCP server and its four tools

**Files:**
- Create: `src/index.ts`
- Test: `test/server-tools.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9
- Produces:
  - `type ToolRegistrar = (name: string, description: string, schema: Record<string, unknown>, handler: (args: any) => Promise<string>) => void`
  - `type ToolsConfig = Pick<GatewayConfig, "reportDir"> & Partial<Pick<GatewayConfig, "defaultCompany" | "dumpVault">>`
  - `newSessionId(now?: Date): string`
  - `registerTools(register: ToolRegistrar, session: Session, cfg: ToolsConfig, sessionId?: string): void` — exported so the test can register against a stub registrar without stdio

- [ ] **Step 1: Write the failing test**

`test/server-tools.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

function harness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _desc, _schema, handler) => {
    tools.set(name, handler);
  };
  const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "tally-agent-")) };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  return { tools, session, cfg };
}

describe("tool surface", () => {
  it("exposes exactly the four approved tools", () => {
    const { tools } = harness();
    expect([...tools.keys()].sort()).toEqual([
      "tb_ledger_activity",
      "tb_list_companies",
      "tb_review",
      "tb_write_report",
    ]);
  });

  it("does not expose the ledger master tool that returns bank and address details", () => {
    const { tools } = harness();
    expect(tools.has("tally_get_ledger")).toBe(false);
  });
});

describe("tb_review", () => {
  it("returns masked findings as JSON", async () => {
    const { tools } = harness();
    const out = await tools.get("tb_review")!({ asOnDate: "20260331" });
    const parsed = JSON.parse(out);
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(out).not.toContain("50200012345678");
  });
});

describe("tb_write_report", () => {
  it("writes both artifacts and reports their paths", async () => {
    const { tools } = harness();
    await tools.get("tb_review")!({ asOnDate: "20260331", company: "Demo Traders Pvt Ltd" });
    const out = await tools.get("tb_write_report")!({
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: "# Review",
    });
    const parsed = JSON.parse(out);
    expect(parsed.markdownPath).toMatch(/\.md$/);
    expect(parsed.csvPath).toMatch(/\.csv$/);
  });

  it("refuses when no review has been run", async () => {
    const { tools } = harness();
    await expect(
      tools.get("tb_write_report")!({
        company: "Demo",
        asOnDate: "20260331",
        markdown: "# Review",
      }),
    ).rejects.toThrow(/run tb_review first/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/server-tools.test.ts`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 3: Add `listCompanies` to `Session` first, so `src/index.ts` compiles**

`src/review.ts` — add to the `Session` interface and the returned object:

```ts
// interface Session, add:
  listCompanies(): Promise<string[]>;

// createSession return, add:
    listCompanies: () => d.listCompanies(),
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type GatewayConfig } from "./config.js";
import { connectDownstream } from "./downstream.js";
import { loadOverrides } from "./overrides.js";
import { appendAudit, writeReport, writeVaultDump } from "./report.js";
import { createSession, type ReviewResult, type Session } from "./review.js";

export type ToolRegistrar = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<string>,
) => void;

export type ToolsConfig = Pick<GatewayConfig, "reportDir"> &
  Partial<Pick<GatewayConfig, "defaultCompany" | "dumpVault">>;

/** One id per gateway process, naming this session's audit and vault files. */
export function newSessionId(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function registerTools(
  register: ToolRegistrar,
  session: Session,
  cfg: ToolsConfig,
  sessionId: string = newSessionId(),
): void {
  let last: ReviewResult | undefined;

  const audit = (tool: string, args: Record<string, unknown>, rows: number, masked: number) =>
    appendAudit(cfg.reportDir, sessionId, {
      at: new Date().toISOString(),
      tool,
      args,
      rows,
      masked,
    });

  register(
    "tb_list_companies",
    "List the companies open in Tally.",
    {},
    async () => {
      const names = await sessionCompanies(session);
      await audit("tb_list_companies", {}, names.length, 0);
      return JSON.stringify({ companies: names }, null, 2);
    },
  );

  register(
    "tb_review",
    "Run the seven trial balance sanity checks as of a date and return masked findings. " +
      "Party ledgers appear as pseudonyms such as 'Creditor 3'; nominal accounts appear by name. " +
      "Drill into a finding with tb_ledger_activity using its id.",
    {
      asOnDate: z.string().describe("As-on date, YYYYMMDD"),
      company: z.string().optional(),
    },
    async (args) => {
      const result = await session.review(args.company ?? cfg.defaultCompany, args.asOnDate);
      last = result;
      const masked = result.findings.filter((f) => /^\w+ \d+$/.test(f.ledger)).length;
      await audit("tb_review", args, result.findings.length, masked);
      return JSON.stringify(result, null, 2);
    },
  );

  register(
    "tb_ledger_activity",
    "Voucher-level context for one finding, by finding id. Returns masked rows.",
    {
      findingId: z.string(),
      fromDate: z.string().describe("YYYYMMDD"),
      toDate: z.string().describe("YYYYMMDD"),
    },
    async (args) => {
      const rows = await session.ledgerActivity(args.findingId, args.fromDate, args.toDate);
      await audit("tb_ledger_activity", args, rows.length, rows.length);
      return JSON.stringify(rows, null, 2);
    },
  );

  register(
    "tb_write_report",
    "Write the review report and findings sheet to disk. Real names are restored on write; " +
      "compose the narrative using the pseudonyms you were given.",
    {
      company: z.string(),
      asOnDate: z.string().describe("YYYYMMDD"),
      markdown: z.string().describe("The narrative report, in masked terms"),
    },
    async (args) => {
      if (!last) throw new Error("run tb_review first: there are no findings to write");
      const paths = await writeReport({
        reportDir: cfg.reportDir,
        company: args.company,
        asOnDate: args.asOnDate,
        markdown: args.markdown,
        findings: last.findings,
        vault: session.vault,
      });
      await audit("tb_write_report", { company: args.company, asOnDate: args.asOnDate }, last.findings.length, 0);
      if (cfg.dumpVault) {
        await writeVaultDump(cfg.reportDir, sessionId, session.vault);
      }
      return JSON.stringify(paths, null, 2);
    },
  );
}

/** Kept separate so the tool handler stays synchronous to read. */
async function sessionCompanies(session: Session): Promise<string[]> {
  return session.listCompanies();
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const overrides = loadOverrides(new URL("../config/overrides.json", import.meta.url).pathname);
  const downstream = await connectDownstream(cfg);
  const session = createSession(downstream, overrides);

  const server = new McpServer(
    { name: "tally-agent", version: "0.1.0" },
    {
      instructions:
        "Read-only trial balance review for Tally Prime, with accounting PII masked. " +
        "Party ledgers, bank accounts, capital accounts and loan accounts appear as stable " +
        "pseudonyms such as 'Creditor 3'; nominal accounts appear by their real names. " +
        "You cannot see the trial balance itself, only the exceptions the checks found. " +
        "Drill into a finding by its id with tb_ledger_activity, never by ledger name. " +
        "Write the report with tb_write_report using the pseudonyms; real names are restored on write.",
    },
  );

  registerTools(
    (name, description, schema, handler) => {
      server.tool(name, description, schema as any, async (args: any) => {
        try {
          return { content: [{ type: "text" as const, text: await handler(args ?? {}) }] };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `ERROR: ${e.message}` }],
            isError: true,
          };
        }
      });
    },
    session,
    cfg,
  );

  await server.connect(new StdioServerTransport());
  console.error(`tally-agent gateway running; reports to ${cfg.reportDir}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/server-tools.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/review.ts test/server-tools.test.ts
git commit -m "feat: MCP gateway server with the four approved tools"
```

---

### Task 11: The leak test

**Files:**
- Create: `test/leak.test.ts`
- Modify: `test/fixtures/tally-responses.json` (add the secrets manifest)

**Interfaces:**
- Consumes: the whole tool surface via `registerTools`
- Produces: nothing importable; this is the build-failing guarantee

- [ ] **Step 1: Add a secrets manifest to the fixtures**

Create `test/fixtures/secrets.json` — every string that must never leave the gateway:

```json
[
  "Acme Traders",
  "HDFC 50200012345678",
  "50200012345678",
  "27AAAAA0000A1Z5"
]
```

- [ ] **Step 2: Write the leak test**

`test/leak.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

const SECRETS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/secrets.json", import.meta.url)), "utf8"),
) as string[];

/**
 * Every gateway tool, exercised, with every outbound payload checked against
 * the manifest. A tool added later without masking fails here.
 */
describe("no secret leaves the gateway", () => {
  it("holds across the whole tool surface", async () => {
    const tools = new Map<string, (args: any) => Promise<string>>();
    const registrar: ToolRegistrar = (name, _d, _s, handler) => tools.set(name, handler);
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    registerTools(registrar, session, {
      reportDir: mkdtempSync(join(tmpdir(), "tally-agent-leak-")),
    });

    // tb_review must run first: later tools depend on its findings.
    const outputs: string[] = [];
    outputs.push(await tools.get("tb_review")!({ asOnDate: "20260331" }));
    outputs.push(await tools.get("tb_list_companies")!({}));

    const review = JSON.parse(outputs[0]);
    for (const f of review.findings) {
      if (!f.ledger) continue;
      outputs.push(
        await tools.get("tb_ledger_activity")!({
          findingId: f.id,
          fromDate: "20250401",
          toDate: "20260331",
        }),
      );
    }

    outputs.push(
      await tools.get("tb_write_report")!({
        company: "Demo Traders Pvt Ltd",
        asOnDate: "20260331",
        markdown: "# Review\n\nSee findings.",
      }),
    );

    for (const out of outputs) {
      for (const secret of SECRETS) {
        expect(out, `secret "${secret}" leaked in a tool result`).not.toContain(secret);
      }
    }
  });

  it("covers every registered tool, so a new unmasked tool cannot slip in", async () => {
    const tools = new Map<string, unknown>();
    const registrar: ToolRegistrar = (name) => tools.set(name, true);
    registerTools(registrar, createSession(fakeDownstream(), EMPTY_OVERRIDES), {
      reportDir: mkdtempSync(join(tmpdir(), "tally-agent-leak-")),
    });
    expect([...tools.keys()].sort()).toEqual([
      "tb_ledger_activity",
      "tb_list_companies",
      "tb_review",
      "tb_write_report",
    ]);
  });
});
```

**Note:** `tb_ledger_activity` returns downstream voucher rows, which carry a real counterparty name in the fixture. Task 11 Step 3 is where that gets masked — the test above will fail until it is.

- [ ] **Step 3: Run it and watch it fail on ledger activity**

Run: `npx vitest run test/leak.test.ts`
Expected: FAIL — `secret "Acme Traders" leaked in a tool result`, from `tb_ledger_activity`

- [ ] **Step 4: Mask voucher rows in `src/review.ts`**

Replace `ledgerActivity` in `createSession` with:

```ts
  async function ledgerActivity(
    findingId: string,
    fromDate: string,
    toDate: string,
  ): Promise<unknown[]> {
    const real = realLedgerByFinding.get(findingId);
    if (!real) throw new Error(`unknown finding id: ${findingId}`);
    if (!classifier) throw new Error("run tb_review first: the group tree is not loaded");
    const rows = await d.ledgerVouchers(lastCompany, real, fromDate, toDate);
    return rows.map((row) => maskVoucherRow(row, classifier!, vault, groupOfLedger));
  }
```

Add above `createSession`, and hold `classifier` plus `groupOfLedger` as session state assigned during `review`:

```ts
/** Ledger-bearing fields in a downstream voucher row. */
const NAME_FIELDS = ["counterparty", "ledgerName", "partyName", "party"] as const;

function maskVoucherRow(
  row: unknown,
  classifier: Classifier,
  vault: Vault,
  groupOf: Map<string, string>,
): unknown {
  if (typeof row !== "object" || row === null) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of NAME_FIELDS) {
    const v = out[field];
    if (typeof v !== "string" || !v) continue;
    const group = groupOf.get(v.trim().toLowerCase()) ?? "";
    out[field] = maskLedgerName(v, group, classifier, vault);
  }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string") out[k] = scrubDigits(v as string);
  }
  return out;
}
```

Session state added inside `createSession`:

```ts
  let classifier: Classifier | undefined;
  const groupOfLedger = new Map<string, string>();
```

and inside `review`, after building the classifier:

```ts
    for (const l of ledgers) groupOfLedger.set(l.name.trim().toLowerCase(), l.parent);
    for (const r of tb.rows) groupOfLedger.set(r.name.trim().toLowerCase(), r.parent);
```

Imports to add at the top of `src/review.ts`:

```ts
import { buildClassifier, type Classifier, type Overrides } from "./classify.js";
import { maskFinding, maskLedgerName, scrubDigits } from "./mask.js";
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/leak.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add test/leak.test.ts test/fixtures/secrets.json src/review.ts
git commit -m "test: build-failing leak guarantee across the whole tool surface"
```

---

### Task 12: Harness configuration and README

**Files:**
- Create: `harness/claude-code.md`, `harness/opencode.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the built `dist/index.js`
- Produces: operator-facing setup, including the deny rule that Section 7.1 of the spec requires

- [ ] **Step 1: Write `harness/claude-code.md`**

````markdown
# Claude Code setup

Build first:

```bash
npm install && npm run build
```

Add the gateway as the **only** Tally-related MCP server. Do not also configure
`tally_prime_mcp_server` — the whole point is that the model cannot reach it.

`.mcp.json`:

```json
{
  "mcpServers": {
    "tally-agent": {
      "command": "node",
      "args": ["/absolute/path/to/tally-agent/dist/index.js"],
      "env": {
        "TALLY_MCP_COMMAND": "node",
        "TALLY_MCP_ARGS": "/absolute/path/to/tally_prime_mcp_server/dist/index.js",
        "TALLY_AGENT_REPORT_DIR": "/absolute/path/outside/this/project/tally-reports",
        "TALLY_DEFAULT_COMPANY": "Your Company Name"
      }
    }
  }
}
```

**The report directory must sit outside this project**, and the harness must be
denied read access to it. In `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(/absolute/path/outside/this/project/tally-reports/**)"]
  }
}
```

Reports are written de-masked. Without that deny rule the model can read back the
real names it was never given — see the design document, section 7.1.

## Asking for a review

> Review the trial balance as of 31 March 2026 and write it up.

The model calls `tb_review`, drills into anything unclear with `tb_ledger_activity`,
then calls `tb_write_report`. Read the Markdown and CSV in your report directory.
````

- [ ] **Step 2: Write `harness/opencode.md`**

````markdown
# opencode setup

Build first:

```bash
npm install && npm run build
```

`opencode.json` in your working directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "tally-agent": {
      "type": "local",
      "command": ["node", "/absolute/path/to/tally-agent/dist/index.js"],
      "environment": {
        "TALLY_MCP_COMMAND": "node",
        "TALLY_MCP_ARGS": "/absolute/path/to/tally_prime_mcp_server/dist/index.js",
        "TALLY_AGENT_REPORT_DIR": "/absolute/path/outside/this/project/tally-reports",
        "TALLY_DEFAULT_COMPANY": "Your Company Name"
      }
    }
  },
  "permission": {
    "read": { "/absolute/path/outside/this/project/tally-reports/**": "deny" }
  }
}
```

Same rule as Claude Code: the report directory sits outside the project and the
harness is denied read access to it. Reports are written de-masked.

**Verify the deny rule before your first real run** — opencode's permission schema
has changed between versions. Ask it to read a file in the report directory; it
must refuse.
````

- [ ] **Step 3: Rewrite the README status section**

Replace the `## Status` section of `README.md` with:

```markdown
## Status

Milestone 1 — read-only trial balance review — is implemented. See
[`docs/design/2026-09-07-trial-balance-review-design.md`](docs/design/2026-09-07-trial-balance-review-design.md)
for the design and [`harness/`](harness/) for setup.

The gateway masks party, bank, capital and loan ledger identities, runs seven
trial balance checks in code, and writes de-masked reports to a directory outside
the harness's reach.

Later milestones, in order: GST summary and mismatch; single-ledger scrutiny;
Excel read/write; the finalization checklist; and only then the guarded write path.
```

- [ ] **Step 4: Verify the build and suite one final time**

Run: `npm run build && npx vitest run && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add harness README.md
git commit -m "docs: harness setup for Claude Code and opencode"
```

---

## Verification against a live Tally

These steps need Tally Prime open with a real company loaded. They are **not**
automated tests and must be run by the operator before the milestone is called done.

- [ ] **Confirm the predefined group spellings.** Run the downstream `tally_get_groups`
      against a real company and compare every name against `CLEAR_ROOTS` and
      `PRIMARY_GROUPS` in `src/classify.ts`. A misspelt entry in `CLEAR_ROOTS` masks
      something that should be readable; a misspelt entry in `PRIMARY_GROUPS` silences
      check 6. Correct the constants and re-run the suite.
- [ ] **Confirm nothing sensitive is readable.** Run `tb_review` on the real company
      and read the raw result. No party name, no bank account number, no GSTIN.
- [ ] **Confirm the report is de-masked and unreachable.** Open the written Markdown:
      real names present. Then ask the harness to read that file: it must refuse.
- [ ] **Re-record the fixtures** from the real responses, sanitize the names, and
      commit them, so the recorded shapes match the live server.
