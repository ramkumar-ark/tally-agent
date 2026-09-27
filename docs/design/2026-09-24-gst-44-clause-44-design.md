# Winman Form 3CD clause 44 — Break-up of GST expenditure — Design

Status: design of record. Implementation plan is a separate artifact
(`/home/ram/firstmate/data/ta-3cd-gst-breakup-plan/report.md`).
Date: 2026-09-24.

This is the design of record for filling the Winman Form 3CD
`Break-up of GST expenditure.xlsm` sheet (clause 44) from the books plus an
operator GST-status template, on the landed Winman 3CD round-trip foundation
(design of record `docs/design/2026-09-23-winman-3cd-pf-esi-design.md`, code
`src/winman3cd.ts`, `src/pf-esi*.ts`). Sections 2, 3 and 4 below are reproduced
verbatim from the implementation plan's report; §5 is the column sourcing table
that decides which column every number is written to; §6–§8 pin the privacy
model, the degradation rule and the verification ladder.

---

## 1. Purpose

Form 3CD clause 44 requires a break-up of total expenditure into GST categories
(taxable, exempt, composition, unregistered suppliers). This feature computes
that break-up from the Tally books (day book primary, live fallback), lets the
operator correct or supply GST statuses through a fillable template, and writes
the two result rows — Capital Expenditure, Revenue Expenditure — into the
Winman workbook's "Break-up of GST expenditure" sheet through the already-landed
`writeSheetRows` path, for AY 2026-27 (the workbook's own INTER handshake
`2026-2027`).

The four columns of the form are mutually exclusive buckets; column B is the
row total. The engine's job is to attribute every expenditure debit to exactly
one bucket per row, surface what it cannot attribute as findings, and never
fabricate.

---

## 2. The workbook as it actually is (evidence)

Read with the project's own reader (`readXlsm` / `readHandshake` / `readSchema`
from `src/winman3cd.ts`) plus a raw XML dump of the data sheet and shared
strings. The workbook has the same Winman import protocol as the PF/ESI five:
18 sheets, all hidden except "Enable Macros"; INTER handshake
`$WiNsArAlXlImPoRt2$ | 9.6.1 | 1623 | 2026-2027 | F | G1=1`.

**Data sheet "Break-up of GST expenditure"** (part `xl/worksheets/sheet1.xml`):

- Row 1 (hidden): A1=`3CDGSTbreakup44` (form id), B1=`Break-up of GST expenditure`
  (sheet key), C1=`8` (first data row), **D1 empty** (`fieldPath` is `""` — the
  reader already tolerates this; `readSchema` returned successfully).
- Row 2 (hidden), the machine keys (the whole contract, by column):

  | col | row-2 key | human header (rows 4–6, verbatim) |
  |---|---|---|
  | A | `PARTICULARS` | "Particulars ^" |
  | B | `TOTALEXPENDITURE` | "Total expenditure during the year" |
  | C | `TOWARDSSUPPLIES` | "Expenditure in respect of entities registered under GST — Towards supplies exempt from GST" |
  | D | `COMPOSITIONSUPPLIER` | "Expenditure in respect of entities registered under GST — Towards supplies by Composition Supplier" |
  | E | `OTHERS` | "Expenditure in respect of entities registered under GST — Others" |
  | F | `REGISTEREDUNDERGST` | "Expenditure in respect of entities **not** registered under GST" |

  **TRAP: the row-2 key `REGISTEREDUNDERGST` names the *not-registered* column (F).**
  The registered-entity split lives in C/D/E. Any implementation that maps by
  key name intuition inverts the form. Columns C+D+E+F are the four mutually
  exclusive buckets; B is the row total.
- Prototype row 7 (hidden, all `-`): styles 87 (col A), 88 (cols B–F), 91 (col G).
  Col G exists in the prototype but carries **no row-2 key** — never written.
