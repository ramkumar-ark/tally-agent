# Winman Form 3CD clause 18 depreciation — design of record

Status: implemented 2026-09-27 on branch `fm/ta-3cd-depreciation`. Engine `src/dep3cd.ts`,
law table `src/dep3cd-law.ts`, operator template `src/dep3cd-file.ts`, writer
`Session.write3cdDepreciation` (`src/review.ts`), report `writeDep3cdReport`
(`src/report.ts`), four tools in `src/index.ts`.

This document is the plan's §1–§4 with the captain's answers applied (see §5). §10 records
the verification ladder results.

## 1. The workbook's actual schema

### 1.1 Package

The sheets, in `workbook.xml` order:

| Sheet | Part | Code name | State | Notes |
|---|---|---|---|---|
| Depreciation additions | sheet1.xml | shData1 | hidden | |
| Depreciation deletions | sheet2.xml | shData2 | hidden | |
| Sheet3 … Sheet15 | | | hidden, unused | A1 is empty |
| INTER | sheet16.xml | | hidden | |
| Help | sheet17.xml | | hidden | |
| Enable Macros | sheet18.xml | | visible | |

The package also holds `vbaProject.bin`, drawings, ctrlProps, 8 JPEGs and printerSettings. `writeSheetRows` copies all of these verbatim, which the probe confirmed.

**INTER row 1:**

| Cell | Value | Meaning |
|---|---|---|
| A1 | `$WiNsArAlXlImPoRt2$` | handshake marker |
| B1 | `9.6.1` | version |
| C1 | `1623` | build |
| D1 | `2026-2027` | assessment year |
| E1 | `F` | |
| F1 | `#DepreciationNew$1214\|` | new compared with the PF/ESI workbook; unused by us and left byte-identical |
| G1 | `1` | validation on |

### 1.2 "Depreciation additions" (clause 18, field path `1.05.01.*.00.00`)

- Row 1 (hidden): A1 `DepreciationNew`, B1 `Depreciation additions`, C1 `7`, D1 `1.05.01.*.00.00`.
- Headers sit on rows 4–5.
- Row 6 is the hidden all-`-` prototype. Data starts at row 7.

| Col | Row-2 key | Header | Prototype style → data twin | We write |
|---|---|---|---|---|
| A | `FISTCOL` | Additions in detail (compulsory for 3CD) | 92 → 77 (text, left) | block text, exactly as in the dropdown |
| B | *(none)* | *(grey)* | 93 | nothing (Winman-computed) |
| C | `DATE` | Date of Purchase | 94 → 86 (`dd\-mmm\-yy`) | first purchase date |
| D | `AMOUNT` | Amount | 95 → 89 (`#,##0`) | purchase + attributable charges − reductions |
| E | `DEPRECIATION` | Additional Depreciation ? | 96 → 81 (text, centre) | `N/A` always |
| F | `TOUSE` | Date put to use | 94 → 86 | same as C (captain rule) |
| G | `APPLICABLE` | Adjustments if applicable | 92 → 77 | omitted (C10) |
| H–K | *(none)* | *(grey)* | 97 | nothing (Winman-computed) |

Data validations on this sheet (named ranges in `workbook.xml`):

| Range | Named range | Points at | Values |
|---|---|---|---|
| `A6:A1000` | `Sheet_1_ListCol_1` | `INTER!$A$8:$A$16` | `1. Buildings 5%:`, `2. Buildings 10%:`, `3. Buildings 40%:`, `4. Furnitures/ fittings 10%:`, `5. Plant/ Machinery 15%:`, `6. Plant/ Machinery 30%:`, `7. Plant/ Machinery 40%:`, `9. Ships/ vessels 20%:`, `10. Intangible assets 25%:` |
| `E6:E1000` | `Sheet_1_ListCol_5` | `INTER!E18:E20` | `N/A`, `No`, `Yes` |
| `G6:G1000` | `Sheet_1_ListCol_7` | `INTER!G22:G25` | `-`, `Cenvat Credit reversal`, `Exchange rate effect`, `Subsidy refund` |

Notes on the A-column list:
- There are 9 values, each with a trailing colon, and there is no item 8.
- The A-column validation has `errorStyle="warning"`, so Excel would accept a wrong string. The writer must therefore enforce the list itself (Task 2, Task 9).
- The list values sit in INTER as shared strings.

