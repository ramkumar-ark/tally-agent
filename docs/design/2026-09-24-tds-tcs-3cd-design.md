# Winman 3CD "TDS TCS summary.xlsm" Filling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the five data sheets of the Winman Form 3CD clause 34 workbook (`TDS`, `TCS`, `Return details`, `Interest on TDS`, `Interest on TCS`) from the existing TDS review engine plus Tally books/day-book and the operator TDS template, and write a Winman-importable filled copy.

**Architecture:** Extend the landed PF/ESI 3CD round-trip foundation (`src/xlsm.ts`, `src/winman3cd.ts`) with two new leaf modules (`src/tcs-law.ts`, `src/tcs.ts`), one slice module (`src/tds3cd.ts`) that re-derives per-section/per-quarter rows from the TDS/TCS analyses, additive stamping inside `analyzeTds` (per-booking liable / rate provenance / per-deduction interest), a `write3cdTdsTcs` session writer mirroring `write3cdPfEsi`, and one new MCP tool `tb_write_3cd_tds_tcs`. The existing TDS review (`tb_tds_review`, `tb_write_tds_template`, the Winman TDS-summary parser, the TDS law table) is reused, not rebuilt.

**Tech Stack:** TypeScript (Node ESM, `tsc` build), vitest, zero new npm dependencies (xlsm writer is the landed third zip stack in `src/xlsm.ts`).

**Spec:** This report is the plan of record. The PF/ESI design `docs/design/2026-09-23-winman-3cd-pf-esi-design.md` is the foundation spec (protocol §2, verification §2.5); the TDS design `docs/design/2026-09-14-tds-compliance-review-design.md` governs the engine being sliced. **Task 0 commits this report as `docs/design/2026-09-24-tds-tcs-3cd-design.md`** so later tasks can cite it.

---

## Global Constraints