- **Rows 8 and 9 ship pre-filled in column A only**: `Capital Expenditure`,
  `Revenue Expenditure` (shared strings 80/81, style 78). The form expects
  exactly two data rows: capital and revenue.
- No data validations anywhere; `<dimension ref="A1:J9"/>`; no data rows beyond
  the two label rows.
- Style twins (checked in `xl/styles.xml`): xf 87 (numFmt 49, quotePrefix) has a
  pre-existing twin 81 (same minus quotePrefix); **xf 88 (numFmt 1, quotePrefix)
  has no pre-existing twin** — unlike the PF/ESI workbook, a first write will
  exercise `resolveStyleTwins`' append path and replace `xl/styles.xml` too.
  `writeSheetRows` already supports this; the write test must assert it.
- Because `writeSheetRows` **drops all pre-existing rows ≥ firstDataRow and
  re-writes from row 8**, writing must include the `PARTICULARS` labels
  ourselves — the pre-filled labels do not survive a rewrite. Forgetting this
  imports two label-less rows into Winman.

**Winman import protocol** (hidden rows 1/2, prototype styles, clipboard-carry,
Excel re-save, C1 start row) is identical to the PF/ESI design doc §2 — nothing
new to discover, nothing to redesign. The foundation's verification ladder V1
(structural vitest) → V2 (Excel COM clean open) → V3 (macros +
`ValidateMandatoryFields` True) → V4 (captain's Winman import click) applies
verbatim, via the existing `scripts/verify-winman-roundtrip.mjs`.

---

## 3. The books side (day-book probe, read-only)

From `daybook-export-rvs-25-26.json` (FY 25-26, 14,359 vouchers, 72 groups,
2,700 ledgers):

- **The bundle's `ledgers[]` carry only `{name, parent}` — no GSTIN, no PAN,
  no flags** (`DayBookInput.ledgers` in `src/tds-daybook.ts:66` is
  `{ name: string; parent: string }[] | null`). The M2 masked tax-ID channel
  (`tally_get_ledgers` verbose → `downstream.ledgersTax()` →
  `LedgerTaxInfo.gstin`, `src/downstream.ts:41-53`) is the only books-side
  GSTIN source. This drives Decision 1 (§4).
- Every voucher carries `partyLedgerName` (14,359/14,359) — party attribution is
  cheap and universal for this company.
- 3,212 vouchers carry GST-ledger lines; 11,147 do not. Registered suppliers
  with tax charged are a large, distinguishable class.
- Ledger parents of interest: `sundry creditors` 993, `trade creditors` 68,
  `purchase accounts` 31, `indirect expenses` 35, many operational expense
  sub-groups (sub contract, fuel, transport...), **`fixed assets` 1 ledger** —
  a constructions company whose capex is tiny in ledger terms; the capital row
  will be small but the machinery must still be correct.
- Voucher entries use raw Tally signs (credit negative — e.g. the sample
  "RENTAL INVOICE" credits the debtor −5,31,000). `readDayBook` maps them into
  `VoucherRow` at the gateway boundary; downstream of it **positive = debit**
  (R-MCP-5) — expenditure lines are `amount > 0` debits.
- Expense-side roots available from the classifier (`src/classify.ts:26-42`):
  revenue = `Purchase Accounts`, `Direct Expenses`, `Indirect Expenses`
  (+ `Misc. Expenses (ASSET)`, C3 below); capital = `Fixed Assets`
  (Investments excluded, C4 below).

The existing `src/gst.ts` gives the reusable seams: `GstCtx` (groupOf / rootOf /
inDutiesAndTaxes / roleOf / gstinOf) and `gstHeadOf` (CGST/SGST/IGST/CESS/GST-OTHER
by ledger name). `kindOf`/`partyOf` are sales/purchase-kind helpers — clause 44
needs a broader walk (any voucher with an expenditure-ledger debit, not just
purchase-invoice-shaped vouchers), so the plan adds a small dedicated pure
function that *consumes* `GstCtx` rather than extending `kindOf`.

---

## 4. Law, and the two decisions

### 4.1 Clause 44 (form columns and applicability)

Form 3CD clause 44 ("break-up of total expenditure into GST categories") as
substituted by CBDT Notification No. 88/2020 dated 21-10-2020, and applying to
tax audit reports for FY 2025-26 (AY 2026-27) — the workbook's own INTER
handshake (`2026-2027`) is the operative confirmation for this engagement. The
table's columns are exactly the workbook's headers (§2):

1. total expenditure;
2. expenditure in respect of entities registered under GST, split into
   (a) towards supplies exempt from GST, (b) towards supplies by composition
   supplier, (c) others;
3. expenditure in respect of entities not registered under GST.

- **C1 (citation):** the exact notification trail making clause 44 operative
  for AY 2026-27 (88/2020 substitution; subsequent deferral lifting) should be
  confirmed by the captain before the numbers are filed. The column semantics
  themselves are not in doubt — the form mirrors the workbook.
- **C2 (row split):** the *form's* table is one expenditure table; the
  **Capital / Revenue two-row split is Winman's presentation** (pre-filled
  labels, §2). We fill Winman's two rows as-is. Confirm the firm is happy
  filing that presentation.
