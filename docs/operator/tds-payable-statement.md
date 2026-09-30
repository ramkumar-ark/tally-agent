# The TDS payable statement (decisions workbook → challan statement)

The TDS review (`tb_tds_review`) tells you what the books did not deduct or
deposit. Paying it on a challan is an **operator decision**: which critical
findings you accept as your liability and which you reject. This is the
two-step channel for that — a decisions workbook you fill in Excel, then a
statement workbook priced to the payment date.

## The workflow

1. **Run the TDS review.** `tb_tds_review` caches the critical findings and
   the private books facts the payable projection needs. Both tools below
   read that one cached run; a fresh review between them invalidates the
   workbook (see *Binding*). **Re-run the review with exactly the inputs your
   finalised review used** — the same day book, the same operator template, the
   same Winman export, and the same ledger-masters channel. The statement's
   critical set and every PAN in it come from that run, so a review taken with
   a different evidence channel states a different liability: running the
   review against live masters when your finalised run degraded to the day
   book's own masters raises the 206AA no-PAN rows and the set with them. The
   run records which channel it used (`books.mastersSource`, and the review's
   own `winman` block), so compare those before you price anything.
2. **Generate the decisions workbook.** `tb_write_tds_payable_decisions`
   writes `tds-payable-decisions-<company>-<date>.xlsx` into the report
   directory and returns its **path**. One row per critical finding, in the
   review's own wording. It carries **no PAN** — PANs appear only on the
   statement, which is the sheet that leaves your office.
3. **Fill it in Excel.** Three visible sheets:
   - **Instructions** — what `Accept`/`Reject` mean and what the statement
     will do; no data.
   - **Findings** — one row per critical finding:
     - `Decision` — `Accept`, `Reject`, or **blank** (the dropdown allows
       only those two words; anything else is refused). Blank is not a
       decision: the statement refuses while any critical row is undecided
       (a deleted row counts as undecided too), naming the open findings.
     - `Remarks` — free text, optional. The statement quotes no remark, so
       this is your own working note and the answer to "why is this not in
       the challan" for the correction letter to the department.
     - The preceding columns (finding id, check, party pseudonym, section,
       date, amount, shortfall) are the review's facts — read-only in
       practice; a changed number there is not used.
   - **Run** (hidden) — company, period, as-on date, critical count and the
     run digest. Do not touch it.
   - **Lists** (hidden) — the dropdown source; leave alone.
4. **Price the statement.** `tb_tds_payable_statement` takes the filled
   workbook's **path** as `decisionsPath` and the challan payment date as
   `paymentDate` (YYYYMMDD). It prices the Accepted findings and writes
   `tds-payable-statement-<company>-payment<YYYYMMDD>.xlsx`. The tool
   returns a masked summary — counts, totals and party pseudonyms, never a
   real name or PAN — and the workbook on disk carries the real names, the
   PANs and the company/non-company split.

## What the statement prices

The **shortfall** on each Accepted row is the tax still to be paid: the full
tax on a not-deposited finding, the un-deducted portion on a not-deducted
one, and the under-deducted amount on a short-deducted one. On top of it,
s.201(1A) interest — the review's own schedule, never a second formula:

| Leg | Rate | Runs from → to |
|---|---|---|
| (i) late deduction | 1% per month or part of a month | the booking date → the payment date (a shortfall that was never deducted is deemed deducted on the payment date) |
| (ii) late deposit | 1.5% per month or part of a month | the deduction date → the payment date, and only where the payment is after the Rule 30 due date shown in the last column |

The last column is the **Rule 30 due date of the original deduction or booking** —
the 7th of the following month, and 30 April for a March deduction. It is not
the date after the payment: that says when you are paying, not when the
liability fell due.

The **rate of deduction** is the **statutory rate for that deductee and
section** — the same rate the review charged, never a ratio of the row's
figures. It is read from the deductee's PAN: `C` in its 4th character is a
Company, anything else a non-company, so 194C prices at 2% for one and 1% for
the other, and a s.197 certificate rate is honoured where the books carry
one. A row whose rate cannot be resolved prints it blank. When no PAN can be found (no master PAN and no
GSTIN to derive one from) the s.206AA floor of 20% applies and the row reads
**Not determinable (no PAN)**; the rate itself is the floor, and the Summary
sheet breaks the totals out by that classification so a 20% block is visible
as one block.

## Reading the two workbooks

- **Findings** is your working paper: one row per critical finding, with
  what you decided and why.
- **Statement** is the challan working paper: one row per Accepted finding,
  in the captain's column order — date of booking, party, PAN, company /
  non-company, amount paid, TDS that should have been deducted, TDS actually
  deducted, date of deduction, rate, shortfall to pay, interest (i),
  interest (ii), interest due to the payment date, due date of deposit — and
  a totals row. The **Summary** sheet carries the three headline totals, the
  same split by section and by company class, the accepted/rejected counts,
  and a note on what the expense base means for each finding kind (the
  undeducted portion for a shortfall, the whole booking for a
  not-deposited one).

## Binding, and what is refused

The workbook is bound to the run that produced it by the hidden `Run` sheet's
digest of the critical findings. So:

- a workbook from **another review** is refused, even for the same company —
  re-run `tb_tds_review`, then regenerate;
- an **unknown or duplicate finding id**, an invalid `Accept`/`Reject` value,
  a missing or renamed column or sheet, or a deleted row is refused, citing
  the sheet, row, column letter and header — never a cell value, so a PAN
  typed into the wrong cell cannot leak through the error;
- a workbook with no `Findings` sheet is refused outright (unless the review
  raised no critical finding at all, in which case there is nothing to
  decide and an empty decision set is accepted).

## In the audit workflow

The same pair is the workflow's `payable` step: it generates the decisions
workbook, and the next run takes your filled copy back and writes the
statement. Its folder is under the workflow's report directory, like every
other step.