### 1.3 "Depreciation deletions" (field path `1.06.01.*.00.00`)

- Row 1 has the same shape as additions: form id `DepreciationNew`, sheet key `Depreciation deletions`, first data row 7.

| Col | Row-2 key | Header | Twin | We write |
|---|---|---|---|---|
| A | `DELETIONDTLS` | Deletions in detail (compulsory for 3CD) | 92 → 77 | block text |
| C | `DATE` | Date | 94 → 86 | sale voucher date |
| D | `AMOUNT` | Amount | 95 → 89 | **actual consideration received** |
| E | `HALFADD` | Deduct from 2nd half additions ? | 96 → 81 | `No` by default (C8) |
| F | `DEPN` | Reduce additions for addnl. Depn.? | 96 → 81 | `No` always (additional depreciation is N/A) |
| G | `APPLICABLE` | Adjustments if applicable | 92 → 77 | omitted (C10) |

Data validations on this sheet:

| Column | Named range | Points at | Values |
|---|---|---|---|
| A | `Sheet_2_ListCol_1` | `INTER!A27:A36` | the same 9 values as additions **plus `8. Plant/ Machinery 45%:`** |
| E | `Sheet_2_ListCol_5` | | {`No`, `Yes`} |
| F | `Sheet_2_ListCol_6` | | {`No`, `Yes`} |
| G | `Sheet_2_ListCol_7` | | {`-`, `Cenvat Credit`, `Exchange rate effect`, `Subsidy received`} |

The 45% item exists only on deletions. It is the Appendix I rate for motor cars acquired between 23-Aug-2019 and 31-Mar-2020, so such a block can shrink but can never take an addition.

### 1.4 What Winman computes itself

The workbook never computes these, so we must not send them:
- the grey columns B and H–K. They have no row-2 key, and Help row 12 says "Do not fill the grey colored columns … calculated automatically in Winman";
- the entire clause-18 block computation: opening WDV, rate, depreciation (full or half rate by the put-to-use date), closing WDV and s.50 gains. None of these has a column.

The opening WDV comes from Winman's own prior-year data. Our job is only the itemised additions and deletions.

### 1.5 VBA contract

- Module1 is Winman's generic module (CommonCopy, Hide/Unhide, BeforeSave, ValidateMandatoryFields). shData1 and shData2 only call `CommonCopy(Me.Name)`.
- There is no depreciation-specific macro.
- No row-2 key contains `+`, so `ValidateMandatoryFields` passes.
- B2 is empty, so `End(xlToRight)` from A2 jumps to C2. That is harmless; the loop simply finds no mandatory key.
- Result: the PF/ESI V2/V3 harness applies unchanged, once it is parameterised by sheet (Task 11).

### 1.6 Foundation fit (why only one extension)

`readSchema`, `readHandshake`, `resolveStyleTwins` and `writeSheetRows` work on this workbook as-is:
- all four twins already exist in `styles.xml`, so there is no style edit;
- rows before 7 stay byte-identical;
- a re-run overwrites the rows.

The one thing the foundation cannot do is read a dropdown's value list. This sheet needs that because the first column must carry one of the workbook's own block strings, character for character. Without the list the writer could only hard-code strings that Winman changes between versions (it already did: item 8 is missing from additions). Task 2 therefore adds `readListValues` to `src/winman3cd.ts`. It is additive, and nothing existing changes.

---

## 2. What the books show (FY 25-26, counts only)

**Fixed-asset tree:** a `Fixed Assets` primary group with three children, `Block 10%`, `Block 15%` and `Block 40%`, holding 147 ledgers. One further ledger sits directly under `Fixed Assets` and is a control account.
- The group names carry only a rate, not an asset class.
- Ledger names carry GST suffixes (`- 18%`), so rates must never be read from ledger names (the existing D-rule).

**29 vouchers touch an asset ledger in the year:**
- 19 carry additions.
- 1 is a sale invoice, and 4 carry the sale and P/L-on-sale entries.
- 2 are debit-note or return entries, one of them the purchase-reduction debit note.
- 3 are year-end depreciation journals.

