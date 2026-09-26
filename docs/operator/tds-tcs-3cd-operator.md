# Filling the Winman 3CD TDS/TCS template

The Winman Form 3CD TDS/TCS summary (`tb_write_3cd_tds_tcs`), design of record
`docs/design/2026-09-24-tds-tcs-3cd-design.md`, fills the five clause-34
sheets of the Winman workbook — `TDS`, `TCS`, `Return details`,
`Interest on TDS`, `Interest on TCS` — from the TDS review engine plus the
books. Most cells come from Tally; four facts only you can supply, and you
give them through the same operator template the TDS review already reads
(walkthrough: `docs/operator/tds-operator-template.md`):

- the **Settings: TAN** row,
- the **TCS Sections** sheet,
- the **Interest Paid** sheet,
- the Statements sheet's **Return Accurate?** column.

The TAN also travels as a JSON key (`tan`) on the JSON operator file.

## Settings: the TAN row

One extra row on the existing **Settings** sheet:

| Setting | Value |
|---|---|
| TAN | `AAAA12345T`-shaped text |

Type it as text (Excel may mangle a long numeric-looking string otherwise).
The value must match the statutory TAN shape — four letters, five digits, one
letter. A malformed TAN is refused with an error that cites the Settings row;
the error never quotes the value.

The TAN is used to stamp column B of the `TDS`, `TCS`, `Return details` and
both `Interest` sheets, alongside the company name in column A. It lives in
the filled workbook on disk — nowhere else: it is never echoed in the review
result, the preview, or any error message.

## The TCS Sections sheet (new)

One row per ledger that participates in a TCS nature, both sides of it:

- `Tally Ledger Name` — the receipt ledger (e.g. the scrap-sales ledger) and
  the TCS duty ledger (the receivable the collections ride).
- `Nature of receipt (exact Winman text)` — one of the 13 Winman dropdown
  strings, copied exactly: a stray space breaks the dropdown on import. The
  write-time validation is exact-match, no trim.

Leave the sheet blank over a TDS-only year; the whole `TCS` sheet then stays
empty — a correct zero, not a failure.

## The Interest Paid sheet (new)

One row per quarter you actually paid interest on:

- `Form` — one of the six accepted statement forms (the union of the two
  interest sheets' dropdowns: `24Q`, `26A`, `26Q`, `26QB`, `27Q`, `27EQ`).
- `Quarter (Q1-Q4)`.
- `Amount` — the interest paid.
- `Paid on` — the payment date.

The engine matches these to the computed interest rows on
`Interest on TDS` (form + quarter) and `Interest on TCS` (form `27EQ`).

## The Statements sheet: Return Accurate column

One extra column on the existing **Statements** sheet:
`Return Accurate? (Yes/No)`, one value per quarterly statement. Leave blank
and the workbook is stamped `Yes` — the common case, "the return as filed was
accurate". Enter `No` only when a revised statement is still to be filed: the
value lands in the Winman sheet's `Return Accurate` column for you to narrate
over in Excel.

The Statements sheet's other columns are unchanged: `Form`, `Quarter`,
`Filed Date`, `TDS Amount`.

## Getting the filled workbook — and where it lands

After `tb_tds_review` runs, call `tb_write_3cd_tds_tcs` with the workbook
path. It reads your Winman source workbook, fills the five sheets and writes
the filled copy **next to where you point it — never into the Winman folder
itself**. The source workbook is only ever read; the tool refuses a path that
resolves onto its own source.

To re-import: open Winman on your machine, and click its import (the V4 step)
against the filled copy. That step is operated by the captain, not this tool.

Before handing the workbook over, you can re-run the verification script
(`scripts/verify-3cd-tdstcs-roundtrip.mjs`): it re-reads every written cell,
asserts each dropdown cell against the exact dropdown list, and opens the
copy in Excel to run Winman's own `ValidateMandatoryFields`.
