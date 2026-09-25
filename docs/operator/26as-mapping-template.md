# Correcting the 26AS party mapping (Excel template)

The Tally-vs-Form-26AS reconciliation joins each 26AS deductor/collector to a
Tally ledger through an operator-supplied mapping. You supply it as a filled
Excel template, the same way the TDS review takes a filled TDS template.

## The workflow

1. **Run the review once.** `tb_26as_review` reports `mapping_gap` findings for
   every 26AS name and every books ledger that stays unjoined. Nothing is
   auto-matched: an unmapped party simply has no money checks computed for it.
2. **Generate the template.** `tb_write_26as_template` writes
   `as26-map-template-<company>-<date>.xlsx` into the report directory and
   returns its path. Pass it the 26AS export (`as26Path`); pass `as26MapPath`
   too if a mapping is already partly in effect, and `dayBookPath` if you want
   the ledger list taken from a day-book export rather than live Tally.
3. **Fill it in Excel.** The **Mapping** sheet has one row per 26AS name with
   its `kind` and `26AS tax`, and a **Tally ledger** column to fill. Rows
   already mapped come pre-filled, so you can re-fill and re-run iteratively.
   Leave a row's Tally ledger blank to leave that party unmapped.
   - **One 26AS name may need several rows.** If a deductor/collector is
     represented by more than one Tally ledger — a customer split across a site
     ledger and a head-office ledger, say — add another row with the **same
     26AS name** and pick the next ledger. One ledger per row. The review sums
     every ledger mapped to that name (tax, credits, sales, dates) and compares
     the total against 26AS once, as a single party, so a split customer no
     longer shows a false shortfall. The **reverse is refused**: a Tally ledger
     may map to only one 26AS name.
   - The **Tally ledger** column has a dropdown of the company's ledger names,
     backed by the **Ledgers** sheet (which lists them all, for reference). The
     dropdown works for any company size — it is bound to the Ledgers range,
     not to an inline list. If the company has no ledger masters available the
     Ledgers sheet is empty and the dropdown has nothing to offer; fill the
     column by typing the name.
4. **Pass the filled file back.** Give its path to `tb_26as_review` as
   `as26MapPath` and re-run. Repeat until the gaps close.

## Bank interest (s.194A) and fixed deposits

Some banks/deductors report interest in many small amounts that can never be
matched bill by bill. The template's **Bank Interest** sheet is the input for
them:

- One row per ledger. Write the bank's name **exactly as it appears in 26AS**
  in "26AS name (bank)", and its **Interest income ledger** and/or **FD
  ledger** in the next columns. Repeat the bank's name on extra rows for
  further ledgers; leave a column blank when that side does not apply.
- **Presence on this sheet is the bank mark.** A 26AS name listed here
  reconciles its 194A entries on **totals** (interest vs 26AS amount, TDS vs
  26AS tax) — never bill by bill, and its entries stay off the "Books not in
  26AS" / "26AS unmatched" sheets.
- Non-bank 194A deductors keep the ordinary bill-level reconciliation; nothing
  on this sheet affects them.
- Interest entries where the books show TDS of **about 20%** of the interest
  (the bank deducted the higher rate, often for a missing PAN) are **left out
  of the totals comparison** because they will not reflect in 26AS. They are
  listed separately on the report's **"FD interest 20% TDS"** sheet, with a
  count, interest and TDS totals, and a finding noting they are not expected
  in 26AS.
- If you name a bank but fill no ledgers, the review says so (and does not
  pretend a zero-books comparison is valid): fill the ledger names and re-run.
- A bank not on this sheet at all does not change anything: leave the sheet
  empty when no bank interest is involved, and older filled templates remain
  valid.

## Notes

- The file carries company and party names. **Never paste its rows into chat.**
  Pass its path; the gateway reads the file itself and only the path is audited.
- Do not rename the sheets or header columns — the parser binds columns by
  header text, so an inserted helper column is fine, but the headers must stay.
- Leave a cell blank to mean "not yet mapped". Pre-filled rows whose Tally
  ledger is still empty are skipped.
- If the review refuses the file, the error cites the sheet, the Excel row
  number and the column — never a name from your file.

The JSON map (`config/as26-map.json`, format
`{ "mappings": [{ "ledger": "...", "as26Name": "..." }] }`) still works and is
the default when no `as26MapPath` is given. `tb_26as_review` chooses the
template parser or the JSON parser by the file's extension.