**Additions: 16 acquisitions across 15 ledgers**
- 15 are in Block 15% and 1 in Block 40%. None are in Block 10%, so the 10% ambiguity (C9) does not affect this year's rows.
- Purchase-class voucher types seen are `Purchase` and `GST/inwrd/Txble`. Both start acquisitions.

The patterns the engine must handle, each seen live:

1. **One vehicle, six debits, one addition.** A car was bought on a `GST/inwrd/Txble` voucher. The same day, two Journals from the same dealer added registration and insurance. Twelve days later a bank Payment added a fancy-number fee, and 39 days later a Journal added an accessories kit. All six belong to one row, dated at the purchase date. The existing `groupAcquisitions` gets this right for journals from the supplier, but not for the general rule below.
2. **Two purchases in one ledger.** Two separate `Purchase` vouchers were posted on the same day, from the same supplier, into the same ledger. They cover two units for two sites. The captain's "beware" case says these are two rows. The existing 90-day same-party merge would wrongly fold them into one.
3. **Two assets in one purchase voucher.** One voucher debits two different ledgers, which gives two rows.
4. **A capitalised fee long after purchase.** A road-roller registration fee was paid from the bank 68 days after the purchase. It attaches to the purchase, and the date stays the purchase date (captain rule; C2).
5. **A purchase reduction.** A `Debit Note` from the supplier, 1 day later, credits the asset ledger. It nets off the acquisition cost.
6. **An attributable charge expensed in the purchase voucher.** A loading/unloading line in the purchase voucher went to a Purchase Accounts ledger, not the asset. Per Q3 it is **not** added to the Winman amount (C4 override).
7. **A supplier outside the usual supplier groups.** One supplier sits under a Current Assets sub-group. Acquisition starts must therefore key on the voucher type, not on the supplier's group.

**Deletions: 3 assets sold, all in Block 15%**
- **Sale through a disposal ledger.** A `Fixed Asset Sale` invoice credits a Sales-Accounts disposal ledger at the taxable value, with output CGST and SGST on top. A Journal then moves that exact taxable value off two asset ledgers, split per asset. Two separate Journals post the book gain or loss against a `Profit on Sale…` ledger (Indirect Incomes) and a `Loss on Sale…` ledger (Indirect Expenses).
  - One of those P/L journals **debits an asset ledger**. The engine must never read that debit as an addition.
  - Consideration per asset = its share of the moved taxable value. The GST is excluded, and the P/L journals are ignored.
- **Sale straight to a buyer.** A Journal debits a buyer's party ledger (a Current Assets sub-group) and credits the asset ledger. A second Journal posts the loss against the asset. Consideration = the party debit.

**Other observations**
- The `ledgers[]` entries in this export carry `{name, parent}` only. There is no `openingBalance`, because the day book predates the export upgrade.
- The design does not depend on openings: Winman owns the opening WDV.

---

## 3. Design

### 3.1 Approaches considered

| Approach | Verdict |
|---|---|
| A. Reuse `analyzeFaRegister`'s purchases and disposals directly | Rejected. It merges same-party purchases within 90 days (pattern 2). It records disposals at the **asset-ledger credit**, which is book value or net of P/L (the captain's explicit warning). It is fed per-ledger Ledger-Vouchers rows, which cannot see a voucher's other lines, and consideration needs those lines. |
| B. A new pure voucher-level engine `src/dep3cd.ts` that reuses the depreciation module's **constants and law helpers** (`EXPENSE_ROOTS`, `INCOME_ROOTS`, `MONEY_ROOTS`, `SUPPLIER_ROOTS`, `DEPRECIATION_NAME`, `WRITEOFF_NAME`, `parseRateFromGroup`, `isShortPeriod`, `NETTING_WINDOW_DAYS`) but has its own grouping | **Chosen.** Additions and deletions are voucher facts: the voucher type, the other lines, and the GST lines. The engine stays small and testable. |
| C. Extend `groupAcquisitions` with a mode flag | Rejected. It would change the grouping the depreciation review relies on (live-verified, design §10). The existing callers must not move. |

