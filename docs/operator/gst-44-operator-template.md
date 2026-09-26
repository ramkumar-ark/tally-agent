# Supplying supplier GST status for clause 44 (Excel template)

Form 3CD clause 44 breaks total expenditure into four GST categories
registered-exempt / composition supplier / registered-others / unregistered.
The review derives most of that from the books (ledger GSTINs from Tally plus
the GST actually charged on each voucher), but composition dealers are
unknowable from the books: a composition supplier is registered (a GSTIN is in
the master) but never charges tax — indistinguishable from a regular supplier
making exempt supplies. An operator fact is the only source. You supply it as a
filled Excel template, the same way the TDS review takes a filled TDS template.

## When to fill a row

Leave the template blank and the review derives every status itself:

- GSTIN in the master and the voucher charges GST (including reverse charge) →
  **Others (registered)**.
- GSTIN in the master and no GST charged → **Exempt (registered)**, with a
  review finding flagging registered-vs-composition ambiguity.
- No GSTIN in the master → **Unregistered**.

Fill a row **only** when you know better than the books:

1. **A composition dealer** — pick `Composition supplier`. This is the only way
   the Winman sheet's Composition column is ever filled.
2. **A status correction** — the books' derivation is wrong for that supplier
   (e.g. a regular supplier making pure exempt supplies whom you want in the
   exempt column *without* the ambiguity finding, or a supplier whose master
   GSTIN belongs to another entity).
3. **Tally is unreachable** — with no GSTIN evidence at all the review refuses
   to guess: parties not covered by a template row stop it with an error. Name
   every expenditure party in the template in that case.

## The workflow

1. **Generate the template.** `tb_write_gst44_template` writes
   `gst-44-operator-template-<company>-<date>.xlsx` into the report directory
   and returns its path. Optionally pass `dayBookPath` (a day-book JSON export)
   so the Ledger column's dropdown comes from the export's ledger names instead
   of live Tally.
2. **Fill it in Excel.** The **GST Status** sheet has one row per ledger:
   **Ledger** and **GST Status**. One row per ledger; entering the same ledger
   twice (even with different spelling or casing) is rejected.
   - **GST Status** is a dropdown with exactly four values, each overriding the
     books' derivation for that ledger:
     | Value | Goes to Winman column |
     |---|---|
     | `Exempt supplies` | Exempt (registered) |
     | `Composition supplier` | Composition Supplier |
     | `Registered - others` | Others (registered) |
     | `Unregistered` | Not registered under GST |
   - The **Ledger** column has a dropdown of the company's ledger names, backed
     by the **Ledgers** sheet (which lists them all, for reference). If no
     ledger masters are available the Ledgers sheet is empty; type the name
     exactly as it appears in Tally.
   - Leave a row out entirely to let the books decide for that ledger. A typed
     status always wins over the books.
3. **Pass the filled file back.** Give its path to `tb_gst44_review` as
   `templatePath` and re-run.
4. **Write the sheet.** `tb_write_3cd_gst44` copies the operator's Winman
   `Break-up of GST expenditure.xlsm` into the report directory as
   `<source stem> - filled - <date>.xlsm` and fills both Capital and Revenue
   rows. `tb_write_gst44_report` writes the human-readable review workbook.
   The Winman source file is never modified.

## Notes

- The file carries ledger/supplier names. **Never paste its rows into chat.**
  Pass its path; the gateway reads the file itself and only the path is audited.
- Do not rename the sheets or the header columns; the parser binds columns by
  header text.
- If the review refuses the file, the error cites the sheet, the Excel row
  number and the column — never a name from your file.
- A template status naming a ledger that is not in the masters produces a
  `gst44_status_override_unknown_ledger` warning (as "Ledger N") and that row
  is ignored — usually a typo; correct it and re-run.

## The nature-wise working sheet (`tb_write_gst_working_sheet`)

A separate, earlier step: the working sheet proposes, the operator confirms,
and only then does the approved flow above write any Winman workbook.

1. **Generate it.** Give the tool the day-book JSON export's path (and the
   prior-year break-up workbook's path, when you have one). It writes a new
   dated `.xlsx` next to the day book with four sheets: REVENUE, CAPITAL,
   Instructions, Vocabulary.
   - Column B is each ledger's FY debit total; the engine pre-fills columns
     D/E/H/J per ledger from a keyword vocabulary (see the sheet's
     **Vocabulary** tab), the prior-year sheet and the party-GSTIN evidence,
     with column K showing what was seeded and why.
   - UNCLASSIFIED rows are left blank on purpose — fill D/E/F/H/J for them
     yourself. The Difference row must read zero when you are done.
2. **Review and edit in Excel.** Change any seeded cell that is wrong; the
   file is yours. Nothing here has been written to any Winman workbook.
3. **Approval is a captain decision.** The engine writes nothing into the
   Winman clause-44 workbook until the working-sheet totals are plainly
   approved and the write step is invoked separately.
