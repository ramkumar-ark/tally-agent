# TDS payable statement — design of record

Design of record for the two operator steps that sit on top of the TDS payable
review: a **critical-findings decisions workbook** and the **s.201(1A) TDS
payable statement** the operator uses to pay the challan and file the correction
statement.

Launch brief: `ta-tds-payable-stmt`. Status/inbox:
`/home/ram/firstmate/state/ta-tds-payable-stmt.{status,inbox}`.

## 1. Scope

In scope:

1. A generated, fillable Excel **decisions workbook** listing every
   critical-severity finding of a cached `tb_tds_review` run, with an
   Accept/Reject column and a Remarks column.
2. A strict parse-back of that workbook: unknown finding ids, bad decision
   values and **a workbook generated from a different run** are refused, never
   half-read.
3. A **TDS payable statement** workbook produced only on request, from the
   filled decisions workbook plus a **payment date**, with one row per Accepted
   finding, a totals row and a summary sheet.

Out of scope: TCS-specific columns, any Tally write, generating the FVU/TRACES
correction statement, and any change to how findings or severities are computed.

## 2. Why the No-TDS flow is the pattern

The clause 21(b) lane (`src/notds-template.ts` → `src/notds-file.ts` →
`src/review.ts` → three `register(...)` calls in `src/index.ts`) is the closest
existing shape: a generated workbook on the operator's disk, parsed back
strictly, keyed to a cached run. Every rule below is inherited from it unless
stated otherwise.

**The projector rule (AGENTS.md).** The candidate spine is a **pure projector**
over the engine's own rows — here the cached run's `clause21b` rows joined to the
cached `findings` by `findingId`. It never re-derives a liability predicate, and
it never re-runs the engine.

## 3. Data available, and the one field added

`TdsBooksCache` (private, `src/review.ts`) carries `clause21b`, `liabilities`,
`panOf`, `panDerivedFromGstinOf`, `panAliasOf`, `company`, `fromDate`, `toDate`,
`booksSource`. `lastTds` carries the masked `findings`.

Every critical TDS finding (`tds_not_deducted`, `tds_short_deducted`,
`tds_not_deposited`) is pushed at a site that also pushes one `clause21b` row
carrying the finding's id, so the two are 1:1. The one thing a statement needs
that the row does not carry is the **date the credit was booked**:

- `Clause21bBookRow` gains `deductionDate?: string | null` (additive, optional,
  populated where the joined credit `ded` / the timing-only credit `d` is in
  scope). It adds a fact; **no computation, finding, total or 21(b) sheet value
  changes**, and every existing consumer treats the field as absent.

Rate resolution for a row: the cached `liabilities` entry matching
`party | date | voucherNumber | section` → `.rate`; failing that
`liability / gross` — exact for a 194Q party-month row (its `gross` is
`liable tax / rate` by construction) and for a not-deposited row; and `null`
(blank on the sheet) when neither resolves. **A rate is never guessed.**

## 4. Interest: the existing schedule, re-parameterised to the payment date

**There is no second interest formula.** `src/tds-payable.ts` calls exactly the
three existing helpers from `src/tds-law.ts` — `calendarMonths`, `depositDue`,
`interestOn` — with the same 1% and 1.5% rates, so the statement cannot drift
from the review's s.201(1A) schedule or the 3CD interest rows.

Per Accepted row, on the shortfall tax:

| Finding kind | Interest (i) — 1% | Interest (ii) — 1.5% | "Due date of deposit" column |
|---|---|---|---|
| `not_deposited` (tax was deducted, not deposited) | `interestOn(0.01, calendarMonths(bookingDate, deductionDate), shortfall)` when the credit postdates the booking, else 0 | `interestOn(0.015, calendarMonths(deductionDate, paymentDate), shortfall)` | `depositDue(deductionDate)` |
| `not_deducted` / `short_deducted` (the shortfall is undeducted tax, deemed deducted when the challan is paid) | `interestOn(0.01, calendarMonths(bookingDate, paymentDate), shortfall)` | 0 — `calendarMonths(depositDue(paymentDate), paymentDate)` is 0 | `depositDue(paymentDate)` |

Notes that are decisions, not accidents:

- The late-deposit leg is measured from the **deduction date**, exactly as
  `analyzeTds` and `tds3cd.ts`'s interest rows measure it. The Rule 30 due
  date only decides *whether* leg (ii) is charged at all (payment after the
  due date), never where the clock starts — a leg measured from the due date
  would quietly forgive every month the tax was held before it fell due.
- The undeducted shortfall is deemed deducted **on the payment date**, so its
  late-deposit leg is zero by construction and its deposit-due date is the
  Rule 30 date after the payment. This is the only honest reading: the challan
  pays it on that date.
- A 194Q party-month row is dated to the **month's first day**, exactly as the
  review dates it, so the statement and the review agree on every date.
- `calendarMonths` is Rule 119A(b) calendar-inclusive, so a payment inside the
  booking's own month already counts one month. A payment date before the
  booking yields 0 (the helper's own guard), never a negative.
- A row with no resolved 21(b) facts still appears with its shortfall; its rate
  is blank and its dates are the booking date's own.

## 5. Company vs non-company

From the PAN's **4th character**, `C` = Company — the same fact the review's
`entityOf` reads. The PAN is `panOf(party)`, which already carries a
GSTIN-derived PAN when the ledger master has none (`panDerivedFromGstinOf`
records which). A PAN that is absent, or that does not match the PAN shape,
gives **`Not determinable (no PAN)`** — never a guess, and the summary carries
that as a third bucket so the split always reconciles to the totals.

## 6. The decisions workbook

`src/tds-payable-template.ts`, written through `buildWorkbook` **directly**
(never the de-masking `writeWorkbook`, notds precedent: it carries real party
names on the operator's disk).

Sheets: `Instructions`, `Findings`, hidden `Lists` (the Accept/Reject dropdown,
backed by a cross-sheet range — an inline list is capped at 255 chars), and a
hidden `Run` sheet carrying `Field`/`Value` rows: `company`, `fromDate`,
`toDate`, `asOnDate`, `criticalCount`, and `digest`.

`Findings` columns: Finding ID | Check | Party | Section | Date | Amount paid or
credited | Tax payable | Tax actually deducted | Date of deduction | Rate |
Shortfall to pay | Finding | Decision | Remarks.

**No PAN column** — the PAN reaches only the statement, so a PAN can never ride
an error message out of this workbook.

File name: `tds-payable-decisions-<company-slug>-<YYYYMMDD>.xlsx`.

### 6.1 Run identity — the new check

`digest` = the first 12 hex characters of `sha256` over
`company | fromDate | toDate | asOnDate | criticalCount |` the run's sorted
critical finding ids. The parse-back compares it and **refuses the whole file**
on a mismatch. This is new work: no operator template in the repo has a run
identity today (only the one-directional `Key` join).

The digest is 12 characters and **must never be echoed**: a 6+ digit run inside
it is eaten by `scrubDigits` and a raw echo would both leak and read wrong. The
mismatch message names the field and the remedy, never the value:

> this workbook was generated from a different TDS run — regenerate it with
> tb_write_tds_payable_decisions against the current review

`company`, the three dates and `criticalCount` are named on mismatch; they are
not secrets (they are already in the report filenames) and they tell the
operator what actually moved.

## 7. The parse-back (`src/tds-payable-file.ts`)

`parsePayableDecisions(buf, expected)` reuses `src/tds-file.ts`'s helpers
(`normHeader`, `bindColumns`, `accessors`, `dataRows`, `raw`, `colLetter`) and
the notds error contract verbatim: **every fault cites sheet + Excel row +
column letter with header, never a cell value**; structural problems reject the
whole file; there is no partial mode.

Faults:

- missing `Run` sheet / `Findings` sheet / a bound column missing;
- a `Run` field mismatching the cached run (digest never printed);
- a row whose Finding ID is not one of this run's critical findings;
- a duplicate Finding ID (cites the first row);
- a Decision that is neither blank, `Accept` nor `Reject`.

The parser returns `{ decisions: Map<findingId, "Accept"|"Reject"|null>, missing: string[] }`
— `missing` = ids the run has but the sheet does not. A deleted row is not a
decision, so it lands beside the undecided ones at the statement step.

## 8. Undecided = not finalized

`tdsPayableStatement` refuses while any critical finding is undecided (blank
decision) or absent from the sheet, and **lists the open finding ids and their
party/section** so the operator can finish the workbook. A run with no critical
findings produces no decisions workbook at all (the generator says so and the
statement has nothing to state).

## 9. The statement workbook

`buildPayableStatement`, same channel as the decisions writer (real names and
PANs on the operator's disk only).

`Statement` sheet columns, in the captain's order:
Date of booking | Party | PAN | Company / Non-company | Amount paid or credited |
TDS that should have been deducted | TDS actually deducted | Date of deduction |
Rate of deduction | Shortfall to pay | Interest (i) at 1% | Interest (ii) at 1.5% |
Interest due u/s 201(1A) to `<paymentDate>` | Due date of deposit.
Then the totals row.

`Summary` sheet: the three headline totals (tax, interest, payable = tax +
interest), the same three split **by section** and **by company / non-company /
not determinable**, the payment date, the accepted and rejected counts, and the
semantics note for the expense base (below).

The expense base differs by finding kind, so it is stated once on the Summary
sheet rather than left to be inferred: for `not_deducted` and `short_deducted`
the 21(b) `gross` is the **undeducted portion** of the expense (shortfall tax /
rate), for `not_deposited` it is the **whole booking's base**. That is the
review's own convention and the statement inherits it.

File name: `tds-payable-statement-<company-slug>-payment<YYYYMMDD>.xlsx`.

## 10. Engine changes (the whole list)

1. `src/tds.ts` — `Clause21bBookRow.deductionDate?: string | null`; the same
   optional field on the staged short row; set at the five clause-21(b) push
   sites (per-booking not-deposited, timing-only orphan, 194Q not-deposited,
   194Q not-deducted, short flush). Nothing else in `src/tds.ts` changes.
2. `src/tds-payable.ts` (new, pure) — the projector, the company flag and the
   statement computation.
3. `src/tds-payable-template.ts` (new) — both workbook writers + file names.
4. `src/tds-payable-file.ts` (new) — the strict parse-back.
5. `src/review.ts` — `tdsPayableCandidates()` (undefined before a TDS review)
   and `tdsPayableStatement({decisions?, decisionsPath?, paymentDate})`, which
   returns the masked **counts and money() totals only** — never a PAN, never a
   party name.
6. `src/index.ts` — `tb_write_tds_payable_decisions` and
   `tb_tds_payable_statement`.
7. `src/workflow-registry.ts` + `src/workflow.ts` — a `payableDecisions` input
   (stepOnly generator) and a `tds_payable` step appended **after** `loans**
   (never inserted: AGENTS.md records that inserting a step reshuffles every
   later `01-`/`02-` directory prefix and misreads old workflow folders), with
   `after: ["tds", "notds"]` and a custom handler mirroring `notds`.
8. Docs: `docs/operator/tds-payable-statement.md`, the README tool table, and
   AGENTS.md.

## 11. Tests

- workbook round-trip: decisions workbook → parse → same decisions;
- refusal on an undecided finding, and the message names it;
- refusal on a workbook from a different run (mutated digest) and on an unknown
  finding id, a duplicate id and a bad Decision value;
- the company flag from a PAN (`C` and non-`C`) and from a GSTIN-derived PAN,
  plus the not-determinable case;
- an interest test at a fixed payment date (2026-10-31) checked against
  `interestOn`/`calendarMonths`/`depositDue` from `src/tds-law.ts`;
- the `deductionDate` addition changes no existing finding or 21(b) value
  (the existing suite is the guard — plus a direct assertion on a new row).

## 12. Live verification

Narayanan Construction FY 25-26, the v15 review data already in
`/home/ram/tally-reports` (or a fresh read-only pass of live Tally on port
9000 — `TALLY_ALLOW_WRITES` unset, never port 9001). New **versioned** output
names, never overwriting an existing file there; the captain's operator
templates and the original Winman workbooks are never modified. The sample
statement is built from a **copy with every critical finding marked Accept** and
payment date **2026-10-31**. Counts and totals go in the status `done` line;
**PANs never leave the workbook** — not into the status file, not into chat.