**Channel.** The input is the day book (`dayBookPath`, required in v1). Live Tally's Ledger Vouchers returns per-voucher display rows with a single counterparty, and the consideration rule needs the whole voucher. The gateway's SDK transport also cannot carry a whole-FY day book (AGENTS.md). A live fallback is listed as open question Q1.

### 3.2 Data flow

```
dayBookPath ──readDayBook──► VoucherRow[] (positive = debit, flipped once at load)
                         └─► groups/ledgers (masters) ──► chainOf / isAssetLedger
templatePath ─parseDep3cdTemplate─► Dep3cdOperator (group/ledger→block, adjustments)
sourcePath? ──readListValues──► block lists (else template's hidden list, else DEFAULT_BLOCK_LISTS)
                                     │
            analyzeDep3cd(vouchers, ctx) ─► { additions[], deletions[], findings[] } (raw, real names)
                                     │
Session.dep3cdReview ─ caches raw rows ─► masked view to the model (ledger pseudonyms, displayDate)
Session.write3cdDepreciation ─► copy of the operator's workbook: block text/dates/amounts/Yes-No only
writeDep3cdReport ─► report workbook on disk (de-masked through the vault)
```

**Privacy simplification.** The Winman rows carry **no names at all**: only the block text (a Winman constant), dates, amounts and N/A/Yes/No. The writer therefore needs no vault de-masking, unlike loans. Real ledger names reach disk only through the report workbook, via the existing `writeWorkbook` vault path. The model sees masked ledgers, the clear block text, `displayDate` dates and numeric amounts. `money()` is used in details.

### 3.3 Movement classification (per asset-ledger entry, voucher level)

For each voucher that isn't cancelled, and each entry on an asset ledger, compute three things:
- `counter` = `counterpartyOf(v, i)` from `src/tds-daybook.ts`, which is the largest opposite-sign line;
- `chain` = the canonical ancestry of the counter;
- the voucher's other lines.

| Asset side | Condition, in order | Kind |
|---|---|---|
| debit | counter matches `SALE_PL_NAME` or counter chain hits an income root | `sale_pl` (never an addition) |
| debit | counter is an asset ledger | `transfer` |
| debit | `PURCHASE_VOUCHER.test(voucherType)` | `purchase` |
| debit | otherwise | `capitalised` |
| credit | counter chain hits an expense root and counter matches `DEPRECIATION_NAME` | `depreciation` |
| credit | counter matches `SALE_PL_NAME`, or expense root + `WRITEOFF_NAME` | `sale_pl` |
| credit | counter is an asset ledger | `transfer` |
| credit | `/debit note\|purchase return/i` voucher type, or counter chain hits `SUPPLIER_ROOTS` | `reduction` |
| credit | counter chain hits an income root (disposal ledger) | `consideration` (basis `transfer`) |
| credit | counter chain hits a money root, sundry debtors, or current assets | `consideration` (basis `receipt`) |
| credit | otherwise | `unclassified` → critical finding D3CD-003, no row |

Constants (Task 1):
- `PURCHASE_VOUCHER = /purc|inw(a)?rd/i` (C5);
- `SALE_PL_NAME = /(profit|loss|gain)\b.{0,12}\b(sale|disposal)/i`.

The root sets are imported from `src/depreciation.ts` (Task 3 exports them additively).

### 3.4 Acquisitions (additions)

Per asset ledger, movements are sorted by `(date, voucherNumber)`.

**Purchases**
- Each distinct purchase-class voucher starts **its own** acquisition. This covers pattern 2.
- Several lines on the same ledger within one voucher merge into that voucher's acquisition.

**Capitalised debits** attach to the latest acquisition in the ledger dated on or before the debit. If there is none, they attach to the earliest acquisition within `NETTING_WINDOW_DAYS` after the debit (a fee paid just before the invoice). If there is still none, they become an **orphan** acquisition with their own date, flagged D3CD-008 (C13).

**Reductions** attach to the latest acquisition in the ledger dated within `NETTING_WINDOW_DAYS` before the reduction, same counter first. Otherwise they are unattributed: D3CD-007, not applied.

