# Tally Agent — TDS Compliance Review — Design

Date: 2026-09-14
Status: implemented (see commit history on `fm/ta-t-tds-implement`)
Project: tally-agent (local-only)
Depends on: Milestone 1 masking boundary (unchanged), Milestone 2 tax-ID alias channel, `tally_prime_mcp_server` P1 extension is *not* required (graceful absence)

## 1. Purpose and scope

Find TDS compliance gaps from the books and compute the statutory money
figures, all read-only, all masked.

**In scope — FY 2025-26 only** (captain's final word; every legal figure is the
1961 Act for FY 2025-26):

- `tb_tds_review` — read-only review that finds TDS not deducted, short
  deducted, or deducted late; deposits missing or late; statements filed late
  or missing; plus master-gap advisories.
- Statutory money figures: s.201(1A) interest (i) 1%/month (deductible date →
  deduction date) and (ii) 1.5%/month (deduction date → deposit date), TRACES
  calendar-month method (part of a month = full month, Rule 119A(b)); the
  s.234E fee ₹200/day capped at the quarter's TDS; s.40(a)(ia) 30%
  disallowance exposure and s.271C penalty exposure as **review-only
  findings, never payables**.
- Full checks for 194C, 194J, 194-I, 194A (non-bank payer), 194H, 194Q.
  **Timing-only** for 194T (deposit date, interest (ii), statement lateness —
  never rate-recomputed). **192 salary dropped entirely.** No s.195.

**Explicitly out of scope**

- Any write path to Tally; the `tally_get_ledger` ban (R-MCP-3) stands.
- The Day Book (`tally_get_vouchers`) as an input path — 40–53 MB unfiltered,
  wedges live Tally (§5).
- s.195 non-resident deductions; 206AB (omitted from 1 Apr 2025 by FB 2025).
- Deposit-date AO quarterly approvals (confirmed absent by the captain) —
  monthly Rule 30 inspection stands.

## 2. The three data inputs, and what each cannot tell

1. **Books (monthly Ledger-Vouchers reports).** Which section a deduction
   *did* apply to (duty ledger → nature); when tax was booked as deducted and
   deposited (duty-ledger credits/debits); expense booking and payment dates
   to parties; PAN/entity-type per deductee → statutory rate. The month chunk
   is the one working server-side date filter (`tally_get_ledger_vouchers`;
   rows carry `date, voucherType, voucherNumber, reference,
   counterLedgerName/partyLedgerName, amount, matchedSide` — matches on
   `matchedSide` accept both `"debit"/"credit"` and the older `"Dr"/"Cr"`).
   The books *cannot* tell the applicable section when nothing was deducted,
   challan dates (book deposit date is a proxy only), filing dates, s.197
   certificates, 194C(6) declarations, or the s.201(1) proviso's deductee
   filing facts.
2. **Verbose ledger masters** (`tally_get_ledgers` verbose:true, the M2
   channel). Today those return no TDS fields, so every TDS field is read
   **with graceful absence** (P1 upstream task): `pan: string | null` (from
   `IncomeTaxNumber`, trimmed/uppercased like the GSTIN), `isTdsApplicable`,
   `tdsDeducteeType`, `natureOfPayment` — all tolerated as `null/false/""`.
   Missing PAN → aggregate per ledger, not per PAN; missing fields →
   `tds_master_gap` review findings, never guesses.
3. **The operator TDS file** (JSON, read by path only — the M2 `returnsPath`
   pattern; contents never transit the model). Supplies the books-unavailable
   facts: ledger→section and party→section mapping, s.197 certificates,
   194C(6) transporter declarations, challan dates, statement filing dates,
   and the s.201(1) proviso fact (`deducteeFiledReturn`).

## 3. Privacy

- Deductee/party/ledger names default-mask through the existing vault
  (`Creditor N`, pseudonyms) before anything reaches the model.
- PANs travel only as gateway-internal `TaxId N` aliases (M2's
  `vault.pseudonym(pan, "tax_id")` pattern), correlated internally.
