# Single-ledger scrutiny (Milestone 3) — design

### 1. Scope and requirement mapping

| Requirement | Where |
|---|---|
| R-MCP-6: every new read tool goes through the masker and the leak test | Tasks 4, 6, 8 |
| R-R-4: ledger scrutiny sheet in the MD+CSV pattern | Task 7 (`writeLedgerReport`) |
| Canon §5.7: non-vacuous leak secret | Task 4 (`Zenith Logistics`, `918020045566771` added to fixture *and* manifest; Task 8 asserts the finding that carries them fires) |
| Depends on M1 id-keyed drill-down | `tb_ledger_scrutiny` resolves ids through the existing `realLedgerByFinding` map |
| Depends on M2 for GST-relevant ledgers | the ledger's GSTIN comes from `ledgersTax` (M2), leaves only as a `TaxId N` alias (M2 tax-ID channel), and feeds checks 10 and 11 |
| Excluded: named lookup, Excel, write path, `tally_get_ledger` | enforced by Global Constraints and the unchanged ban tests |

### 2. Tools (registry 7 → 9)

**`tb_ledger_scrutiny({ findingId, fromDate, toDate })`**
- Resolves `findingId` → real ledger name via the session's `realLedgerByFinding`. TB ids from `tb_review`, book-party GST ids from `tb_gst_mismatch`, and LS ids from an earlier scrutiny are all registered there. It uses the session's last company.
- Validation, in order, with exact messages:
  1. `fromDate`/`toDate` must match `/^\d{8}$/` and `fromDate <= toDate`; otherwise `fromDate and toDate must be YYYYMMDD, with fromDate on or before toDate`.
  2. An unknown id gives `unknown finding id: <id>`.
  3. No classifier gives `run tb_review first: the group tree is not loaded`.
- Returns `LedgerScrutinyResult` as JSON (§6).

**`tb_write_ledger_report({ company, scrutinyId, markdown })`**
- `index.ts` keeps `scrutinies: Map<scrutinyId, LedgerScrutinyResult>`; a re-scrutiny of the same ledger replaces the entry.
- An unknown scrutinyId gives `run tb_ledger_scrutiny first: there is no scrutiny result for <id>`.
- Writes `ledger-scrutiny-<slug(company)>-<slug(scrutinyId)>-<from>-<to>.md` and `ledger-findings-<same stem>.csv` through `findingsCsv` (de-masking).
- *Why the opaque id in the file name:* the returned paths go back to the model, so a ledger name in a path would leak it.

Sorted registry after M3: `tb_gst_mismatch, tb_gst_summary, tb_ledger_activity, tb_ledger_scrutiny, tb_list_companies, tb_review, tb_write_gst_report, tb_write_ledger_report, tb_write_report`.

*Decision (one scrutiny tool, not several):* the checks all need the same three fetches, and a single call keeps the model from assembling partial views. `tb_ledger_activity` stays as the raw-rows drill-down.

### 3. Data sources (fetched in parallel by the session)

| Need | Source | Why this source |
|---|---|---|
| Ledger's group and GSTIN | `d.ledgersTax(company)` (verbose `tally_get_ledgers`, M2) | Already scalar-only (no address/bank). Also refreshes `groupOfLedger` for counterparty masking |
| Opening balance | `d.trialBalance(company, dayBefore(fromDate))`, row matched by `canonicalKey`, missing row = 0 | `tally_trial_balance` is date-bounded and **positive = debit**. The ledger master's `OPENINGBALANCE`/`CLOSINGBALANCE` are raw Tally sign (negative = debit) and `CLOSINGBALANCE` is not date-bounded, so they cannot be used |
| Closing balance | `d.trialBalance(company, toDate)` | same |
| Entries | new `d.ledgerVoucherRows(company, real, fromDate, toDate)` | Typed and signed version of the existing `tally_get_ledger_vouchers` envelope. The report carries no running balance; the downstream chunks it monthly and dedupes |