**Same-voucher attributable charges** (C4, **disabled per Q3**):
- In each purchase voucher, debit lines on non-asset ledgers whose name matches `CHARGE_NAME` would be added to that voucher's acquisitions.
- This is gated by `INCLUDE_SAME_VOUCHER_CHARGES`, shipped `false`: an expensed charge is **not** added to the tax cost and D3CD-010 never fires. The tax cost therefore equals the asset-ledger debits.

**Cash parts over ₹10,000** (Q9): a capitalised or purchase part whose counter is on the cash-in-hand chain and exceeds `CASH_COST_LIMIT` (10,000) is **excluded** from the amount and flagged D3CD-011 (s.43(1) third proviso).

**Multiple purchases in one ledger:** a ledger with two or more non-orphan acquisitions gets D3CD-009. This is a review advisory that states the count and dates, so the operator can confirm the split or merge it.

**Operator adjustments** (template "Adjustments" sheet, keyed by ledger + date + voucher number):

| Action | Effect |
|---|---|
| `New purchase` | A capitalised debit starts its own acquisition. |
| `Merge into earlier purchase` | A purchase joins the previous acquisition in its ledger. |
| `Exclude` | The movement is dropped. |
| `Consideration` | Overrides a deletion amount. |
| `Deduct from 2nd half` | Sets HALFADD to Yes. |

**Row mapping**
- `purchaseDate` = the acquisition's first purchase date.
- `putToUse = purchaseDate` (C1).
- `amount = round2(sum of parts)`.
- `secondHalf = isShortPeriod(purchaseDate, toDate)` is reported only; Winman applies the half rate.

### 3.5 Disposals (deletions: actual consideration)

Group the `consideration` movements by voucher.

**Basis `transfer`** (counter is an income-root disposal ledger): consideration = the asset credit itself. That journal moved the sale value.

**Basis `receipt`** (counter is money, debtor or party):
- pool = Σ debits on the voucher's money/party lines − Σ credits on its tax lines (`TAX_NAME` or the Duties & Taxes chain).
- With one asset credited, that asset's consideration = pool.
- With several assets credited, the pool is apportioned pro rata by asset credit and flagged D3CD-004.
- This is exactly the case where "Dr Bank 3,00,000 / Cr Asset 2,50,000 / Cr Profit on sale 50,000" must give **3,00,000**, not 2,50,000.

**Excluded throughout:** P/L-on-sale lines (`sale_pl`), GST (C6), and depreciation.

**Reconciliation:**
- For each disposal ledger, Σ `transfer`-basis consideration out of it is compared with Σ its credits in sale-type vouchers, which is the taxable value. A mismatch over ₹1 raises D3CD-005 (warning).
- A disposal ledger credit that has no asset transfer at all raises D3CD-006 (critical): the sale was booked but the asset was never relieved. The operator adds the deletion through an `Adjustments` row whose Action is `Consideration`.

**Split-voucher sale:** if a `receipt`-basis sale's date also carries a voucher crediting a `SALE_PL_NAME` ledger against a money or party line, the consideration may be split across vouchers. That raises D3CD-012 (review).

**Row mapping:**
- `date` = the voucher date.
- `amount = round2(consideration)`, or the operator override.
- `halfAdd = "No"` unless the operator overrides (C8).
- `depn = "No"`.

### 3.6 Block mapping

**Where the list comes from:** block lists are read from the workbook (`readListValues`) when `sourcePath` is given. Otherwise they come from the template's hidden `Blocks` sheet, and failing that from `DEFAULT_BLOCK_LISTS`, copied from the AY 2026-27 v9.6.1 workbook in §1.

**Resolution precedence:** template ledger override > template group mapping > rate inference.

**Rate inference** uses `parseRateFromGroup(group)` from the depreciation module, run against the ledger's nearest fixed-asset group. It collects the list items whose `(\d+)%` equals that rate:
- exactly one candidate → use it;
- none, or more than one → **unmapped**.

With the real list:

| Rate | Result |
|---|---|
| 5 | `1. Buildings 5%:` |
| 10 | ambiguous (Buildings or Furniture) |
| 15 | `5. Plant/ Machinery 15%:` |
| 20 | `9. Ships/ vessels 20%:` |
| 25 | `10. Intangible assets 25%:` |
| 30 | `6. Plant/ Machinery 30%:` |
| 40 | ambiguous (Buildings or P&M) |
| 45 | `8. Plant/ Machinery 45%:` (deletions only) |

