# Filling the No-TDS disallowance operator template (clause 21(b))

The no-TDS review (`tb_notds_review`) decides which payments reach
clause 21(b) of Form 3CD — s.40(a)(i)/(ia)/(ib)/(iii) disallowance. The books
side is already automated; the operator file supplies the decisions the books
cannot make: whether a candidate really belongs in this year's disallowance,
cure reasons, non-resident facts, and payments the books cannot see at all.

## The workflow

1. **Run the TDS review first.** `tb_notds_review` reads the candidate list
   from the TDS review (`tb_tds_review`) — run that first or the review
   refuses with an error naming it.
2. **Generate the template.** `tb_write_notds_template` writes
   `notds-operator-template-<company>-<date>.xlsx` into the report
   directory and returns its path. The Candidates sheet arrives pre-filled
   with the books facts (Key, Party, Date, Voucher, Section in the Winman
   spelling, Gross, TDS Done/Deposited, Deposit Date, Liability, PAN); you
   fill only the columns after PAN.
3. **Fill it in Excel.** Four sheets:
   - **Instructions** — the columns and the law behind each cure token; no
     data.
   - **Candidates** — one row per books candidate. Columns after PAN:
     - `Include` — **blank = Y**. Put `N` only when the row does not belong
       in this year's disallowance; then `Cure Reason` is required (Include=N
       with a blank Cure Reason does not parse). Cure tokens: `threshold`,
       `transporter-declaration`, `payee-filed-return`,
       `deposited-by-return-date`, `other` (with a note). An N row is
       excluded from the Winman sheets and reported as `notds_cure_excluded`.
     - `Residency` — **blank = resident (the default)**. Pick `NR` only for a
       genuine non-resident, and fill `NR Section` with the TDS section in
       the Winman spelling (`195`, `196A`, `194E`, …) — a marked NR row
       without one does not parse.
     - `Nature of Payment`, `Address`, `City`, `State`, `PIN`, `Country` —
       free text (State has the dropdown). They ride into the Winman sheet
       when filled.
     - `Amount Override` — blank for almost every row. Enter an amount only
       when the books gross itself is wrong; the override, not the gross,
       then carries to Winman and the review reports `notds_amount_override`.
     - `Notes` — anything the auditor should see.
   - **Manual Rows** — for what the books cannot see: 40(a)(i) non-resident,
     40(a)(ib) equalisation levy, 40(a)(iii) salary, or a 40(a)(ia) payment
     outside the books. One row per payment: target `Sheet` (dropdown),
     `Party`, `Date`, `Amount`, tax/levy `Deducted`/`Deposited` (one or
     both), `Section` where the target sheet takes one (free text — the
     review re-validates it against that sheet's law list), plus the same
     identity columns. Each manual row is restated in the review as
     `notds_manual_row` and lands on its sheet for the fill.
   - **Lists** (hidden) — dropdown sources; leave alone.
4. **Pass the filled file back.** Give its path to `tb_notds_review` as
   `templatePath`. The masked review returns the candidate count, per-sheet
   row counts, cure exclusions and the findings; `notdsRows()` then supplies
   `tb_write_3cd_notds`.
5. **Fill the Winman workbook.** `tb_write_3cd_notds` takes the Winman
   `No TDS Disallowance.xlsm` as `sourcePath` and writes a **filled copy**
   (`<stem> - filled - <date>.xlsm`) into the report directory — the source
   workbook is never written to. Copy each sheet's rows into Winman clause
   21(b) yourself (that paste is the one manual step this tool chain does
   not perform for you).

## What the machine never does

- **It computes no disallowance percentages.** The sheets carry payment
  facts only — Winman applies the 30%/100% s.40 provisos itself.
- The review aggregates rows into sheets by their section; a resident row
  whose section is a non-resident spelling (or an NR row with no valid NR
  section) is dropped and reported as `notds_nr_missing_section`, never
  guess-routed.

## Notes

- The file carries party names, PANs and payment figures. **Never paste its
  rows into chat.** Pass its path; the gateway reads the file itself and
  only the path is audited.
- Do not rename the sheets or header columns — the parser binds by header
  text, never by position. The Key column is the join between the template
  and the review; leave it untouched.
- If the review refuses the file, the error cites the sheet, the Excel row
  number and the column — never a value from your file.
- Dates typed as `2026-01-15` or picked from the calendar picker.