Downstream row facts, from the sibling `tally_prime_mcp_server/src` (`tools/reads.ts`, `xml.ts:324`):
- `matchedSide` is `"debit"|"credit"` live (older recordings `"Dr"`), and `amount` is absolute.
- `matchStatus` is one of `matched|ambiguous|unmatched`.
- `matchCandidates` holds voucher numbers/GUIDs.
- `taxBreakup = { taxableAmount, taxLedgers:[{ledgerName, amount}], totalTax, effectiveRatePct ("" if n/a), taxStatus: "matched"|"no-tax-rows"|"ambiguous-shared"|"inconsistent" }`.
- Live Tally was unreachable during planning, so these facts come from the downstream source and the recorded fixtures.

`ledgerVoucherRows` drops at the boundary, counted as `rowsDropped`: undated rows, rows outside `[fromDate, toDate]`, and rows with no readable side (`matchedSide` d/c first, then non-zero `debit`/`credit`).
- `counterparty = counterLedgerName || partyLedgerName`.
- `amount = sign × |amount ?? matchedAmount|`.
- `tax` keeps only `effectiveRatePct` (number or null) and `taxStatus`. Tax ledger names are deliberately not carried.

### 4. Identity

- `ledgerSeqByKey: Map<canonicalKey, number>` in the session. The first scrutinised ledger is 1, the next 2, and so on, stable for the session. `scrutinyId = "L" + seq`.
- Finding ids are `LS-<seq>-<ordinal3>-<n>`, where `n` counts per check starting at 1. They live in their own ordinal space (`LEDGER_CHECK_ORDINAL`, never renumbered), like `GST-`.
- *Why the seq in the id:* `realLedgerByFinding` is session-global, so two ledgers' `LS-001-1` would collide without it.
- Every LS id is registered in `realLedgerByFinding`, so `tb_ledger_activity` and a re-scrutiny over another period both accept LS ids.

### 5. The eleven checks (pure, `src/scrutiny.ts`)

Rows are stably sorted by date first. Findings come out in ordinal order. Severity is fixed by the rule, never by the model. `bal(n)` renders `82,500.00 Dr` / `12,500.00 Cr` / `nil`.