- **TANs live only inside the operator file and are never echoed into any
  outbound string** (captain's Q7 choice B): no TAN-redaction *code* change,
  but the leak test (Task 11) asserts a planted TAN never appears in any
  outbound string — a contract, not a filter.
- No real names, PANs, TANs, GSTINs or account numbers in code, tests, docs
  or findings; invented examples only (`Sample Builders LLP`, `Creditor 7`,
  `ABFAA1234A`).

## 4. The `TDS-` finding space

`src/types.ts` gains its own ordinal table (mirroring
`GST_CHECK_ORDINAL` / `LEDGER_CHECK_ORDINAL`; the TB checks and
`CHECK_ORDINAL` are untouched):

| Ordinal | Check | Severity |
|---|---|---|
| 001 | `tds_not_deducted` | critical |
| 002 | `tds_short_deducted` | critical |
| 003 | `tds_late_deducted` | warning |
| 004 | `tds_not_deposited` | critical |
| 005 | `tds_late_deposit` | warning |
| 006 | `tds_statement_late` | warning |
| 007 | `tds_statement_missing` | warning |
| 008 | `tds_deposit_mismatch` | review |
| 009 | `tds_exposure_40a_ia` | review (exposure, never payable) |
| 010 | `tds_exposure_271c` | review (exposure, never payable) |
| 011 | `tds_section_unknown` | review |
| 012 | `tds_master_gap` | review |

`tdsFindingId(check, n)` → `TDS-<pad3>-<n>`; ids are stable across a session.
A `TdsFinding` carries `deductee`, `group`, `section`, `amount` (tax
involved, positive), `detail` (built only via `money()` / `displayDate()` —
every outbound string already passes `scrubDigits`, so bare `100000.00` or a
raw `YYYYMMDD` would be mangled), and an optional `schedule: TdsScheduleRow[]`
for the interest-schedule CSV.

## 5. Data path: hybrid (captain Q8: A)

Default in-tool path: **monthly Ledger-Vouchers reports** per ledger — 5 duty
ledgers (194C contractors, 194A interest other than on securities, 194-I
plant & machinery rent, 194J professional fees; the salary duty ledger is
out of scope) plus the flagged expense/purchase ledgers and every operator-file
ledger, ~640 small calls per FY. Never the Day Book. `fullCheckPath` (an
optional operator day-book JSON export in the upstream `tally_get_vouchers`
row shape) runs the same engine over operator-supplied vouchers to reconcile
and cover payments made through unflagged ledgers; a voucher-ledger pair only
in the operator file raises a review-only coverage finding.

## 6. The law table (FY 2025-26) — `src/tds-law.ts`

Recorded verbatim; **C# = confirm markers from the captain's list**.

| Section | Payment | Rate | Threshold (FY 25-26) | On crossing | Confirm |
|---|---|---|---|---|---|
| 194C | Contract work | 1% individual/HUF; 2% others | > ₹30,000 single, or > ₹1,00,000 aggregate | whole year | C1: threshold figures secondary |
| 194J | Professional / technical fees | 10% professional; 2% technical, call centre, film royalty | > ₹50,000 aggregate | whole year | — |
| 194-I | Rent | 10% land/building; 2% plant/machinery | > ₹50,000 per month or part-month | whole year | — |
| 194A | Interest other than on securities (non-bank payer) | 10% | > ₹10,000 aggregate | whole year | C2: rates-in-force |
| 194H | Commission / brokerage | 2% | > ₹20,000 aggregate | whole year | — |
| 194Q | Purchase of goods | 0.1% (5% without PAN) | > ₹50 lakh per seller per FY, buyer turnover > ₹10 cr | **only the amount after crossing** | C8: captain's correction |
| 194T | Firm → partner remuneration/interest | 10% | > ₹20,000 aggregate | timing-only | — |
| 206AA | Deductee without PAN | higher of section rate or 20% | — | — | — |

Sources: s.194C/J/A text (Indian Kanoon, morphology-consolidated), FB 2025
memo Cl.51–62, F(No.2)B 2024 memo Cl.57/62, s.206AA text, s.194Q text. The
table is date-indexed (`TdsLawEntry`) so TY 2026-27 rows can be added later
without reshaping callers; Rules 218/219 and Forms 138/140/144 (TY 2026-27;
C4) are outside this release.

**Due dates:** deposits Rule 30(2)–(3) — 7th of the following month, March
deductions due 30 April. Statements Rule 31A — 24Q/26Q/27Q due 31 Jul / 31 Oct
/ 31 Jan / 31 May (FY 25-26).

**Interest, the headline method (captain Q5: C; TRACES calendar-month):**
months counted calendar-inclusive (part of a month = full month per Rule
119A(b)); worked example — 28-Jun → 15-Aug = 3 months = 1.5% × 3 = ₹225 on a
₹5,000 deduction. Rule 119A(c) rounds down to ₹100, **applied by default
behind `TALLY_AGENT_TDS_ROUND100_OFF=1`** until C5 confirms. 2025-Act twin
s.398(3)(a) noted (C3).

**Late statement:** s.234E ₹200/day capped at the quarter's TDS; s.271H
(₹10,000–₹1,00,000) not levied when tax/interest/fee paid and the statement is
filed within one month of its due date.

**Exposures (review-only):** s.40(a)(ia) 30% disallowance where TDS not
deducted, or deducted but not paid by the s.139(1) due date; s.271C penalty =
tax not deducted, relieved by s.273B; the s.201(1) proviso (deductee filed a
return and paid tax — an operator-file fact, never book-derived) shields
interest (i), not the finding.

## 7. Engine semantics (`src/tds.ts`, pure)

- **Event model:** an *expense booking* = a **Dr** row on a flagged
  expense/purchase ledger whose counterparty is a TDS-flagged party — the
  expense side of a normal `Dr Expense / Cr Party` voucher; downstream of the
  gateway positive = debit (R-MCP-5), so the engine's predicate is
  `amount > 0` *(amended 2026-09-22: the predicate matched a **Cr** row,
  which never fires for a normal booking and made every real booking
  invisible — see `AGENTS.md`)*; a
  *payment/advance* = a Dr row on that party ledger; a *deduction* = a Cr row
  to a duty ledger joined to the booking by `voucherNumber` when both
  periodic reports name it, else date+counterparty in the same month (±30
  days); a *deposit* = a Dr row to the duty ledger matched to the deduction
  credit by date+amount (the operator challan month, if present, is
  authoritative; a book-vs-file difference is `tds_deposit_mismatch`,
  tolerance ₹1 — the `GST_TOLERANCE` philosophy at a TDS-sized figure).
- **Timing, strict (captain Q3: A):** the deductible date = the earlier of
  the booking (credit to the party, incl. year-end provision/suspense
  credits) and any payment/advance — "whichever is earlier".
- **Section resolution** *(amended 2026-09-16, spreadsheet-input design §8.7:
  "Section resolution: the duty ledger's mapped section for deductions and
  deposits; the booked expense ledger's mapped section for bookings; there is
  no party→section mapping. Unmapped or multiply-mapped →
  `tds_section_unknown`, no interest, never guessed." (was: operator
  `parties[].section` first, then `sections[].section`, then the duty
  ledger's nature-of-payment))*
- **Rate:** PAN 4th char P/H → 194C 1%, C/F → 2%; no PAN → s.206AA higher of
  section rate or 20%, labelled `206AA`; s.197 certificate (operator,
  validity window) overrides within the window; a 194C(6) transporter
  declaration excludes that party's contract payments (review-only variant
  citing the declaration, zero interest).
- **Thresholds:** aggregate gross base per PAN-else-ledger per section; on
  crossing, `wholeYearOnCross(section)` decides whole-year liability; 194Q
  adds only the amount beyond the crossing (C8). Threshold crossings also
  surface an advisory naming the cross month and the applicable rule.
- **Determinism:** findings ordered by dated-earliest event, then deductee,
  then section (the M2 stable-order pattern).

## 8. Report trio (`tb_write_tds_report`)

Mirroring `writeGstReport` and the M1 report-directory boundary (R-R-4):

- `tds-review-<company>-<from>-<to>.md` — Markdown + audit line.
- `tds-findings-<...>.csv` — the findings CSV with the same `findingsCsv`
  de-masking.
- `tds-interest-schedule-<...>.csv` — header
  `id,check,deductee,section,kind,amount,from,to,basis`, de-masked; `kind` is
  `i` (1%/month), `ii` (1.5%/month) or `fee` (₹200/day).

De-masking restores real names/PANs only on the way to disk (R-P-5); TANs
have no de-mask path — they are never vaulted at all (§3).

## 9. Tools and registry

Registry grows 9 → 11: `tb_tds_review` (`{ fromDate, toDate, asOnDate,
tdsFilePath, company?, fullCheckPath? }` → JSON; the file path is audited
like M2's `returnsPath`, its contents never transit the model) and
`tb_write_tds_report`. Findings drill down through the existing
`tb_ledger_activity` / `tb_ledger_scrutiny`.

## 10. Live validation (2026-09-15, Task 13)

Run, without the operator file, against the large live company (kept
nameless here per the privacy brief — real customer data never lands in
docs or code):

- Both the narrow single-month run (April 2025) and the full FY 25-26 run
  completed; wall time ~2 s each once the ~2-minute downstream timeout was
  honored — the earlier 15-minute hangs were the pre-Task-12 dist without
  the verbose-export degradation.
- Master export: 2,695 ledgers load (`mastersAvailable: true`), but **0 ledgers
  carry a PAN and 0 are flagged TDS-applicable** in this company's masters.
- Result: `ledgerCalls: 0`, all checks 0 findings, all totals zero.

What this means: the review's C1-C8 checks identify duty/party/expense
ledgers from Tally's own TDS master flags plus the operator file. This
company's masters carry none of those flags, and the operator file
(ledger-section mappings + parties) is not yet supplied — a separate
captain decision. So this run can conclude only that the pipeline executes
end-to-end on live data with graceful degradation; it cannot confirm any
legal check. Once a company masters its TDS flags — or the operator file
lands — the same tool narrows to the ~640 small per-ledger month calls the
plan priced and produces real findings.