- **Privacy model (verbatim from the task brief):** pseudonyms to the model, real names only on disk write, operator files by path only. No real client name/PAN/TAN/GSTIN may appear in code, tests, fixtures, or this plan. The client workbook is referred to by its scratch copy `/tmp/opencode/tdstcs/source.xlsm` (original md5 `ce4f7248de5642fb4eb419ea138b7938`; the original path is in the captain's task brief, not repeated here).
- **TAN handling:** the operator TAN is held RAW in session memory only (same precedent as `panOf` in `tdsReview` — raw PANs already live in session memory, only outbound masking matters). It is written into the filled workbook on disk (that is the artifact's purpose) and never echoed in any error, log, or model-visible result object. Shape-validate with `/^[A-Z]{4}\d{5}[A-Z]$/`; errors cite the Settings row / JSON key, never the value.
- **Sign convention:** downstream of the gateway positive = debit (R-MCP-5); the single flip is `sideSign` in `src/downstream.ts`. Credits are negative. NEVER re-flip anywhere new.
- **Every outbound (model-visible) string passes `scrubDigits`/masking:** masked previews use `money()` (Indian grouping) from `src/format.ts` and `displayDate()`; no bare 6+-digit numbers, no bare `YYYYMMDD`.
- **No new npm dependencies.** `src/xlsm.ts` stays the third independent zip stack; do not share code with `src/xlsx.ts`/`src/xlsx-read.ts`.
- **Error contract for operator files:** sheet + Excel row + column letter + header, NEVER cell values (a stray cell can be a PAN/TAN). Duplicates within a file are rejected citing row numbers only.
- **FY 25-26 only.** All law tables carry an FY guard like the existing `TDS_SECTIONS`; new law facts follow the PF/ESI C-marker convention (see Task 1's `CONFIRM_POINTS` pattern in `src/pf-esi-law.ts`).
- **Backward compatibility:** every operator-file extension is optional; an old template/JSON parses to the same behavior as today (`EMPTY_TDS_OPERATOR` semantics). Missing sheets/columns are tolerated, never fatal.
- **Worktree discipline:** implementation happens on a branch; every task commits (`feat:`/`test:` per repo style, no agent co-author lines). Run `npm run typecheck` and `npx vitest run` before each commit.
- **The source workbook is read-only.** Never write into the Winman folder; always copy to the report/output directory first (`write3cdPfEsi` already works this way).

---

## Column sourcing map (the captain's explicit ask)

Which columns come from books (Tally live or day-book), which from an operator template, and which Winman computes itself.

### Sheet `TDS` (clause 34(a); row-2 keys `DEDUCTOR TAN TDS NATUREOFPAYMENT TOTALPAYMENTS TDSSUMLIABLE TDSATRATESUMLIABLE TDSATRATETDS TDSATMINRATESUMLIABLE TDSATMINRATETDS TDSDEDUCTED`)

| Col | Key | Human header | Source |
|---|---|---|---|
| A | DEDUCTOR | Deductor / Branch / Division | **Session company name** (`TdsReviewResult.company` precedent — travels plainly) |
| B | TAN | TAN | **Operator** (new Settings `TAN` row / JSON `tan`), raw in session, disk-write only |
| C | TDS (section) | TDS/Section | **Engine** — law-table section key mapped through the explicit `WINMAN_TDS_SECTIONS` table to the 44-value dropdown string |
| D | NATUREOFPAYMENT | Nature of payment | **Law table** (new `nature` text per section; free-text column, wording is ours — C-marker) |
| E | TOTALPAYMENTS | Total payments of specified nature | **Books** — engine `events.bookings` gross per section |
| F | TDSSUMLIABLE | Sum liable to TDS | **Books × law** — engine per-booking liable base (threshold/whole-Year/194Q-crossing), stamped additively |
| G/H | TDSATRATESUMLIABLE/TDSATRATETDS | at specified rate: sum liable / TDS | **Books × law × operator certificates** — the non-certificate slice of F and its tax |
| I/J | TDSATMINRATESUMLIABLE/TDSATMINRATETDS | at lower rate: sum liable / TDS | **Operator certificates** (s.197 lower-rate slice) — bookings where a certificate applied |
| K | TDSDEDUCTED | TDS deducted **but not deposited** (Winman's header wording) | **Books** — per-section `deducted − deposited` from engine deductions/deposits |

### Sheet `TCS` (clause 34 mirrors; keys `COLLECTOR TAN — NATUREOFRECEIPT TOTALRECIEPT TCSSUMLIABLE TCSATRATESUMLIABLE TCSATRATETDS TCSATMINRATESUMLIABLE TCSATMINRATETDS TCSCOLLECTED`)

| Col | Key | Source |
|---|---|---|
| A | COLLECTOR | Session company name |
| B | TAN | Operator (same TAN) |
| C | (unkeyed) | blank always |
| D | NATUREOFRECEIPT | **Operator** `tcsSections` mapping (receipt ledger → exact Winman nature dropdown string, validated) × books rows |
| E | TOTALRECIEPT [sic] | Books — receipts (debits) on nature-mapped ledgers |
| F | TCSSUMLIABLE | Books × new `tcs-law` thresholds |
| G–J | at-rate / lower-rate | at-rate slice from books×law; lower-rate slice **zeros** (27C declarations are out of scope — noted open question) |
| K | TCSCOLLECTED | collected (duty credits) − deposited (duty debits), per nature |

### Sheet `Return details` (clause 34(b); keys `DEDUCTOR TAN FORMNO QUARTER DUEDATE DATEOFFILING RETURNISINACCURATE RETURNACCURATE`)

| Col | Source |
|---|---|
| A/B | company / operator TAN |
| C FORMNO + D QUARTER + F DATEOFFILING | **Operator** `statements[]` (existing channel) |
| E DUEDATE | **Law** — existing `statementDue(quarter, "FY 25-26")` (Rule 31A) |
| G RETURNISINACCURATE | blank (operator edits in Excel; free text) |
| H RETURNACCURATE | **Operator** (new optional `returnAccurate` on statements; default `Yes` — C-marker) |

### Sheet `Interest on TDS` (s.201(1A); keys `DEDUCTOR TAN FORMNO QUARTER INTERESTPAYABLE INTERESTPAID DATEOFPAYMENT`)

| Col | Source |
|---|---|
| INTERESTPAYABLE | **Books × law** — per-deduction interest already computed by the engine (stamped additively), grouped by quarter of deduction; only for quarters whose statement form is one of the sheet's five dropdown forms (`24Q 26A 26Q 26QB 27Q`) |
| INTERESTPAID / DATEOFPAYMENT | **Operator** (new `interestPaid[]` rows matched on form+quarter) |

### Sheet `Interest on TCS` (s.206C(7); keys `COLLECTOR TAN FORMNO QUARTER INTERESTPAYABLE INTERESTPAID DATEOFPAYMENT`)

| Col | Source |
|---|---|
| INTERESTPAYABLE | Books × `tcs-law` (1%/1.5% p.m., C-markers) from `analyzeTcs` events, grouped by quarter of collection |
| INTERESTPAID / DATEOFPAYMENT | Operator `interestPaid[]` where form = `27EQ` |

**Winman computes itself:** nothing we must pre-compute beyond the above; the macro contract only needs the listed keys present (validated in V3/V4). Dropdown-exact strings are mandatory for C (TDS sheet), D (TCS sheet), C/D (Return details), C/D (Interest on TDS), D (Interest on TCS).

---

## File Structure

```
src/tcs-law.ts        NEW  13 Winman TCS natures w/ rates+thresholds (C-markers), 206C(3) deposit due,
                           27EQ statement due, 206C(7) interest rates, CONFIRM_POINTS
src/tds-law.ts        MOD  + nature text per section, WINMAN_TDS_SECTIONS map, winmanSectionOf()
src/tcs.ts            NEW  analyzeTcs(): collections/deposits/totals from TCS duty+receipt rows
src/tds.ts            MOD  + export quarterOfDate; + additive stamps on TdsBooking (liable, rateApplied,
                           viaCertificate) and TdsDeduction (interestI/interestII)
src/tds3cd.ts         NEW  tds3cdRows(): the five sheets' row sets from analyses + operator facts
src/tds-file.ts       MOD  OperatorFile gains tan/tcsSections/interestPaid/statements[].returnAccurate
                           (JSON + template parse paths, error contract)
src/tds-template.ts   MOD  buildTemplateWorkbook emits Settings TAN row, TCS Sections sheet,
                           Interest Paid sheet, Statements 'Return Accurate?' column
src/review.ts         MOD  tdsReview: TCS ledgers join fetchSet, analyzeTcs, tds3cdRows, lastTds3cd cache,
                           masked preview in result; NEW write3cdTdsTcs() mirroring write3cdPfEsi
src/index.ts          MOD  register tb_write_3cd_tds_tcs
test/fixtures/winman-fixture.ts MOD + makeTdsTcsFixture() (5 sheets, formId 3cdTDS, real row-2 keys)
scripts/verify-3cd-tdstcs-roundtrip.mjs NEW  V1/V2 verification on the real workbook copy
docs/design/2026-09-24-tds-tcs-3cd-design.md NEW  this report, committed
docs/operator/tds-tcs-3cd-operator.md      NEW  operator walkthrough
```

---

### Task 0: Commit the design of record

**Files:**
- Create: `docs/design/2026-09-24-tds-tcs-3cd-design.md`

**Interfaces:**
- Consumes: this report (the scout deliverable at `/home/ram/firstmate/data/ta-3cd-tds-tcs-summary-plan/report.md`).
- Produces: the in-repo spec all later tasks cite.

- [ ] **Step 1:** Copy this report verbatim to `docs/design/2026-09-24-tds-tcs-3cd-design.md` (strip nothing; the report contains no client identifiers).
- [ ] **Step 2:** Commit: `git add docs/design/2026-09-24-tds-tcs-3cd-design.md && git commit -m "docs: design of record for Winman 3CD TDS/TCS summary filling"`

---

### Task 1: `src/tcs-law.ts` — TCS law table

**Files:**
- Create: `src/tcs-law.ts`
- Test: `test/tcs-law.test.ts`

**Interfaces:**
- Consumes: nothing new (mirrors `src/pf-esi-law.ts` shape and `src/tds-law.ts` helpers).
- Produces:
  - `export interface TcsNature { key: string; winman: string; rate: number; threshold: number; authority: string; confirm?: string }`
  - `export const TCS_NATURES: readonly TcsNature[]` — exactly the 13 Winman dropdown strings
  - `export function tcsNatureByWinman(name: string): TcsNature | null` (exact string match)
  - `export function tcsDepositDue(collectionDate: string): string` — YYYYMMDD in, YYYYMMDD out
  - `export function tcsStatementDue(quarter: "Q1" | "Q2" | "Q3" | "Q4", fy: "FY 25-26"): string`
  - `export const TCS_INTEREST: { lateCollection: number; lateDeposit: number; authority: string; confirm: string }`
  - `export const TCS_CONFIRM_POINTS: readonly string[]`

The 13 Winman nature strings (exact, from `INTER!$D$53:$D$65` — a stray space breaks the dropdown): `"Liquor"`, `"Minerals-coal/lignite/iron ore"`, `"Mining & Quarrying Lease"`, `"Motor vehicle"`, `"Overseas Tour package"`, `"Parking Lot Lease"`, `"Remittance under LRS"`, `"Sale of Notified goods u/s 206C(1F)(ii)"`, `"Scrap"`, `"Tendu leaves"`, `"Timber or other forest product(except tendu leaves)-Forest Lease"`, `"Timber-Others"`, `"Toll Plaza Lease"`. Note `206C(1H)` sale-of-goods is correctly ABSENT (Finance Act 2025 removed it) — do not add it.

Rates/thresholds below are best-effort FY 25-26 values and every entry carries a `confirm` marker; the captain confirms before V4 (import) — same convention as `FUND_LAW`.

- [ ] **Step 1: Write the failing test**

```ts
// test/tcs-law.test.ts
import { describe, expect, it } from "vitest";
import { TCS_NATURES, tcsDepositDue, tcsNatureByWinman, tcsStatementDue, TCS_INTEREST } from "../src/tcs-law.js";

describe("tcs-law", () => {
  it("has exactly the 13 Winman dropdown natures, exact strings", () => {
    expect(TCS_NATURES.map((n) => n.winman)).toEqual([
      "Liquor", "Minerals-coal/lignite/iron ore", "Mining & Quarrying Lease", "Motor vehicle",
      "Overseas Tour package", "Parking Lot Lease", "Remittance under LRS",
      "Sale of Notified goods u/s 206C(1F)(ii)", "Scrap", "Tendu leaves",
      "Timber or other forest product(except tendu leaves)-Forest Lease", "Timber-Others", "Toll Plaza Lease",
    ]);
  });

  it("looks up by exact Winman string only", () => {
    expect(tcsNatureByWinman("Scrap")?.key).toBe("scrap");
    expect(tcsNatureByWinman(" scrap")).toBeNull(); // no trim: dropdown strings are exact
  });

  it("every entry has a rate, threshold and authority or confirm marker", () => {
    for (const n of TCS_NATURES) {
      expect(n.rate).toBeGreaterThan(0);
      expect(n.threshold).toBeGreaterThanOrEqual(0);
      expect(n.authority.length).toBeGreaterThan(0);
      expect(n.confirm).toBeTruthy(); // all 13 pending captain confirmation
    }
  });

  it("deposit due is the 7th of the following month, March→30 Apr, Dec→7 Jan", () => {
    expect(tcsDepositDue("20250715")).toBe("20250807");
    expect(tcsDepositDue("20260320")).toBe("20260430");
    expect(tcsDepositDue("20251231")).toBe("20260107");
  });

  it("27EQ statement due dates mirror Rule 31A quarters", () => {
    expect(tcsStatementDue("Q1", "FY 25-26")).toBe("20250731");
    expect(tcsStatementDue("Q4", "FY 25-26")).toBe("20260531");
  });

  it("206C(7) interest rates", () => {
    expect(TCS_INTEREST.lateCollection).toBe(0.01);
    expect(TCS_INTEREST.lateDeposit).toBe(0.015);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run test/tcs-law.test.ts` — FAIL (module not found).
- [ ] **Step 3:** Implement `src/tcs-law.ts`:

```ts
/** TCS law table, FY 25-26 only. Mirrors src/pf-esi-law.ts's C-marker convention. */
export interface TcsNature { key: string; winman: string; rate: number; threshold: number; authority: string; confirm?: string }

const C = "CONFIRM with captain before V4 import (FY 25-26 rate/threshold)";

export const TCS_NATURES: readonly TcsNature[] = [
  { key: "liquor", winman: "Liquor", rate: 0.01, threshold: 0, authority: "s.206C(1) FA(2)2024", confirm: C },
  { key: "minerals", winman: "Minerals-coal/lignite/iron ore", rate: 0.01, threshold: 0, authority: "s.206C(1)", confirm: C },
  { key: "mining-lease", winman: "Mining & Quarrying Lease", rate: 0.01, threshold: 0, authority: "s.206C(1)", confirm: C },
  { key: "motor-vehicle", winman: "Motor vehicle", rate: 1.0, threshold: 1000000, authority: "s.206C(1F)", confirm: C }, // rate 1 as PERCENT? NO — see below
  { key: "overseas-tour", winman: "Overseas Tour package", rate: 0.05, threshold: 0, authority: "s.206C(1G)", confirm: C + "; rises to 20% for remittances ≥₹10L from 1 Oct 2025 — confirm the FY split" },
  { key: "parking-lease", winman: "Parking Lot Lease", rate: 0.01, threshold: 0, authority: "s.206C(1C)", confirm: C },
  { key: "lrs", winman: "Remittance under LRS", rate: 0.05, threshold: 700000, authority: "s.206C(1G)", confirm: C + "; 20% above ₹10L and (from 1 Oct 2025) overseas tour packages — confirm" },
  { key: "notified-goods", winman: "Sale of Notified goods u/s 206C(1F)(ii)", rate: 0.01, threshold: 5000000, authority: "s.206C(1F)(ii)", confirm: C },
  { key: "scrap", winman: "Scrap", rate: 0.01, threshold: 0, authority: "s.206C(1)", confirm: C },
  { key: "tendu", winman: "Tendu leaves", rate: 0.02, threshold: 0, authority: "s.206C(1)", confirm: C },
  { key: "timber-lease", winman: "Timber or other forest product(except tendu leaves)-Forest Lease", rate: 0.025, threshold: 0, authority: "s.206C(1)", confirm: C },
  { key: "timber-others", winman: "Timber-Others", rate: 0.025, threshold: 0, authority: "s.206C(1)", confirm: C },
  { key: "toll-plaza", winman: "Toll Plaza Lease", rate: 0.01, threshold: 0, authority: "s.206C(1C)", confirm: C },
];
// NOTE: every rate/threshold above is the drafted best guess pending the C-marker sweep;
// the motor-vehicle entry intentionally uses the fraction convention (1.0 is WRONG as drafted —
// the executor's first action is the law sweep below). The test asserts structure, not values.

export function tcsNatureByWinman(name: string): TcsNature | null {
  return TCS_NATURES.find((n) => n.winman === name) ?? null;
}

function ymd(y: number, m: number, d: number): string { return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`; }

/** s.206C(3) deposit due: 7th of the following month; March→30 Apr; December→7 Jan (Rule 30 mirror). */
export function tcsDepositDue(collectionDate: string): string {
  const y = Number(collectionDate.slice(0, 4)), m = Number(collectionDate.slice(4, 6));
  if (m === 3) return ymd(y + 1, 4, 30);
  if (m === 12) return ymd(y + 1, 1, 7);
  return ymd(y, m + 1, 7);
}

/** 27EQ due dates (Rule 31A quarters, FY 25-26). */
export function tcsStatementDue(quarter: "Q1" | "Q2" | "Q3" | "Q4", _fy: "FY 25-26"): string {
  const due: Record<"Q1" | "Q2" | "Q3" | "Q4", string> = { Q1: "20250731", Q2: "20251031", Q3: "20260131", Q4: "20260531" };
  return due[quarter];
}

export const TCS_INTEREST = { lateCollection: 0.01, lateDeposit: 0.015, authority: "s.206C(7)", confirm: "CONFIRM: 1% p.m. late collection, 1.5% p.m. late deposit, month convention" };

export const TCS_CONFIRM_POINTS: readonly string[] = [C, TCS_INTEREST.confirm, "tcsDepositDue March/December specials mirror TDS Rule 30 — CONFIRM for 206C(3)"];
```

**Executor note (the law sweep):** before landing, verify each rate/threshold against the FY 25-26 Finance Acts and record the authority string with the confirmed date, flipping `confirm` to a `"CONFIRMED YYYY-MM-DD"` marker exactly as `FUND_LAW` does. Fix the drafted `motor-vehicle` rate to the fraction convention used everywhere else (rates are fractions: `0.01` = 1%). Drop this note from the committed file.

- [ ] **Step 4:** Run `npx vitest run test/tcs-law.test.ts` — PASS.
- [ ] **Step 5:** `npm run typecheck && git add src/tcs-law.ts test/tcs-law.test.ts && git commit -m "feat: TCS law table with C-markers for the 3CD TCS sheet"`

---

### Task 2: `src/tds-law.ts` — nature text + Winman section map

**Files:**
- Modify: `src/tds-law.ts`
- Test: `test/tds-law.test.ts` (extend the existing file's describe blocks)

**Interfaces:**
- Consumes: existing `TDS_SECTIONS` keys (`194C 194J 194-I(a) 194-I(b) 194A 194H 194Q 194T 206AA`).
- Produces:
  - `export function natureOf(section: string): string` — human nature-of-payment text, `""` for unknown
  - `export const WINMAN_TDS_SECTIONS: ReadonlyMap<string, string>` — law key → exact dropdown string
  - `export function winmanSectionOf(lawKey: string): string | null`
  - `export const WINMAN_TDS_DROPDOWN: readonly string[]` — the 44 dropdown strings (for template validation and tests)

The map is a table, never string surgery: only the eight emittable law keys appear; `194-I(a)` ↔ `"194I (a)"` (space before parens), `194-I(b)` ↔ `"194I (b)"`; hyphenated keys like `194Q` map identity. `206AA` is a rate rule, not a row, and is deliberately absent.

- [ ] **Step 1: Write the failing test** (append to `test/tds-law.test.ts`)

```ts
import { natureOf, winmanSectionOf, WINMAN_TDS_DROPDOWN } from "../src/tds-law.js";

describe("winman section mapping", () => {
  it("maps law keys to the exact dropdown strings", () => {
    expect(winmanSectionOf("194-I(a)")).toBe("194I (a)");
    expect(winmanSectionOf("194-I(b)")).toBe("194I (b)");
    expect(winmanSectionOf("194C")).toBe("194C");
    expect(winmanSectionOf("194Q")).toBe("194Q");
  });
  it("maps every law-table section except 206AA", () => {
    for (const s of ["194C", "194J", "194-I(a)", "194-I(b)", "194A", "194H", "194Q", "194T"]) {
      expect(winmanSectionOf(s)).toBe(s === "194-I(a)" || s === "194-I(b)" ? expect.any(String) : s);
    }
    expect(winmanSectionOf("206AA")).toBeNull();
    expect(winmanSectionOf("195")).toBeNull(); // real dropdown value, not our law table
  });
  it("every mapped section's dropdown string is in the real dropdown list", () => {
    for (const s of ["194C", "194J", "194-I(a)", "194-I(b)", "194A", "194H", "194Q", "194T"]) {
      const w = winmanSectionOf(s);
      if (w) expect(WINMAN_TDS_DROPDOWN).toContain(w);
    }
    expect(WINMAN_TDS_DROPDOWN).toHaveLength(44);
    expect(WINMAN_TDS_DROPDOWN).toContain("192"); // first
    expect(WINMAN_TDS_DROPDOWN).toContain("196D"); // last
  });
  it("nature text exists for every emittable section", () => {
    expect(natureOf("194C")).toMatch(/contractor/i);
    expect(natureOf("195")).toBe("");
  });
});
```

- [ ] **Step 2:** Run — FAIL (exports missing).
- [ ] **Step 3:** Implement in `src/tds-law.ts`:

```ts
/** Nature-of-payment text for the 3CD TDS sheet column D (free text — wording is ours). */
const NATURES: Record<string, string> = {
  "194C": "Payment to contractors / sub-contractors",
  "194J": "Professional or technical fees",
  "194-I(a)": "Rent of plant & machinery / equipment",
  "194-I(b)": "Rent of land & building / furniture",
  "194A": "Interest other than interest on securities",
  "194H": "Commission or brokerage",
  "194Q": "Purchase of goods",
  "194T": "Payment to partner (remuneration / interest / commission)",
};
export function natureOf(section: string): string { return NATURES[section] ?? ""; }

/** Law key → exact Winman dropdown string (INTER!$C$8:$C$51). Table, not string surgery. */
export const WINMAN_TDS_SECTIONS: ReadonlyMap<string, string> = new Map([
  ["194C", "194C"], ["194J", "194J"], ["194-I(a)", "194I (a)"], ["194-I(b)", "194I (b)"],
  ["194A", "194A"], ["194H", "194H"], ["194Q", "194Q"], ["194T", "194T"],
]);
export function winmanSectionOf(lawKey: string): string | null { return WINMAN_TDS_SECTIONS.get(lawKey) ?? null; }

export const WINMAN_TDS_DROPDOWN: readonly string[] = ["192","192A","193","194","194-IA","194-IB","194-IC","194-O","194A","194B","194BA","194BB","194C","194D","194DA","194E","194EE","194G","194H","194I (a)","194I (b)","194J","194K","194LA","194LB","194LBA(1)","194LBA(2)","194LBA(3)","194LBB","194LBC(1)","194LBC(2)","194LC","194M","194N","194P","194Q","194R","194S","194T","194U","195","196A","196B","196C","196D"];
```

(The list is exactly the 44 strings from the workbook's INTER sheet, already extracted; do not retype from memory, copy from this plan.)

- [ ] **Step 4:** Run — PASS. **Step 5:** Commit `feat: nature text and Winman section map for the 3CD TDS sheet`.

---

### Task 3: `src/tcs.ts` — TCS engine leaf

**Files:**
- Create: `src/tcs.ts`
- Modify: `src/tds.ts` (one-word change: `export function quarterOfDate` at the current private definition ~line 680)
- Test: `test/tcs.test.ts`

**Interfaces:**
- Consumes: `TdsLedgerRows { ledger: string; rows: LedgerVoucherRow[] }` from `src/tds.ts`; `LedgerVoucherRow` from `src/downstream.ts` (fields `date YYYYMMDD`, `voucherNumber`, `counterparty`, `amount` signed for the queried ledger, positive = debit); `tcsNatureByWinman`/`TCS_NATURES` from Task 1.
- Produces:
  - `export interface TcsCollection { date: string; voucherNumber: string; party: string; nature: string /* TcsNature.key */; gross: number; tax: number; ledger: string }`
  - `export interface TcsDeposit { date: string; party: string; tax: number; ledger: string }`
  - `export interface TcsAnalysis { collections: TcsCollection[]; deposits: TcsDeposit[]; totals: { byNature: { nature: string; gross: number; tax: number }[]; notDeposited: number } }`
  - `export function analyzeTcs(dutyRows: TdsLedgerRows[], receiptRows: TdsLedgerRows[], natureOfReceipt: (ledger: string) => string | null): TcsAnalysis`
  - `export { quarterOfDate } from "./tds.js"` re-export convenience (from Task 3's tds.ts change)

Semantics (mirror of the TDS booking/deduction/deposit trichotomy — signs are the SAME convention, never re-flipped):
- A **collection** is a CREDIT row (`amount < 0`) on a TCS duty ledger: `tax = -amount`. The **gross** (column E) comes from the receipt side: a DEBIT row on a ledger where `natureOfReceipt(ledger) != null`, joined to the collection by `voucherNumber` + same voucher when possible, else attributed to the receipt ledger's own nature.
- A **deposit** is a DEBIT row (`amount > 0`) on a TCS duty ledger.
- `byNature[nature].gross` = summed receipt debits for ledgers of that nature; `.tax` = summed collections of that nature (duty-side nature comes from the operator's duty-ledger mapping, which Task 6 wires as `natureOfReceipt` applied to duty ledgers too — a duty ledger mapped to a nature classifies its credits; unmapped duty credits produce NO silent drop but are reported by the caller as a finding).
- `notDeposited` = `sum(collections.tax) − sum(deposits.tax)` floored at 0 per nature.
- Cancelled vouchers: skip rows whose `voucherType` matches the existing TDS skip list in `src/tds.ts` (`/^(cancel)/i` — reuse the same predicate; extract it to an exported `isCancelledVoucher` if it is inline).

- [ ] **Step 1: Write the failing test** — build `TdsLedgerRows` fixtures the way `test/tds-duty-ledgers.test.ts` and `test/tds-review-perf.test.ts` do (read them first; reuse their `row()` helper style):

```ts
// test/tcs.test.ts
import { describe, expect, it } from "vitest";
import { analyzeTcs } from "../src/tcs.js";
import type { TdsLedgerRows } from "../src/tds.js";
import type { LedgerVoucherRow } from "../src/downstream.js";

function row(date: string, voucherNumber: string, counterparty: string, amount: number, voucherType = "Sales"): LedgerVoucherRow {
  return { date, voucherType, voucherNumber, reference: "", counterparty, amount, matchStatus: "matched", tax: null };
}

describe("analyzeTcs", () => {
  const duty: TdsLedgerRows[] = [{ ledger: "TCS Receivable", rows: [
    row("20250710", "S-1", "Buyer A", -2000),          // collected
    row("20250807", "PY-1", "TCS Payable", 2000),       // deposited
  ]}];
  const receipts: TdsLedgerRows[] = [{ ledger: "Scrap Sales", rows: [
    row("20250710", "S-1", "Buyer A", 200000),          // receipt of specified nature
  ]}];
  const natureOf = (ledger: string) => (ledger === "Scrap Sales" || ledger === "TCS Receivable" ? "scrap" : null);

  it("reads collections as duty credits and deposits as duty debits", () => {
    const a = analyzeTcs(duty, receipts, natureOf);
    expect(a.collections).toHaveLength(1);
    expect(a.collections[0]).toMatchObject({ date: "20250710", party: "Buyer A", nature: "scrap", tax: 2000, gross: 200000 });
    expect(a.deposits).toHaveLength(1);
    expect(a.totals.byNature).toEqual([{ nature: "scrap", gross: 200000, tax: 2000 }]);
    expect(a.totals.notDeposited).toBe(0);
  });

  it("undeposited tax floors at zero per nature", () => {
    const a = analyzeTcs([{ ledger: "TCS Receivable", rows: [row("20250710", "S-1", "Buyer A", -500)] }], [], natureOf);
    expect(a.totals.notDeposited).toBe(500);
  });

  it("ignores cancelled vouchers", () => {
    const a = analyzeTcs([{ ledger: "TCS Receivable", rows: [row("20250710", "S-1", "Buyer A", -500, "Credit Note")] }], [], natureOf);
    expect(a.collections).toHaveLength(0);
  });
});
```

(Adjust `voucherType`-based cancellation to the predicate actually present in `src/tds.ts`; if TDS skips cancellations by a different mechanism, mirror that exact mechanism.)

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement `src/tcs.ts` per Interfaces; export `quarterOfDate` from `src/tds.ts`.
- [ ] **Step 4:** Run — PASS. **Step 5:** Commit `feat: TCS collections/deposits analysis leaf`.

---

### Task 4: `analyzeTds` additive stamping

**Files:**
- Modify: `src/tds.ts` (interfaces `TdsBooking`/`TdsDeduction` + the loops inside `analyzeTds` that already compute these quantities)
- Test: `test/tds3cd-stamps.test.ts`

**Interfaces:**
- Consumes: the existing short-deduction / rate-selection / interest-schedule computations inside `analyzeTds` (read `src/tds.ts` fully before editing; the quantities below are already computed there for findings — this task only RECORDS them on the events).
- Produces (all optional fields — zero behavior change when absent):
  - `TdsBooking` gains `liable?: number` (the chargeable base after threshold/whole-year/194Q-crossing logic), `rateApplied?: number`, `viaCertificate?: boolean` (true iff the rate came from a s.197 certificate, i.e. the `certificateRateOf` branch of `rateFor`)
  - `TdsDeduction` gains `interestI?: number; interestII?: number` (the per-deduction s.201(1A) amounts the schedule machinery already derives)
- Invariant test: `sum(deductions.interestI) + sum(deductions.interestII)` equals `totals.interestI + totals.interestII` for the same run (they are the same computation, recorded earlier).

This task does NOT change any existing finding, total, or threshold behavior — a full `npx vitest run` must stay green untouched.

- [ ] **Step 1: Write the failing test** using the smallest existing analyzeTds fixture style (copy the fixture-building setup from `test/tds-duty-ledgers.test.ts` — fake duty/expense/party rows with one booking under a certificate and one without):

```ts
// test/tds3cd-stamps.test.ts — core assertions
const result = analyzeTds(dutyRows, expenseRows, partyRows, ctxWithCertificate);
const booking = result.events.bookings[0];
expect(booking.liable).toBeDefined();
expect(typeof booking.rateApplied).toBe("number");
expect(booking.viaCertificate).toBe(certLedgerSet.has(booking.party));
const ded = result.events.deductions[0];
expect(ded.interestI).toBeDefined();
expect(result.events.deductions.reduce((s, d) => s + (d.interestI ?? 0) + (d.interestII ?? 0), 0))
  .toBeCloseTo(result.totals.interestI + result.totals.interestII, 2);
```

- [ ] **Step 2:** Run — FAIL (fields absent). **Step 3:** Stamp the fields in the existing loops where liable/rate/interest are computed. **Step 4:** `npx vitest run` — ALL green (no regressions). **Step 5:** Commit `feat: stamp liable/rate provenance and per-deduction interest on TDS events`.

---

### Task 5: `src/tds3cd.ts` — the five sheets' row sets

**Files:**
- Create: `src/tds3cd.ts`
- Test: `test/tds3cd.test.ts`

**Interfaces:**
- Consumes: `TdsEvents`/`TdsTotals` (src/tds.ts:88,101), Task 3 `TcsAnalysis`, Task 4 stamps, `OperatorFile` (Task 6 shape), `statementDue`/`interestOn`/`depositDue` (src/tds-law.ts), `natureOf`/`winmanSectionOf` (Task 2), `tcsDepositDue`/`TCS_INTEREST` (Task 1), `quarterOfDate` (Task 3 export).
- Produces:

```ts
export interface Tds3cdTdsRow { deductor: string; section: string; nature: string; totalPayments: number; sumLiable: number; atRateLiable: number; atRateTds: number; lowerRateLiable: number; lowerRateTds: number; notDeposited: number }
export interface Tds3cdTcsRow { collector: string; nature: string /* Winman string */; totalReceipt: number; sumLiable: number; atRateLiable: number; atRateTcs: number; lowerRateLiable: number; lowerRateTcs: number; notDeposited: number }
export interface Tds3cdReturnRow { deductor: string; form: string; quarter: "Q1" | "Q2" | "Q3" | "Q4"; dueDate: string; filedOn: string; accurate: "Yes" | "No" }
export interface Tds3cdInterestRow { form: string; quarter: "Q1" | "Q2" | "Q3" | "Q4"; payable: number; paid?: number; paidOn?: string }
export interface Tds3cdResult { company: string; tan: string | null; tds: Tds3cdTdsRow[]; tcs: Tds3cdTcsRow[]; returns: Tds3cdReturnRow[]; interestTds: Tds3cdInterestRow[]; interestTcs: Tds3cdInterestRow[] }

export function tds3cdRows(args: {
  company: string; tan: string | null;
  tds: { events: TdsEvents; totals: TdsTotals };
  tcs: TcsAnalysis;
  operator: OperatorFile;
  asOnDate: string; // YYYYMMDD — basis for interest on undeposited tax
}): Tds3cdResult
```

Rules (each is testable):
1. **TDS rows:** one per law-table section present in `events.bookings` with `winmanSectionOf(section) != null` (206AA never rows; 194Q omitted entirely when suppressed — the caller passes bookings already suppression-filtered by `analyzeTds`; assert nothing here). `totalPayments` = Σ gross; `sumLiable` = Σ `liable ?? 0`; `atRate*`/`lowerRate*` split by `viaCertificate` (booking.liable for the base, and tax attribution via the deduction joined to that booking — deductions whose `joinedTo` booking is unknown split by their party's certificate existence at deduction date, mirroring `rateFor`'s first branch); `notDeposited` = max(0, Σ deductions.tax − Σ deposits.tax) per section (deposits carry `section`).
2. **TCS rows:** one per nature with `byNature.tax > 0 || byNature.gross > 0`; `sumLiable` = the threshold-trimmed base (per-transaction thresholds from `tcs-law`: gross above threshold counts — C-marker on the per-nature vs aggregate convention); `lowerRate*` all zero (27C out of scope); `nature` = the exact Winman string (`TCS_NATURES.find(key)`).
3. **Returns:** one per `operator.statements` row (all of them — TDS and TCS statements alike; the sheet's form dropdown is the 18-value list, strictly wider than our facts); `dueDate = statementDue(quarter, "FY 25-26")`; `accurate = st.returnAccurate ?? "Yes"`.
4. **Interest on TDS:** group stamped `deductions[].interestI + interestII` by `quarterOfDate(deduction.date)`; attribute the quarter's form from the operator statement of that quarter; emit only when that form ∈ `["24Q","26A","26Q","26QB","27Q"]` (the sheet's dropdown) — otherwise skip the quarter and count it in the result's `skippedInterestQuarters` (add this `readonly string[]` field, e.g. `"Q2:26QE"`, masked-safe: form+quarter only). Merge `operator.interestPaid` matched on (form, quarter) → `paid`/`paidOn`.
5. **Interest on TCS:** per quarter of collection date, `payable = Σ interestOn(TCS_INTEREST.lateDeposit, monthsLate, tax)` where `monthsLate` counts months from `tcsDepositDue(collection.date)` to the matched deposit date (or `asOnDate` when undeposited — C-marker); collections deposited on/before due contribute 0. `paid`/`paidOn` from `operator.interestPaid` rows with `form === "27EQ"`.
6. `tan` passes through; it is raw session data — nothing here masks because nothing here is model-visible (Task 7 wraps).

- [ ] **Step 1: Write the failing tests** covering: the 194I(a) mapping, certificate vs standard split sums, notDeposited flooring, return due dates, the 26QE-skip rule, undeposited-TCS interest at asOnDate, and the "no names in any row" property (`JSON.stringify(result)` contains no ledger/party name strings used in fixtures — company excepted).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. **Step 5:** Commit `feat: 3CD clause-34 row derivation from TDS/TCS analyses`.

---

### Task 6: operator channel — `tds-file.ts` + `tds-template.ts`

**Files:**
- Modify: `src/tds-file.ts`, `src/tds-template.ts`
- Test: `test/tds-file.test.ts` (extend), `test/tds-template.test.ts` (extend if present; else fold into tds-file tests)

**Interfaces:**
- Consumes: existing `parseOperatorFile`/`parseOperatorTemplate`/`EMPTY_TDS_OPERATOR`, `bindColumns`/`dataRows`/`dateCell`/`amountCell`/`enumCell`/`textCell` (all exported from `src/tds-file.ts`), `buildTemplateWorkbook(company?)`/`templateFileName` from `src/tds-template.ts:122`, `TCS_NATURES` (Task 1).
- Produces (all optional; `EMPTY_TDS_OPERATOR` gains them as `undefined`):
  - `OperatorFile.tan?: string` — shape-validated `/^[A-Z]{4}\d{5}[A-Z]$/`; invalid → error citing Settings row / JSON key `tan`, NEVER the value
  - `OperatorFile.tcsSections?: { ledger: string; nature: string }[]` — nature must be an exact `TCS_NATURES` winman string; error cites sheet+row+column; duplicates by canonical ledger key refused citing both rows
  - `OperatorFile.interestPaid?: { form: string; quarter: "Q1"|"Q2"|"Q3"|"Q4"; amount: number; paidOn: string }[]` — form validated against the union of the two interest sheets' dropdowns (24Q/26A/26Q/26QB/27Q/27EQ); duplicate (form,quarter) refused citing rows
  - `OperatorFile.statements[i].returnAccurate?: "Yes" | "No"` — enum cell, blank → absent (→ "Yes" default at consumption)
  - Template: new sheets **`TCS Sections`** (columns `Ledger` | `Nature of receipt (exact Winman text)`), **`Interest Paid`** (columns `Form` | `Quarter (Q1-Q4)` | `Amount` | `Paid on`), new Settings row **`TAN`**, new Statements column **`Return Accurate? (Yes/No)`** — all following the existing template's header/validation conventions in `src/tds-template.ts` (read it; it uses `buildWorkbook` from `src/xlsx.ts`, NOT the de-masking writer)
- Round-trip test: `parseOperatorTemplate(Buffer.from(buildTemplateWorkbook("X")))` yields `EMPTY_TDS_OPERATOR`-equivalent (all new fields undefined when blank); filling cells via the same fixture-editing approach as existing `test/tds-file.test.ts` template tests yields the parsed values.

- [ ] **Step 1: failing tests** (JSON + template paths; error-contract assertions: error message matches /TCS Sections.*row 3.*column B/ style and does NOT contain the bad nature string when the bad value is a TAN; duplicate refusals cite both rows).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + `npx vitest run` green (old templates parse unchanged). **Step 5:** Commit `feat: TAN, TCS sections, interest-paid and return-accurate operator facts`.

---

### Task 7: session integration — `tdsReview` + `write3cdTdsTcs`

**Files:**
- Modify: `src/review.ts` (tdsReview at :1026-1461; new writer next to `write3cdPfEsi` :1918-1990; session cache block :515-518)
- Test: `test/tds3cd-session.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6; existing session fields `lastTds` (:515), the `result.tds3cd` preview shape below.
- Produces:
  - `TdsReviewResult` gains `tds3cd?: { sheets: { tds: number; tcs: number; returns: number; interestTds: number; interestTcs: number }; totals: { tdsNotDeposited: number; tcsNotDeposited: number; interestPayable: number }; skippedInterestQuarters: string[] }` — **counts and amounts only**, `money()`-formatted at the session boundary, no TAN, no ledger/party names (the full `Tds3cdResult` never leaves the session)
  - session cache `lastTds3cd: Tds3cdResult | undefined` + getter `tds3cdResult: () => lastTds3cd` (mirroring `pfEsiRows()` at :2099)
  - `write3cdTdsTcs(args: { sourcePath: string; outPath?: string }): Promise<string>` — mirror of `write3cdPfEsi`: refuse when no cached `lastTds3cd`; `readXlsm` → `readHandshake` → `readSchema` asserting every data sheet's `formId === "3cdTDS"`; build `WinmanRow[]` per sheet with the REAL row-2 keys and write via `writeSheetRows`; same outPath/stamp/`realPathId` self-overwrite guard/mkdir conventions; returns the written path.

`tdsReview` wiring (all additive, after `analyzeTds`, before masking):
1. TCS fetch: add `operator.tcsSections` ledgers (canonical-keyed) + any ledger whose name matches `/tcs/i` under a duties-root to the existing `fetchSet` (same set, one projection pass — no extra ledger calls; the ~5.7 s/call cost is per-call, not per-row).
2. `analyzeTcs(dutySlices, receiptSlices, natureOfReceipt)` where `natureOfReceipt` = operator `tcsSections` map first, `/tcs/i` duty-name heuristic second (nature from the ledger name matched against `TCS_NATURES` keywords — `Liquor|Scrap|Tendu|Timber|Toll|Parking|Mineral|Mining|Motor|Tour|LRS|Remittance|Notified` — else null → `tcs_unclassified_ledger` review finding naming the masked ledger).
3. `tds3cdRows({ company, tan: operator.tan ?? null, tds: analysis, tcs, operator, asOnDate })` → cache + preview block.
4. `194Q` suppression: bookings already excluded by `analyzeTds` — `tds3cdRows` sees none (assert in test).

Row→`WinmanRow` mapping (the sheet writer, exact keys from the workbook — see Global Constraints re dropdown exactness):

```ts
// TDS sheet rows
{ DEDUCTOR: { kind: "text", value: r.deductor }, TAN: tan ? { kind: "text", value: tan } : null,
  TDS: { kind: "text", value: r.section }, NATUREOFPAYMENT: { kind: "text", value: r.nature },
  TOTALPAYMENTS: { kind: "number", value: r.totalPayments }, TDSSUMLIABLE: num(r.sumLiable),
  TDSATRATESUMLIABLE: num(r.atRateLiable), TDSATRATETDS: num(r.atRateTds),
  TDSATMINRATESUMLIABLE: num(r.lowerRateLiable), TDSATMINRATETDS: num(r.lowerRateTds),
  TDSDEDUCTED: num(r.notDeposited) }
// TCS sheet rows — nature into NATUREOFRECEIPT (D); C (unkeyed) omitted entirely
// Return details rows — QUARTER: { kind: "number", value: 1..4 } (dropdown literals are numeric);
//   DUEDATE/DATEOFFILING: { kind: "date", ymd }; RETURNACCURATE: { kind: "text", value: "Yes"|"No" }
// Interest on TDS rows — FORMNO text from the 5-list; QUARTER numeric; INTERESTPAYABLE/INTERESTPAID numbers;
//   DATEOFPAYMENT date-or-null
// Interest on TCS rows — FORMNO: { kind: "text", value: "27EQ" }; QUARTER numeric (its dropdown covers D only)
```

`num(x)` = `{ kind: "number", value: x }`. Null cells are omitted by `writeSheetRows` (existing behavior).

- [ ] **Step 1: failing tests** using `createSession` + `fakeDownstream` (`test/fixtures/downstream-fake.ts`) with a day-book bundle containing: one 194C booking (deposited late), one certificate-rate 194J booking, one TCS scrap collection+deposit, statements for Q1 (24Q) and Q2 (26QE — the skip case), interestPaid for (24Q,Q1). Assert: preview block present with money()-formatted amounts; `tds3cdResult()` rows match expectations; `write3cdTdsTcs` on the Task 8 fixture writes and re-reads with `readSchema`; refusing-without-cache; self-overwrite refusal.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + full suite. **Step 5:** Commit `feat: session TDS/TCS 3CD slices, cache and workbook writer`.

---

### Task 8: fixture — `makeTdsTcsFixture()`

**Files:**
- Modify: `test/fixtures/winman-fixture.ts`
- Test: `test/winman3cd-tdstcs.test.ts`

**Interfaces:**
- Consumes: the existing string-template fixture machinery (per-sheet `[formId, sheetName, firstDataRow, fieldPath, ...row2keys, ...headers]` arrays, `$WiNsArAlXlImPoRt2$` handshake, version 9.6.1, build 1623, AY 2026-2027).
- Produces: `makeTdsTcsFixture(opts?: { tcsSheet?: boolean })` returning `{ buf: Buffer; parts: Record<"TDS"|"TCS"|"RET"|"INT_TDS"|"INT_TCS", string> }` (part names `xl/worksheets/sheet1..5.xml`), with the REAL row-2 keys in sheet order: TDS `DEDUCTOR TAN TDS NATUREOFPAYMENT TOTALPAYMENTS TDSSUMLIABLE TDSATRATESUMLIABLE TDSATRATETDS TDSATMINRATESUMLIABLE TDSATMINRATETDS TDSDEDUCTED`, TCS `COLLECTOR TAN NATUREOFRECEIPT TOTALRECIEPT TCSSUMLIABLE TCSATRATESUMLIABLE TCSATRATETDS TCSATMINRATESUMLIABLE TCSATMINRATETDS TCSCOLLECTED`, Return details `DEDUCTOR TAN FORMNO QUARTER DUEDATE DATEOFFILING RETURNISINACCURATE RETURNACCURATE`, Interest on TDS/TCS `DEDUCTOR|COLLECTOR TAN FORMNO QUARTER INTERESTPAYABLE INTERESTPAID DATEOFPAYMENT` — all formId `3cdTDS`, firstDataRow 7, fieldPaths `6.00.15.*.00.00` / `6.00.35.*.00.00` / `6.00.62.07.*.00` / `6.00.75.*.00.00` / `6.00.95.*.00.00`.

- [ ] **Step 1: failing test** — `readSchema` on the fixture finds 5 (or 4 when `tcsSheet:false`) data sheets with the expected `{ sheet, formId, firstDataRow }`; `writeSheetRows` + re-`readSchema` round-trips rows for every sheet (this is the plan's V1 in miniature; the PF/ESI `test/winman3cd.test.ts` shows the assertion style, including prototype-row byte-identity and `<dimension>` update).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `test: 3cdTDS five-sheet fixture`.

---

### Task 9: MCP tool — `tb_write_3cd_tds_tcs`

**Files:**
- Modify: `src/index.ts`
- Test: `test/server-tools.test.ts` (registered-names list), `test/leak.test.ts` (extend)

**Interfaces:**
- Consumes: session `write3cdTdsTcs` (Task 7).
- Produces: tool `tb_write_3cd_tds_tcs(sourcePath: string, outPath?: string)` → `{ path, sheets: {tds,tcs,returns,interestTds,interestTcs} }` (row counts only, no amounts/no TAN in the tool response beyond the preview already in `tb_tds_review` — keep this response minimal); registered beside `tb_write_3cd_pf_esi` (src/index.ts:341 area), same zod + audit-log conventions.

- [ ] **Step 1: failing tests** — name present in `test/server-tools.test.ts`'s registered list; leak test: run the tool against the Task 8 fixture with a cached session built on fake ledgers whose names include canary strings (`orchid`/`medical` per `test/leak.test.ts` convention) and assert the written workbook part XML and the tool response contain no canary and no TAN-shaped `[A-Z]{4}\d{5}[A-Z]` match beyond the deliberately written TAN cell in the B columns (scope the assertion to non-B-column cells, or write the canary session with `tan: undefined` and assert no TAN-shaped string anywhere).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: tb_write_3cd_tds_tcs tool`.

---

### Task 10: verification script + operator docs

**Files:**
- Create: `scripts/verify-3cd-tdstcs-roundtrip.mjs`, `docs/operator/tds-tcs-3cd-operator.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `scripts/verify-winman-roundtrip.mjs` (V1 structural + V2 Excel-COM pattern: absolute `powershell.exe` path from WSL, NO `$wb.Close` after `ValidateMandatoryFields`, force-kill only the spawned PID); `dist/` build (`npm run build` first).
- Produces: a script that (a) copies `/tmp/opencode/tdstcs/source.xlsm` to a temp path (re-copy from the original only if the scratch copy is gone — the original path is in the task brief, never hardcoded into the committed script; it takes `--source <path>`), (b) runs a stub-downstream session (the `ta-tds-offline-daybook` report documents the stub pattern: `groups`/`ledgersTax` rejecting + a day-book bundle) seeded with synthetic bookings including one late-deposited 194C, one certificate 194J, one scrap TCS pair, statements, interestPaid, (c) calls `write3cdTdsTcs`, (d) V1: re-reads schema + row values, (e) V2: Excel COM opens clean + `ValidateMandatoryFields` passes, (f) asserts every written C/D dropdown cell value ∈ the real dropdown lists (hardcode the 44+13+18+5 lists from this plan), and (g) verifies style-twin resolution for `s89 s90 s91 s98 s100 s101` (the resolveStyleTwins machinery handles absent twins by appending stripped copies — the script logs which path was taken; this closes the (b1) TODO).
- `docs/operator/tds-tcs-3cd-operator.md`: Settings TAN row, TCS Sections sheet, Interest Paid sheet, Return Accurate column — how the operator fills them, mirroring `docs/operator/tds-operator-template.md`'s voice; explicitly notes the workbook is written NEXT TO the source (never into the Winman folder) and re-imported via Winman's import click (V4, captain-operated).
- `AGENTS.md`: one concise sharp-edges block (see "AGENTS.md entry" below).

- [ ] **Step 1:** Write the script; run it end-to-end on the scratch copy (`node scripts/verify-3cd-tdstcs-roundtrip.mjs --source /tmp/opencode/tdstcs/source.xlsm`); iterate until V1+V2 pass.
- [ ] **Step 2:** Write the operator doc; commit together: `feat: 3CD TDS/TCS round-trip verification + operator walkthrough`.
- [ ] **Step 3:** AGENTS.md entry (append under a new `## Sharp edges found implementing the 3CD TDS/TCS summary (2026-09-24)` heading):

```markdown
- Design of record: docs/design/2026-09-24-tds-tcs-3cd-design.md. Read it before touching src/tds3cd.ts / src/tcs*.ts.
- The Winman TDS dropdown spells the rent sections "194I (a)"/"194I (b)" (space, no hyphen) while the law table uses
  "194-I(a)"/"194-I(b)": the only conversion is the WINMAN_TDS_SECTIONS table, never string surgery. Column K of both
  the TDS and TCS sheets is tax deducted/collected BUT NOT DEPOSITED (Winman's header), not the total.
- Quarter cells in Return details/Interest sheets take numeric literals 1-4 (dropdown INTER!$D$86 is numeric);
  the engine's "Q1".."Q4" converts only at the write3cdTdsTcs boundary.
- The operator TAN lives RAW in session memory (panOf precedent), reaches disk only inside the filled workbook,
  and must never appear in an error, preview, or tool response. Shape errors cite the Settings row, not the value.
- Interest-on-TDS quarters whose statement form is outside the sheet's five-form dropdown (24Q/26A/26Q/26QB/27Q)
  are skipped and listed in skippedInterestQuarters as "Q2:26QE" — form+quarter only.
- 206C(1H) is intentionally absent from TCS_NATURES (Finance Act 2025 removed it); the 13 Winman nature strings
  are exact-match (no trim) — a stray space breaks the dropdown on import.
```

- [ ] **Step 4:** `npm run typecheck && npx vitest run` green; commit.

---

### Task 11: live validation (V3/V4, captain-assisted)

**Files:** none committed (validation log appended to the design doc's §Live validation).

- [ ] **Step 1:** Live `tb_tds_review` on the real company (the WSL timeout chain from `harness/claude-code.md`: `TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS` + `TALLY_TIMEOUT_MS` + `MCP_TOOL_TIMEOUT`, `TALLY_DEFAULT_COMPANY` set; or the day-book file channel with the existing exported bundle — the raw `operator-samples` DayBook.json is NOT the bundle shape; regenerate via `scripts/export-daybook.mjs`).
- [ ] **Step 2:** `tb_write_3cd_tds_tcs` with `sourcePath` = a COPY of the real workbook in the report dir; verify the original's md5 is unchanged before and after (`ce4f7248de5642fb4eb419ea138b7938` — re-derive once from the live file and pin it in this step if it differs).
- [ ] **Step 3:** V3 macro contract + V4: captain opens Winman and clicks import; record the outcome (imported rows / rejected rows) in the design doc. Expect TCS sheets empty for this client (zero TCS-named ledgers in the probe) — that is a correct zero, not a failure.
- [ ] **Step 4:** Resolve the C-markers from Task 1 (captain confirms rates/thresholds); flip `confirm` strings to `CONFIRMED <date>`; commit.

---

## Dependencies between tasks

Task 0 → 1 → 2 → (3 ∥ 4) → 5 → 6 → 7 → 8 → 9 → 10 → 11. Task 8's fixture is only *consumed* by Task 7's writer tests; if executing serially with cheaper models, build Task 8 before Task 7's test step (swap their order in flight — both orders typecheck; the Interfaces blocks are order-independent).

## Self-review notes

- Spec coverage: every column of all five sheets has a sourcing rule (map above) and a task; dropdown exactness is tested (T1, T2, T9, T10g); privacy model is enforced in T6 (error contract), T7 (preview), T9 (leak tests); backward compatibility in T6; the (b1) style-twin TODO closes in T10g.
- Known deliberate scope cuts (open questions below): TCS 27C lower-rate declarations; DEDUCTOR-branch granularity (multi-TAN/multi-branch); TCS interest on late *collection* (only late-deposit interest is computed); Winman's own recomputation of G–J from E/F (we write all columns and let V4 reveal any conflict).
- Type consistency: `Tds3cdResult` fields match T7's preview block and T9's tool response; `WinmanValue` kinds match `src/winman3cd.ts:325-332`; `TdsLedgerRows` matches `src/tds.ts:18-21`; `analyzeTds` signature at `src/tds.ts:289`.

## Open questions (for the captain)

1. **TCS rates/thresholds FY 25-26** (all 13 C-markers in Task 1), especially the date-dependent LRS/overseas-tour changes from 1 Oct 2025 (within FY 25-26 — a mid-year rate change the flat table cannot express; if confirmed real, Task 1 grows a `rateOn(nature, date)`).
2. **TCS liable-base convention:** per-transaction threshold (each receipt above threshold) vs aggregate — drafted per-transaction; confirm.
3. **Interest quarter attribution:** drafted as quarter of *deduction/collection date*; Winman may expect quarter of *deposit/due date*. V4 reveals.
4. **QUARTER cell type:** numeric literal drafted (dropdown is numeric); if Winman's import rejects numeric quarters, switch to text `"1"`.
5. **DEDUCTOR granularity:** single company-wide TAN drafted; a multi-branch audit needs per-branch TAN rows (operator channel would grow a branches sheet). Out of scope until asked.
6. **Return-accurate default `Yes`** (C-marker) and the blank RETURNISINACCURATE free-text column: operator edits in Excel — acceptable?
7. **TCS 27C declarations** (lower/nil rate) and **late-collection interest** (206C(7)(a), 1% p.m. when tax was not collected at all): both drafted out of scope; confirm.
8. **Whether Winman recomputes G–J from E×rate on import** (making our G–J splits advisory) — V4 observation; if it recomputes, we may simplify to writing only E/F/K later.
9. **The interestPaid form vocabulary** allows 26A/26QB (amendment/correction forms) — should statements in those forms also drive Return-details rows (currently: yes, all statements row; confirm no filtering needed)?