| # | check id | severity | rule | amount |
|---|---|---|---|---|
| 1 | `ls_opening_closing_mismatch` | warning | \|closing − (opening + net movement)\| > `TOTALS_TOLERANCE` (0.05) | \|difference\| |
| 2 | `ls_wrong_side_during_period` | critical for role `cash`, else warning | end-of-day running balance from opening is on the wrong side on any posting day. Expected side by role: debtor Dr, creditor Cr, cash Dr, expense Dr, income Cr, stock Dr. Other roles are not checked (bank OD is legitimate) | peak wrong-side balance |
| 3 | `ls_duplicate_entry` | warning | ≥2 rows share date + canonical voucherType + canonical counterparty + signed amount (2dp), \|amount\| ≥ 0.005 | the entry amount |
| 4 | `ls_duplicate_reference` | warning | ≥2 rows share canonical voucherType + canonical non-empty reference, with ≥2 distinct non-empty voucher numbers; skipped when all rows share date+amount+counterparty (that is #3) | sum of \|amounts\| |
| 5 | `ls_large_entry` | review | ≥6 rows; \|amount\| > 5 × median \|amount\| | the entry |
| 6 | `ls_round_sum_journal` | review | voucherType contains "journal", \|amount\| ≥ 10,000 and a multiple of 1,000 (±0.005) | the entry |
| 7 | `ls_movement_spike` | review | ≥3 active months; a month's gross (debit+credit) > 3 × median active-month gross | the month's gross |
| 8 | `ls_activity_gap` | review | role expense/income, ≥3 active months; zero-entry months strictly between the first and last active month produce one finding listing them | 0 |
| 9 | `ls_unjoined_rows` | review | rows with matchStatus `ambiguous` or `unmatched` (`unknown` is not counted) | sum of \|amounts\| |
| 10 | `ls_gst_rate_nonstandard` | review | tax.taxStatus `matched`, effectiveRatePct non-null and more than 0.1 pt from every slab in `[0,0.1,0.25,1,1.5,3,5,6,7.5,12,18,28,40]` | the entry |
| 11 | `ls_gst_untaxed_supply` | review | ledger has a GSTIN, voucherType contains purchase/sales, tax.taxStatus `no-tax-rows` | the entry |

*Decisions:*
- Thresholds are constants, not tool parameters: repeatable output, and no model-tunable severity.
- End-of-day balances stop a same-day receipt and payment reading as an intra-day flip.
- #9 exists because the duplicate and GST checks trust voucher numbers and tax breakups that an ambiguous join makes unreliable; the finding tells the reviewer so.
- #1 can fire when the ledger report omits optional/post-dated vouchers or a month. The detail says so rather than guessing which.

### 6. Session masking and result shape

In `ledgerScrutiny`, after `scrutinize(...)`:
1. `ledger = maskLedgerName(real, group, classifier, vault)`. If the master has a GSTIN, `vault.pseudonym(gstin, "tax_id")`.
2. For each finding:
   - `realLedgerByFinding.set(f.id, real)`.
   - Vault each counterparty via `maskLedgerName(cp, groupOfLedger.get(canonicalKey(cp)) ?? "", c, vault)`. A counterparty with an unknown group default-masks as `Ledger N`.
   - `detail = scrubSecrets(maskKnownNames(detail, vault))` and `group = scrubSecrets(group)`.

This is exactly the M2 order: vault first, then sweep, with `redactTaxIds`/`scrubDigits` behind it.

```ts
LedgerMaskedFinding { id, check, severity, ledger, group, amount, side, expected, detail }   // CsvFinding-compatible
LedgerScrutinyResult {
  scrutinyId, findingId, company?, ledger /*masked*/, group, role, fromDate, toDate,
  registeredForGst: boolean /* never the GSTIN */, opening, closing, totalDebit, totalCredit,
  netMovement, rowsScanned, rowsDropped, months: MonthMovement[], counts: Record<Severity, number>,
  findings: LedgerMaskedFinding[]
}
MonthMovement { month: "YYYY-MM", debit, credit, net, entries }   // every month from..to, zeros included
```

Audit entries:
- `audit("tb_ledger_scrutiny", args, rowsScanned, maskedCount(findings))`.
- `audit("tb_write_ledger_report", { company, scrutinyId }, findings.length, 0)`, plus the vault dump when enabled.
- The server `instructions` text mentions scrutiny.

### 7. The nested-field masking gap (fixed in-plan, tightens the boundary)

`maskVoucherRow` (behind `tb_ledger_activity`) today masks and sweeps **top-level** strings only. The live row nests `taxBreakup.taxLedgers[].ledgerName` and `matchCandidates[]`; the latter can carry a digit-bearing voucher number, and the new fixture row proves it leaks.

Task 4 makes it recursive in two passes over every depth:
1. Keys in `NAME_FIELDS = {partyLedgerName, counterLedgerName, matchedLedgerName, ledgerName}` get `maskLedgerName`.
2. Every string gets `scrubSecrets(maskKnownNames(s, vault))`.

This only tightens what already leaves the gateway, so it needs no `needs-decision`.

### 8. Fixture expectations (the Acme creditor, TB-004-1, 20250401–20260331)

The fake downstream returns the same trial balance for any date: acme traders 41,250 Dr. The fixture ledger report has 4 rows after Task 4. The result, captured from a spike run:
- `scrutinyId L1`, `ledger "Creditor 1"`, group `Sundry Creditors`, role `creditor`, `registeredForGst true`.
- opening 41250, closing 41250, totalDebit 66250, totalCredit 25000, net 41250, rowsScanned 4, rowsDropped 0, 12 months.
- findings `LS-1-001-1` (mismatch 41,250), `LS-1-002-1` (wrong side, peak 82,500), `LS-1-004-1` (duplicate reference ZL/77, 25,000), `LS-1-006-1` (round journal 25,000), `LS-1-009-1` (2 of 4 unjoined), `LS-1-010-1` (13.50%, "registered as TaxId 1").
- counts `{critical 0, warning 3, review 3}`.

### 9. Known limitations (documented, not fixed)

- The free-text sweep catches only names the vault knows (M1 limitation, unchanged).
- A digit-bearing voucher number in a detail reads `PUR/[number]`, by the same M1 `scrubDigits` rule.
- The gateway's M1 `ledgers()` parse passes Tally's raw master sign (negative = debit) through unflipped, so M1's `dormant_balance` side may be inverted on live data. It is not verified live because Tally was unreachable, and it is **out of M3 scope**; see Recommendations. M3 avoids the issue by reading balances only from `tally_trial_balance`.