**Unmapped ledgers:** a ledger that has a row but no block raises **D3CD-001 (critical)**, and **its row is not written**. The finding names the masked ledger, its rate and the candidates. The template pre-fills every unique inference and leaves the ambiguous ones blank, with a "Candidates" hint.

**Template values not in the list:** a template value outside the list raises D3CD-002 (critical), with no row. The writer re-checks every row against the workbook's actual list and refuses with the offending block text, which is a Winman constant and not sensitive.

### 3.7 Findings: their own ordinal space `D3CD-<ordinal>-<n>`

This follows the DEP-, FA- and AS26- precedent. `CHECK_ORDINAL` is not touched. That matters because the clause-44 (15–18) and loans (19–27) lanes and three unmerged 3CD branches share that table. Never renumber.

| # | Check id | Severity | Meaning |
|---|---|---|---|
| 1 | `d3cd_block_unmapped` | critical | row has no Winman block; not written |
| 2 | `d3cd_block_not_in_list` | critical | template block text not in the workbook list |
| 3 | `d3cd_credit_unclassified` | critical | asset credit matches no rule |
| 4 | `d3cd_consideration_apportioned` | review | one receipt pooled across several assets |
| 5 | `d3cd_disposal_ledger_unreconciled` | warning | disposal ledger credits ≠ assets relieved |
| 6 | `d3cd_disposal_unmatched` | critical | sale booked, no asset relieved |
| 7 | `d3cd_reduction_unattributed` | warning | debit note / return ties to no acquisition |
| 8 | `d3cd_addition_to_existing_asset` | review | capitalised debit with no purchase this year |
| 9 | `d3cd_multiple_purchases_in_ledger` | review | 2+ purchases in one ledger (captain's "beware") |
| 10 | `d3cd_charge_capitalised_for_tax` | review | same-voucher charge added to the tax cost (unreachable in v1; `INCLUDE_SAME_VOUCHER_CHARGES=false`, see §5) |
| 11 | `d3cd_cash_payment_in_cost` | warning | cash part > ₹10,000 in actual cost (s.43(1) 3rd proviso) |
| 12 | `d3cd_consideration_split_voucher` | review | P/L-on-sale receipt beside a receipt-basis sale |
| 13 | `d3cd_masters_absent` | critical | day book carries no groups/ledgers; asset ledgers unknowable |

Details use `money()` and `displayDate()` only. They quote a ledger's whole name or nothing; never a fragment of it.

---

## 4. Law and confirm points (C-markers)

The law is the Income-tax Act 1961 and the Income-tax Rules 1962. AY 2026-27 / FY 2025-26 is still assessed under the 1961 Act; the 2025 Act starts with tax year 2026-27. The citations are from my working knowledge of the Act and Appendix I. The executor must check every `confirm: true` row against a current bare Act before the law table ships. This mirrors the D1–D8 and TDS C1–C8 practice.

| Marker | Rule adopted (default) | Source | Why confirm |
|---|---|---|---|
| C1 | Date put to use = date of purchase = the first purchase-class voucher date of the acquisition | Captain; s.32(1) second proviso keys on "put to use"; depreciation D8 already uses the entry date as the proxy | The statutory test is put-to-use. A vehicle can't be used before registration. The captain's rule is adopted as instructed. |
| C2 | Later capitalised debits (registration, insurance, number fee, accessories) fold into the first acquisition's amount and keep its date, even when they fall in the second half | Captain; s.43(1) actual cost | A charge incurred after 180-day boundary still gets full-rate treatment through the first date. |
| C3 | Insurance capitalised in the books is included as booked | s.43(1); books | A premium is commonly a revenue item. We follow the books, flag nothing, and ask. |
| C4 | Attributable charges expensed in the purchase voucher (`CHARGE_NAME`: loading, unloading, freight, carriage, transport, installation, erection, commissioning) **are not added** to the tax cost; `INCLUDE_SAME_VOUCHER_CHARGES = false` (Q3 overrode the plan's default) | Captain Q3; s.43(1) | Already decided; tax cost equals the asset-ledger debits. |
| C5 | Each distinct purchase-class voucher (`/purc\|inw(a)?rd/i`: here `Purchase`, `GST/inwrd/Txble`) is its own addition row; Journals and Payments attach | Captain's "beware" | Voucher-type naming is client-specific. |
| C6 | Deletion amount = moneys payable for the asset, **excluding GST** and never the book value or the P/L | s.43(6)(c)(i) "moneys payable … together with the amount of scrap value"; s.50 | Output GST is not consideration for the asset. |
| C7 | Selling expenses are **not** deducted from consideration | s.43(6)(c) (moneys payable); s.48 deductions apply only to s.50 capital-gains computation | |
| C8 | HALFADD = `No`; DEPN = `No` | The workbook documents neither (Help has no text for them) | Winman's semantics are unverified. The operator can override HALFADD per row. |
| C9 | Block mapping by unique rate; `Block 15%` → `5. Plant/ Machinery 15%:` including vehicles (goods vehicles used in own business, not hired out → 15%, not 30%); the template pre-maps `Block 40%` → `7. Plant/ Machinery 40%:` and `Block 10%` → `4. Furnitures/ fittings 10%:` (Q2) | Rule 5 + Appendix I (Part A, III(1) general P&M 15%; motor lorries used in a business of running them on hire 30%; computers incl. software 40%; furniture/fittings 10%; buildings 5/10/40); captain Q2 | Answered. |
| C10 | G "Adjustments if applicable" is left blank, not `-` | Workbook list offers `-` | Blank vs `-` is verified only by the V4 import click. |
| C11 | A cash part over ₹10,000 is **excluded** from the amount and flagged D3CD-011 (Q9 overrode the plan's flag-only default) | s.43(1) third proviso (payment other than a/c-payee cheque/draft/ECS above the s.40A(3) limit is not actual cost); captain Q9 | Answered. |
| C12 | Input GST taken as credit is not in cost (the books already post it to input-tax ledgers); blocked credit (e.g. motor car, CGST s.17(5)) sits in the asset ledger and is included as booked | s.43(1) — tax credit availed is not part of actual cost | |
| C13 | A capitalised debit with no purchase this year is its own addition row, dated at its own date | s.43(1); captain rule silent | It is an improvement to an asset already in use. No case of it this year. |
| C14 | Asset-to-asset transfers make no row within one block; flagged when the blocks differ | s.43(6) block concept | |
| C15 | v1 reads the day book only | AGENTS.md (SDK transport / Ledger Vouchers limits) | Is a live fallback wanted (Q1)? |
| — | Additional depreciation always `N/A` | Captain; s.32(1)(iia) applies to new P&M in manufacture/production or power — not this construction firm | Captain instruction. Not a confirm point. |
| — | Half rate for use under 180 days is Winman's job; we report `secondHalf` only | s.32(1) second proviso; `halfRateBoundary` in `src/depreciation-law.ts` | |
## 5. Captain answers applied (deviations from the plan's defaults)

The plan's open questions Q1–Q11 were answered before implementation. Where an answer
overrode a plan default, the shipped code and this document follow the answer.

| # | Answer | Effect on the plan |
|---|---|---|
| Q1 | Day book only | No live-Tally fallback in v1 (unchanged). |
| Q2 | Template pre-maps `Block 40%` → `7. Plant/ Machinery 40%:` and `Block 10%` → `4. Furnitures/ fittings 10%:`; all vehicles in `5. Plant/ Machinery 15%:` | The template's unique-rate pre-fill still leaves 10% and 40% ambiguous under pure inference; the operator maps them. No goods vehicle is run on hire. |
| Q3 | A charge the books expensed to a non-asset ledger is **not** added | **Override of C4.** `INCLUDE_SAME_VOUCHER_CHARGES = false`; D3CD-010 never fires. Tax cost equals the asset-ledger debits (plus capitalised charges, Q4/Q5). |
| Q4 | Capitalised insurance stays in the amount as booked | C3 unchanged. |
| Q5 | Late capitalised costs keep the first purchase date and full-rate treatment | C2 unchanged. |
| Q6 | Consideration is gross of selling expenses and excludes GST | C6/C7 unchanged. |
| Q7 | Both deletions-sheet flags are `No` for every row | C8 unchanged; they matter only for a same-year purchase sold in the same year, none this year. |
| Q8 | Adjustments column left blank | C10 unchanged. |
| Q9 | A cash part over ₹10,000 is **excluded** from the addition amount | **Override of C11.** The part is dropped from the amount and flagged D3CD-011 (s.43(1) third proviso). |
| Q10 | The control ledger directly under `Fixed Assets` carries no rows; keep it unmapped | No change; if it ever carried a row it would raise D3CD-001 until the template maps it. |
| Q11 | The workbook may be read by the live run | V2/V3 ran against a scratch copy. |

### 5.1 Controller rulings (from the SDD ledger)

- **R1** `INCLUDE_SAME_VOUCHER_CHARGES=false` (Q3): D3CD-010 is defined but never fires.
- **R2** A cash-in-hand part above `CASH_COST_LIMIT` (₹10,000) is excluded from the amount
  and raises D3CD-011 (Q9).
- **R3** The template pre-fills rate 40 → `7. Plant/ Machinery 40%:` and rate 10 →
  `4. Furnitures/ fittings 10%:` (Q2's mapping, applied at generation).
- **R5** A `Consideration` adjustment may match no movement: it then creates the deletion
  (closing D3CD-006). Every other Action still throws when unmatched.
- **R6** The write test pins the DATE cell's real twin style (`s="81"`) and the fixture's
  five pre-data rows; the brief's guessed style and row count were corrected.

Findings 10 (`d3cd_charge_capitalised_for_tax`) is retained in the ordinal table for
forward compatibility but is unreachable while R1 holds.

---

## 10. Live validation

| Level | What | Result |
|---|---|---|
| V1 | Structural: rows below 7 only, pre-7 rows byte-identical, every other entry verbatim, twins applied, lists enforced | Pass — `test/dep3cd-write.test.ts`, `test/winman3cd.test.ts`, `test/xlsm.test.ts` |
| V2 | Excel opens the filled copy with no repair prompt | Pass — `scripts/verify-winman-roundtrip.mjs --sheet "Depreciation additions" --form DepreciationNew` and `--sheet "Depreciation deletions"`, `ROUNDTRIP_OK V2+V3` |
| V3 | Winman macros run: unhide + `ValidateMandatoryFields` True on both sheets | Pass — same run; both sheets visible, `ValidateMandatoryFields` True, lastRow = prototype + rows |
| V4 | Winman import click on the filled copy; clause-18 schedule shows the rows; blank G accepted; HALFADD/DEPN semantics | Captain-manual, pending |

The live run (`tb_dep3cd_review` over the client day book with `Block 40%` mapped)
expects 16 addition rows (15 in `5. Plant/ Machinery 15%:`, 1 in `7. Plant/ Machinery 40%:`)
and 3 deletion rows. Results are recorded below once run.

### 10.1 Live run

Ran 2026-09-26 over the client day-book export (FY 2025-26) with the workbook as
`sourcePath` (block lists read from it) and a template mapping `Block 40%` and
`Block 10%` (both ambiguous by rate) plus `Block 15%`. Counts and per-block totals
only; no names.

| Side | Block | Rows | Amount |
|---|---|---|---|
| Additions | `5. Plant/ Machinery 15%:` | 15 | 1,40,66,502.37 |
| Additions | `7. Plant/ Machinery 40%:` | 1 | 54,618.66 |
| **Additions total** | | **16** | **1,41,21,121.03** |
| Deletions | `5. Plant/ Machinery 15%:` | 3 | 20,14,000.00 |
| **Deletions total** | | **3** | **20,14,000.00** |

Row counts match the expectation above. Findings after the fix: one review
(`d3cd_multiple_purchases_in_ledger`, two purchases on one date in one ledger);
no critical. The first run raised a false critical `d3cd_disposal_unmatched`
because a real company parks its `Profit on Sale of Fixed Asset A/c` **under
Sales Accounts**; the disposal-credit scan now also excludes any ledger matching
`SALE_PL_NAME` (the P/L line beside the asset), while the genuine `Sale of Fixed
Asset A/c` — which does not match that pattern — still reconciles.

Output: a new dated copy `<source> - filled - 20260926.xlsm` in the operator's
Winman folder; the source workbook is never written.
