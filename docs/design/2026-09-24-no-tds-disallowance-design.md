# Winman Form 3CD — No TDS Disallowance (clause 21(b)) — Design

Status: design of record. Implementation plan is a separate artifact.
Date: 2026-09-24.

This is the design of record for filling the Winman Form 3CD `No TDS
Disallowance.xlsm` (clause 21(b) — s.40(a)(i)/(ia)/(ib)/(iii) inadmissible
amounts) from the landed TDS review plus an operator template, preserving the
workbook so Winman re-imports it. It rides the shared 3CD foundation
(`src/xlsm.ts` + `src/winman3cd.ts`, landed 2026-09-23) unchanged. Sections 2,
3 and 4 below are reproduced verbatim from the implementation plan's report;
§Live validation records the state of the round-trip verification.

---

## 2. The No TDS Disallowance workbook (foundation recap + this workbook's specifics)

The import protocol, the self-describing hidden-row schema, the cell-encoding contract and the
verification method V1–V4 are **unchanged** and live in the PF/ESI design of record
(`docs/design/2026-09-23-winman-3cd-pf-esi-design.md` §2, §18-equivalent). This section records
only what is specific to `No TDS Disallowance.xlsm`.

### 2.1 Sheets, keys, first data rows

`readHandshake` sees the same marker (`$WiNsArAlXlImPoRt2$`, AY 2026-2027, validation on).
`INTER!F1` carries the form token `#3cdNoTDS$1214|`, preserved automatically because
`src/xlsm.ts` copies every non-worksheet entry verbatim. Four data sheets:

| Sheet tab name (sheetKey = B1) | part | firstDataRow | fieldPath | row-2 keys (col) |
|---|---|---|---|---|
| `40(a)(ia) to resident` | sheet1.xml | 7 | 6.06.10.10.*.00 | DEDUCTEENAME(A) DATEOFPAYMENT(B) EXPENSEAMOUNT(C) TDSDONE(D) TDSDEPOSITED(E) TDSSECTION(F) NATUREOFPAYMENT(G) ADDRESS(H) CITY(I) STATE(J) PINZIP(K) COUNTRY(L) PANAADHAAR(M) |
| `40(a)(ib) - Equalisation Levy` | sheet2.xml | 7 | 6.06.14.07.*.00 | DEDUCTEENAME(A) DATEOFPAYMENT(B) EXPENSEAMOUNT(C) LEVYDEDUCTED(D) LEVYDEPOSITED(E) — (F has no key) NATUREOFPAYMENT(G) ADDRESS(H) CITY(I) STATE(J) PINZIP(K) COUNTRY(L) PANAADHAAR(M) |
| `40(a)(i) to non-resident` | sheet3.xml | 7 | 6.06.20.10.*.00 | same keys as sheet1 |
| `40(a)(iii)` | sheet4.xml | **8** | 6.06.30.10.*.00 | DEDUCTEENAME(A) DATEOFPAYMENT(B) AMOUNT(C) — (D–G no keys) ADDRESS(H) CITY(I) STATE(J) PINZIP(K) COUNTRY(L) PANAADHAAR(M) |

Two consequences the writer must honour:

- **`firstDataRow` differs per sheet (8 on `40(a)(iii)`, headers on row 5).** Never hard-code 7;
  always use `schema.firstDataRow` per sheet, as `write3cdPfEsi` does.
- **Sheets 2 and 4 have key-less columns.** `writeSheetRows` writes only row-2-keyed columns, so
  the gap columns (F on sheet2, D–G on sheet4) are naturally untouched. The row model maps
  `tdsDone`→`TDSDONE` **or** `LEVYDEDUCTED` and `tdsDeposited`→`TDSDEPOSITED` **or**
  `LEVYDEPOSITED` depending on the target sheet; sheet4 has neither (its C is `AMOUNT`).

Human headers for reference (row 4, row 5 on sheet4): "Deductee Name", "Date of payment",
"Expense Amount" / "Amount", "TDS done, if any" / "Levy deducted, if any", "TDS deposited, if
any*" / "Levy deposited, if any*", "TDS Section", "Nature of payment", "Address", "City",
"State", "PIN / ZIP code", "Country", "PAN/ Aadhaar, if available". Sheet4's title row reads
"40(a)(iii) - Salary paid outside India or Non-Resident".