- **C3:** `Misc. Expenses (ASSET)` debits are counted as *revenue* expenditure
  (they are P&L items in Tally). 
- **C4:** `Investments` debits are **not** capital expenditure (application of
  funds, not expenditure); capital = `Fixed Assets` root only.
- **C5 (column B) — revised by the captain's v1 brief, 2026-09-27:**
  `TOTALEXPENDITURE` is the **books total** (B = I, the row's whole amount),
  so the row no longer adds across: C+D+E+F = G+H falls short of B by exactly
  column J (not supply / paid to govt), which has no clause-44 column. The four
  bucket columns are unchanged. Any expenditure the walk could not attribute to
  a party is **not** silently spread — it raises an informational finding
  (`gst44_unattributed_expenditure`) and never fails or blocks the fill.
- **C6 (default for registered-no-tax):** a party with a GSTIN on a voucher
  that charges no GST defaults to the *exempt* column (C) with an ambiguity
  finding, because books cannot distinguish exempt supplies from composition
  supplies; the composition column (D) is only ever filled from an operator
  fact (Decision 1). 

### 4.2 Decision 1 — where supplier GST status comes from (the brief's explicit ask)

**Hybrid, with books as the base and an operator override sheet — not either/or:**

1. **Books (default, automatic):** GSTIN presence from the ledger masters via
   the existing masked tax-ID channel (`downstream.ledgersTax()`; GSTINs stay
   in gateway memory, leave only as vault aliases — M2 contract), plus
   voucher-level tax evidence (did the voucher charge any GST head?):
   - GSTIN + GST charged → bucket "others" (E);
   - GSTIN + no GST charged → bucket "exempt" (C) + one ambiguity finding (C6);
   - no GSTIN → bucket "unregistered" (F).
2. **Operator template (override):** a "GST Status" sheet in a generated
   fillable template (the PF/ESI template channel: path-only, parsed inside
   the gateway, error contract citing sheet/row/column, never cell values).
   A template row is authoritative for that ledger (the only way to fill the
   composition column D, to correct an exempt-vs-others call, or to supply
   status when Tally is down).
3. **Hard degradation:** if there is no GSTIN evidence at all (live Tally
   unreachable or masters empty) *and* expenditure parties exist that no
   template row covers, the review throws an operator-facing error — the same
   standing as `receivableLedgers`' hard error in the 26AS review. We never
   fabricate a break-up by defaulting unknown masters to "unregistered".

Rationale: a GSTIN alone cannot distinguish composition from regular-registered
(both are registered; composition dealers cannot charge tax), and exempt
supplies vs composition is invisible in the books. So *someone* must supply the
composition facts; the operator (the accountant) is the only source, and the
template is the established privacy-safe channel for operator facts. Meanwhile
"registered with tax charged" and "no GSTIN" — the bulk of real books — are
fully derivable, so the template ships blank by default.

### 4.3 Decision 2 — live GSTIN fetch alongside a day book (documented deviation)

PF/ESI's rule was "live Tally is the fallback; never called alongside a day
book" — but that was about the heavy voucher/master fetches. The day book
carries no GSTINs (§3), so `gst44Review` makes **one narrow live call —
`ledgersTax()` — even when `dayBookPath` is given** (the M2 masked tax-ID
channel; ~2,700 ledger scalars, seconds). If that call fails, the review
degrades per Decision 1.3 (template-only, else hard error). This deviation is
recorded in the design doc and AGENTS.md, with the reason.

### 4.4 Confirm points ship as code; open questions for the captain

The confirm points C1–C6 of §4.1 ship as `GST44_CONFIRMS` in `src/gst44-law.ts`,
printed next to findings — the `pf-esi-law.ts` convention. Open questions
carried from the plan (captain decisions, not blockers for the wiring):

- **Q1:** Should `tb_write_gst44_template` pre-fill the last review's resolved
  statuses (26AS-style iterative re-fill), or stay blank v1? Plan: blank.
- **Q2:** gst44 findings ride the TB `CheckId` ordinal space (15–18, planned)
  rather than a new ordinal space — acceptable? (PF/ESI precedent.)
- **Q3:** Approve Decision 2 (one narrow live `ledgersTax` call alongside a day
  book) as a standing deviation from the PF/ESI "never alongside" rule.
- **Q4:** V4 (Winman import click) scheduling on a filled copy of the real
  workbook — captain-operated, like PF/ESI §10.1.
- **Q5:** Mixed-evidence parties (registered GSTIN; some vouchers taxed, some
  not) split across E and C per voucher (planned) — or should one column per
  party be forced? Plan: per-voucher split (the form's own semantics are
  per-supply).

---

## 5. Column sourcing (the core of the design)

| Winman column | Source | Rule |
|---|---|---|
| A `PARTICULARS` | engine | the two pre-filled labels, re-written by the engine (rows ≥ 8 are replaced wholesale) |
| B `TOTALEXPENDITURE` | engine | the books total per row — column I = column B (C5, v1 brief); never the attributed sum |
| C `TOWARDSSUPPLIES` (exempt) | books | party has GSTIN, voucher charges no GST (default; C6) or operator status "Exempt supplies" |
| D `COMPOSITIONSUPPLIER` | operator only | template status "Composition supplier" (books cannot know) |
| E `OTHERS` | books | party has GSTIN and voucher charges GST (incl. RCM), or operator status "Registered - others" |
| F `REGISTEREDUNDERGST` (unregistered) | books | no GSTIN in masters and no template row |

Reading of the table:

- Column A is engine-written because `writeSheetRows` replaces rows ≥ 8
  wholesale (§2): the engine writes the two `CLAUSE_44_ROWS` labels verbatim
  (`Capital Expenditure`, `Revenue Expenditure`), then the four bucket cells
  and the row total.
- "books" for C/E/F means Decision 1's automatic derivation: master GSTIN
  presence (via `ledgersTax`) + voucher-level tax evidence (any GST-head entry
  in the voucher). "operator only" for D means the composition bucket is
  unreachable from books evidence; a template row is its only source.
- An operator template row is authoritative for its ledger and wins over the
  books derivation for every bucket (Decision 1.2).
- Expenditure that attributes to no party never lands in any of C/D/E/F: it
  is reported (`gst44_unattributed_expenditure`, informational) while still
  carrying in the books total B (C5) — so B = C+D+E+F no longer holds and the
  shortfall is exactly the unattributed / not-supply gap.

---

## 6. Privacy

The M2 masked tax-ID contract extends to GSTINs verbatim:

- **GSTINs never leave the gateway as values.** They are fetched internally via
  the narrowest downstream field set (`tally_get_ledgers` verbose:true — never
  `tally_get_ledger`, whose ban stands), consumed by the pure walk in gateway
  memory, and outbound they exist only as vault aliases (`TaxId N`). Findings
  carry the *fact* of a GSTIN (`gstinKnown`), never the value.
- **The operator template is a path-only channel** (the `returnsPath` rule):
  `tb_gst44_review` takes `templatePath`; the file is parsed inside the
  gateway; template parse errors cite sheet/row/column-letter + header, never a
  cell value (a stray operator cell can be a GSTIN). The template is written
  directly by `buildWorkbook` (not the de-masking `writeWorkbook`): a blank
  template was never masked.
- **Findings and report are pseudonymized** exactly per the `pfEsiReview`
  recipe: pseudonym parties first, `scrubSecrets` + `maskKnownNames` sweep on
  every outbound string; amounts use `money()` (Indian grouping) and dates
  `displayDate()` so `scrubDigits` (6+ digit runs → `[number]`) never mangles
  them. The written report workbook de-masks cells + titles on disk only
  (`writeWorkbook` + vault, R-R-4).
- No real client names, PANs, TANs or GSTINs in code, tests or fixtures —
  invented shapes only (`27AAAAA0000A1Z5`-style, as `test/mask.test.ts`
  already uses). Finding `detail` may quote a party's whole name (the vault
  swaps the whole string for its pseudonym) but never a fragment of one
  (`test/leak.test.ts` precedent).

