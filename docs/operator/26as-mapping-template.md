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
   - The **Tally ledger** column has a dropdown of the company's ledger names,
     backed by the **Ledgers** sheet (which lists them all, for reference). The
     dropdown works for any company size — it is bound to the Ledgers range,
     not to an inline list. If the company has no ledger masters available the
     Ledgers sheet is empty and the dropdown has nothing to offer; fill the
     column by typing the name.
4. **Pass the filled file back.** Give its path to `tb_26as_review` as
   `as26MapPath` and re-run. Repeat until the gaps close.

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