### 2.2 Validation dropdowns and the section-spelling map

Defined names `Sheet_N_ListCol_6/10/12` bind columns to INTER ranges (rows from the prototype
row to row 1000): **TDSSECTION** (col F) → per-sheet section list; **STATE** (col J) → 38-value
state/UT list including "State outside India"; **COUNTRY** (col L) → 250-value country list.
Sheets 2 and 4 carry only the STATE/COUNTRY dropdowns. We write values, never validation; the
values must simply satisfy the lists or Winman's import rejects them.

- Resident list (sheet1, 32 values, exact spellings):
  `192, 193, 194, 194-IA, 194-IB, 194-IC, 194-O, 194A, 194B, 194BA, 194BB, 194C, 194D, 194DA,
  194EE, 194G, 194H, 194I (a), 194I (b), 194J, 194K, 194LA, 194LBA, 194LBB, 194LBC, 194M, 194N,
  194P, 194Q, 194R, 194S, 194T`
- Non-resident list (sheet3, 16 values):
  `194BA, 194E, 194LB, 194LBA, 194LBA(3), 194LBB, 194LBC, 194LC, 194N, 194Q, 194T, 195, 196A,
  196B, 196C, 196D`
- **Law-key → Winman-spelling map** (the only two that differ):
  `194-I(a)` → `194I (a)`, `194-I(b)` → `194I (b)`. Every other law-table key (194C, 194J, 194A,
  194H, 194Q, 194T, …) is its own spelling. A bare `194-I` is rejected everywhere in this repo
  (AGENTS.md) and must throw here too.

### 2.3 What the writer must do (delta from `write3cdPfEsi`)

