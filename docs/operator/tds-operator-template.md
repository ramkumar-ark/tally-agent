# Filling the TDS operator template

The TDS compliance review (`tb_tds_review`) reads facts the books cannot
supply — ledger→section mappings, s.197 certificates, 194C(6) declarations,
challan dates, statement filing dates, the s.201(1) proviso, and the s.194Q
opt-out — from an operator file. You supply it as a filled Excel template,
the same way the Form-26AS reconciliation takes a filled mapping template.

## The workflow

1. **Generate the template.** `tb_write_tds_template` writes
   `tds-operator-template-<company>-<date>.xlsx` into the report directory
   and returns its path. The workbook is a blank skeleton: header rows only.
2. **Fill it in Excel.** Seven sheets:
   - **Instructions** — a short reminder of the columns; no data.
   - **Sections** — one row per ledger that maps to a section:
     `Tally Ledger Name`, `Section` (194C, 194J, 194-I(a), 194-I(b), 194A,
     194H, 194Q, 194T), and `Ledger Kind` (blank for an expense/purchase
     ledger; `TDS Duty` for the TDS duty ledger, whose rows then never count
     as a booking).
   - **Parties** — one row per deductee party ledger: `Tally Ledger Name`,
     `TDS Applicable` (required, Y or N), `PAN`, `Transporter Declaration
     194C(6)`, `Deductee Filed Return s.201(1)`, and `Winman Deductee Name`
     (only when a Winman export is used, to join its rows to Tally ledgers).
   - **Certificates** — s.197 certificates: ledger, section, `Rate %`, `From
     Date`, `To Date`, `Limit`.
   - **Challans** — one row per deposited challan: section, `For Month`
     (`YYYY-MM`), `Deposit Date`.
   - **Statements** — one row per quarterly statement: `Form` (24Q/26Q/27Q),
     `Quarter` (Q1–Q4), `Filed Date`, `TDS Amount`.
   - **Settings** — whole-review flags; see below.
3. **Pass the filled file back.** Give its path to `tb_tds_review` as
   `templatePath` and run the review.

## The Settings sheet: s.194Q

**s.194Q is checked by default.** The section applies only when the buyer's
turnover exceeded ₹10 crore in the previous year — a fact the books do not
carry. The Settings sheet's single row makes it an operator fact:

| Setting | Value |
|---|---|
| 194Q Applicable | `Y` |

- Leave it `Y` (the template pre-fills this) — or blank — to run the 194Q
  check. Blank means applicable.
- Enter `N` **only when the buyer expressly did not meet the previous-year
  turnover condition.** That takes 194Q out of the whole review: no 194Q
  findings, no 194Q totals, no crossing advisory. It is not a per-party
  exemption.
- The JSON operator file carries the same fact as `section194QApplicable`;
  an absent key means applicable.
- The Settings sheet is optional. A template filled before it existed — or
  one where you simply leave the row out — behaves as applicable.

## Notes

- The file carries company, party and PAN names. **Never paste its rows into
  chat.** Pass its path; the gateway reads the file itself and only the path
  is audited.
- Do not rename the sheets or header columns — the parser binds columns by
  header text, so an inserted helper column is fine, but the headers must
  stay. The Settings sheet is matched by name (`Settings`) and its label cell
  must read exactly `194Q Applicable`.
- If the review refuses the file, the error cites the sheet, the Excel row
  number and the column — never a value from your file.
- Excel may turn a long numeric string into a number. The PAN column must
  stay text; a numeric PAN cell is rejected with a message telling you to
  retype the column as text.