---

## 7. Degradation

The hard error rule (Decision 1.3) is the section of record:

- The GSTIN channel is `ledgersTax()`. If it yields nothing usable — live Tally
  unreachable, or masters with no GSTIN-bearing expenditure parties — the
  review falls back to the operator template alone. If expenditure parties
  exist that **neither** the GSTIN channel **nor** a template row covers, the
  review throws an operator-facing error — the same standing as
  `receivableLedgers`' hard error in the 26AS review. We never fabricate a
  break-up by defaulting unknown masters to "unregistered".
- With a `dayBookPath` given, the one narrow live `ledgersTax()` call is still
  attempted (Decision 2); its failure is not fatal by itself — it degrades per
  the rule above (template-only, else hard error).
- A day-book bundle's `ledgers[]`/`groups[]` substitute for ledger **masters**
  (`{name, parent}` — group/parent facts), never for the GSTIN channel: the
  bundle carries no GSTINs by construction (§3), so `mastersSource: "bundle"`
  does not satisfy Decision 1.3's evidence requirement.
- Degradation is reported, never silent: when the GSTIN channel is missing and
  the template covers the parties, the review's result carries the degraded
  state so the operator knows the basis the numbers rest on.

---

## 8. Verification

The PF/ESI ladder applies verbatim, via the existing
`scripts/verify-winman-roundtrip.mjs`:

- **V1 (structural, automated):** vitest round-trip on the synthetic Winman
  fixture — form-id assert, hidden rows 1/2 byte-identical, the two data rows
  written with labels and bucket figures, style-twin append path exercised
  (§2: xf 88 has no pre-existing twin, so `xl/styles.xml` gets replaced on
  first write — the write test must assert it).
- **V2 (Excel COM clean open) and V3 (macros + `ValidateMandatoryFields`
  True):** run `scripts/verify-winman-roundtrip.mjs` against a **filled copy**
  of the real `R V S CONSTRUCTIONS_Break-up of GST expenditure.xlsm` — the
  original is never written (source-copy + `realPathId` guard in the write
  path, the PF/ESI convention).
- **V4 (captain's Winman import click):** captain-operated on the filled copy,
  like PF/ESI §10.1 (Q4 above). Not automatable; the design only guarantees
  V1–V3 and the operator walkthrough.