Copy `sourcePath` → `outPath`, `readHandshake`, per sheet `readSchema` + **assert
`formId === "3cdNoTDS"`**, build `WinmanRow[]` (dates `{kind:"date",ymd}`, numbers
`{kind:"number",value}`, strings `{kind:"text",value}`, blank ⇒ omit the key), `writeSheetRows`
per **non-empty** sheet only (an empty sheet stays pristine — never call `writeSheetRows` with
`[]`, Review Focus #4), self-overwrite guard, `writeXlsm`. Target naming and the "never write
into the Winman folder" rule are identical to PF/ESI.

---

## 3. Books analysis — what the engine has, what it lacks

### 3.1 The TDS engine already computes the join

`analyzeTds(dutyLedgers, expenseLedgers, partyLedgers, ctx)` returns
`{ events, findings, totals }` (`src/tds.ts:289-294`) — and `events` (`TdsEvents`) carries
bookings, payments, deductions and deposits with the joins already made by `joinEvents`
(`TdsDeduction.booking?`, `TdsDeposit.deduction?`). **`tdsReview` currently discards `events`**
(it caches only the masked `TdsReviewResult` at `src/review.ts:1459`). So the books side of
21(b) needs no new fetching at all: cache what the engine already returns.

What is *not* retained per booking today is the liability arithmetic (liable base, computed
liability, rate used) — it lives in `analyzeTds`'s per-booking loop and escapes only as
findings. The 194Q running-cumulative rule and the whole-year rule must **never be re-derived**
in a second module (that is how the 3,433-finding bug happened — AGENTS.md), so the engine
returns per-booking liability facts additively.

### 3.2 Column sourcing per Winman sheet

| Winman column | Source |
|---|---|
| DEDUCTEENAME | booking.party (real ledger name; pseudonym outbound, real on disk) |
| DATEOFPAYMENT | booking.date |
| EXPENSEAMOUNT / AMOUNT | booking.gross — **full payment** (C13 questions this for 194Q; default full gross) |
| TDSDONE / LEVYDEDUCTED | joined deduction's tax (0 when none) |
| TDSDEPOSITED / LEVYDEPOSITED | joined deposit's tax (0 when none) |
| TDSSECTION | law key → Winman spelling (§2.2); resident list for sheet1, NR list for sheet3 |
| NATUREOFPAYMENT | operator template (free text; the s.40(a)(ia) Explanation vocabulary — commission, professional services, works contract, rent, royalty, interest, FTS — as examples) |
| ADDRESS/CITY/STATE/PINZIP/COUNTRY | operator template (STATE should satisfy the 38-value list) |
| PANAADHAAR | real PAN when the session has one (`panOf` map / GSTIN-derived); operator may supply; never outbound |

**Scope rule: the agent never computes a disallowance amount.** The sheets carry payment facts
only; Winman applies 30% (40(a)(ia)) or 100% (40(a)(i)/(ib)/(iii)) itself. The 30%-exposure
note the TDS engine already emits (`tds_exposure_40a_ia`, `src/tds.ts:650-658`) stays a review
note. This keeps every legal-percentage judgement out of the fill path.

### 3.3 What books cannot supply (measured on the real FY 25-26 day book)

Day book: 14,359 vouchers (14,356 live — `isCancelled` is a **string** "Yes"/"No"), 2,700
ledgers, 72 groups. Probes (counts only):

- **Duty side exists**: 15 distinct `\btds\b|\btcs\b` ledgers; 1,051 credit rows (deductions
  raised) and 284 debit rows (deposits) across the FY — so TDSDONE/TDSDEPOSITED are genuinely
  fillable from books via the engine's join.
- **Residency is unknowable from books** — no master fact distinguishes resident from
  non-resident. Default sheet = `40(a)(ia) to resident`; NR routing is an operator decision
  (template column), validated against sheet3's 16-value section list.
- **40(a)(iii) salary**: 39 `salary|wages` ledgers, 746 entries (337 debits). Salary payments
  are not TDS bookings (the engine's party set is trade creditors), so **sheet4 rows are
  operator-supplied only** (Manual sheet in the template).
- **40(a)(ib) equalisation levy**: **zero** `equalis|levy` ledgers — sheet2 is expected empty
  on this company; any row is operator-supplied (Manual sheet).

### 3.4 Source choice

Rides the existing `tb_tds_review` channels unchanged: `dayBookPath` first (zero downstream
calls), live Tally the fallback. The 21(b) review runs strictly **after** a TDS review in the
same session and consumes its cache — it never fetches on its own.

---

## 4. The law (sourced), with captain confirm points

Form 3CD clause 21(b) (as restated by CBDT **Notification No. 23/2025 dt 28-Mar-2025
(G.S.R. 207(E))**, effective 1-Apr-2025 — the amendment touched clause **21(a)** regulatory
settlement; 21(b)'s four deductee tables are unchanged): *"Amount inadmissible under section
40(a)(i), 40(a)(ia), 40(a)(ib) and 40(a)(iii)"*, one deductee-wise table per sub-section —
exactly the workbook's four sheets.

| Provision | Trigger | Disallowance | Cure provisos (source) |
|---|---|---|---|
| 40(a)(i) | interest/royalty/FTS/any TDS-liable sum payable outside India or to a non-resident; TDS not deducted, **or deducted but not deposited by the s.139(1) due date** | 100% | (a) deduct in a later year and deposit by that year's return due date → allowed in year of payment; (b) payee (resident) filed return u/s 139, disclosed income, paid tax, payer holds payee's certificate in the prescribed form → deemed compliant (cleartax.in/know-your-tax/section-40a-of-income-tax-act; certificate's exact form → **C10**) |
| 40(a)(ia) | sum payable to a **resident** on which Ch. XVII-B TDS was not deducted, or after deduction not paid on or before the s.139(1) due date | **30%** of the sum | (1) deducted in a later year, or deducted in the PY but paid after the 139(1) due date → 30% allowed in year of payment; (2) not in default under the first proviso to s.201(1) (resident payee filed return + paid tax) → deemed deducted and paid on the payee's return-furnishing date. Short deduction: mainstream view = 30% of the **un-deducted base only** (taxguru.in › home › income-tax › section-40a-ia; some ITAT authorities contra — noted, not engine-relevant since the agent computes no percentages) |
| 40(a)(ib) | sum paid/payable to a **non-resident** e-commerce operator for a *specified service* on which equalisation levy was deductible but not deducted/paid | whole sum | deducted in a subsequent year, or paid after the due date → allowed in year of payment (cleartax). Scope today (s.165 2% withdrawn w.e.f. 01-Aug-2024; s.166 6% online-advertisement levy continues; FA 2025 2% online-goods levy from 01-Oct-2025) → **C12** |
| 40(a)(iii) | salary payable **outside India or to a non-resident**; TDS (s.192) not deducted or **not deposited by the TDS payment due date** (not the 139(1) date) | 100% | secondary sources state a one-day-late deposit is fatal with no proviso; the Act's actual proviso text unverified → **C11** |

Also recorded: 40(a)(iib) (State-Govt undertakings) exists but has **no sheet** in this workbook
— out of scope. The clause-21(b) sub-table numbering as printed in the form (i)/(ii)/(iii)/(iv)
vs the Act's (i)/(ia)/(ib)/(iii) order → **C9** (presentation only; the sheets are authoritative
for routing).

**Confirm markers (the `src/tds-law.ts` convention, continued from C1–C8 of the PF/ESI
feature):** C9 sub-table numbering; C10 40(a)(i) cure-certificate form; C11 40(a)(iii) cure
proviso; C12 equalisation-levy current scope; C13 EXPENSEAMOUNT basis for 194Q rows (full gross
vs liable excess — plan default **full gross**, Winman/auditor applies judgment). Restated with
options in §6 of the implementation plan report.

---

## Live validation

To be completed by the implementing run, against the live company, in the
shape of the PF/ESI design doc's §10 (and §18.1 of the depreciation
verification design before it).

### 10.1 What the implementing run found

**V2 verified against the real workbook; V3 unverifiable from COM (2026-09-25).**
`scripts/verify-winman-roundtrip.mjs --notds` was run against the real
`No TDS Disallowance.xlsm` (18 sheets, AY 2025-2026) — the source was read
only; a scratch copy was filled, one invented sample row into each of the
four sheets at the engine-predicted positions (first data rows 7/7/7/8), and
Excel 16.0 for Windows opened the **filled copy** with no repair prompt:

```
wrote 1 sample row into "40(a)(ia) to resident" (first data row 7, prototype 6)
wrote 1 sample row into "40(a)(i) to non-resident" (first data row 7, prototype 6)
wrote 1 sample row into "40(a)(ib) - Equalisation Levy" (first data row 7, prototype 6)
wrote 1 sample row into "40(a)(iii)" (first data row 8, prototype 7)
PASS  V2 sheet count >= 5 (four data sheets + INTER + extras)
PASS  <each sheet>: V3 visible after WorkBook_UnhideSheets
WARN  <each sheet>: V3 ValidateMandatoryFields  (macro not runnable — Cannot run the macro ...)
PASS  <each sheet>: V2/V3 lastRow == prototype + rows (7/7/7/8)
ROUNDTRIP_OK V2 (V3 unverifiable — validation macro not runnable from COM; V4 import click is the captain boundary)
```

`WorkBook_UnhideSheets` runs fine, but `Application.Run('ValidateMandatoryFields', …)`
fails with "macro may not be available in this workbook or all macros may be
disabled" against this workbook — while the same call works on the PF/ESI
one. Its VBA project is locked for viewing (`Protection = 1`), so the real
procedure name cannot be enumerated from here; `ValidateMandatoryFields` was
transcribed from the PF/ESI workbook and may simply be spelled or placed
differently here. The script treats that specifically as a **WARN**: V2 and
the structural suites still stand, the per-sheet WARN is printed, and the
final verdict names V3 unverified rather than silently passing or failing.

**Synthetic-fixture ceiling:** `makeNotdsFixture()` fills all four sheets
correctly (the V1 evidence lives in `test/notds-write.test.ts`), but real
Excel cannot open the fixture package — its placeholder `vbaProject.bin`
bytes are not a real VBA project. The synthetic workbook is therefore
V1-structural evidence only; Excel-open checks need the real workbook, and
they were run against a copy under `/tmp` (the operator's file itself was
never written to).

**V4 — the Winman import click — is captain-operated and pending** exactly as
with PF/ESI: the operator opens the filled workbook from disk, clicks Copy on
a clause 21(b) sheet and pastes into Winman, then confirms the rows land. Until
that happens the round trip is verified only as far as V1–V2 — a real but
incomplete guarantee. Record the observed result (date, workbook, sheet, rows
landed, any Winman validation message) here once V4 runs.
