# Filling clause 18 (depreciation) of the Winman 3CD workbook

This walks through filling the **Depreciation additions** (clause 18, field
`1.05.01`) and **Depreciation deletions** (`1.06.01`) sheets of the Winman
Form 3CD export. The tool reads the operator day book, builds one row per
asset acquisition and one row per sale, and writes a **new dated copy** of the
workbook. The original is never modified.

## The workflow

1. **Generate the mapping template.** `tb_write_dep3cd_template` writes
   `dep3cd-operator-template-<company>-<date>.xlsx` into the report directory.
   Pass it the day-book export (`dayBookPath`) so the fixed-asset groups and
   ledgers come from that export's masters. Pass `sourcePath` = the Winman
   workbook if you want the block dropdowns taken from that workbook's own
   lists (recommended — they are versioned by Winman).
2. **Fill the template in Excel.** Four sheets:
   - **Groups** — one row per fixed-asset group. The **Winman block** column is
     pre-filled when the group's rate maps to exactly one block; the **Candidates**
     column lists the blocks when it does not (10% and 40% are ambiguous).
     Type the correct block from the dropdown.
   - **Ledgers** — one row per asset ledger. Use the **Winman block (override)**
     column only when a ledger must differ from its group (rare).
   - **Adjustments** — optional per-movement corrections, keyed by ledger +
     date + voucher number:
     - `New purchase` — a capitalised debit starts its own row.
     - `Merge into earlier purchase` — joins the previous acquisition in that ledger.
     - `Exclude` — drop the movement.
     - `Consideration` — sets/creates a deletion amount (also used to record a
       sale the books never relieved from the asset ledger).
     - `Deduct from 2nd half` — sets HALFADD to Yes on that deletion.
     Leave the **Amount** blank only on rows that do not need one; a
     `Consideration` row requires an amount.
   - **Blocks** (hidden) — the workbook's own block strings. Leave it alone.
3. **Run the review.** `tb_dep3cd_review` takes `fromDate`, `toDate`,
   `dayBookPath` (required), the filled `templatePath`, and optionally
   `sourcePath` = the Winman workbook (so the lists come from it). It returns
   the additions and deletions **masked** (ledger pseudonyms, no 8-digit runs)
   plus D3CD findings.
4. **Read the findings.** Fix anything critical before writing:
   - `d3cd_block_unmapped` / `d3cd_block_not_in_list` — a row has no block and
     **is not written**; map it in the template and re-run.
   - `d3cd_credit_unclassified` — an asset credit matched no rule; inspect the
     voucher.
   - `d3cd_disposal_unmatched` — a disposal ledger was credited but no asset
     was relieved; add a `Consideration` adjustment.
   - `d3cd_masters_absent` — the day book carried no groups/ledgers; re-export
     the day book with the masters included.
   Advisories (`d3cd_consideration_apportioned`, `d3cd_disposal_ledger_unreconciled`,
   `d3cd_reduction_unattributed`, `d3cd_addition_to_existing_asset`,
   `d3cd_multiple_purchases_in_ledger`, `d3cd_cash_payment_in_cost`,
   `d3cd_consideration_split_voucher`) are for confirmation, not blockers.
5. **Write the copy.** `tb_write_3cd_depreciation` takes `sourcePath` = the
   Winman workbook and writes
   `<stem> - filled - <YYYYMMDD>.xlsm` (or the exact `outPath` when it ends in
   `.xlsm`) into the report directory. It refuses if the workbook is not a
   `DepreciationNew` workbook or if any block is not in that workbook's list.
   Only rows with a block are written; the rest are reported as skipped.
6. **Import in Winman.** Open the copy in Excel, run the unhide macro, then
   import in Winman and check the clause-18 schedule shows the rows.

## Rules the operator should know

- **Additions** are one row per purchase-class voucher, dated at the **first**
  purchase date; later capitalised costs (registration, insurance, number fee,
  accessories) fold into that row and keep the first date — they get full-rate
  treatment even when paid in the second half-year. Two purchases in one ledger
  give two rows (a review advisory states the count and dates).
- **Additional Depreciation** is always `N/A`. **Date put to use** equals the
  purchase date.
- **Deletions are the actual consideration received**, never the book value or
  the profit/loss on sale. The amount is the money/party debit minus GST, or
  the value moved out of the disposal ledger. A cash part of an addition over
  ₹10,000 is excluded from the amount and flagged.
- **HALFADD** and **DEPN** are `No` on every deletion row (they matter only for
  an asset bought and sold in the same year).
- The **Adjustments** column is left blank.