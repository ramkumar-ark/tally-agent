# Tally Agent

AI agent that uses any MCP server to interact with Tally Prime.

Used by an accountant to finalize company accounts.

## Core requirements

- MCP tool use for reading and writing accounting entries (vouchers, ledgers, masters).
- Guardrails on every write: validation, confirmation policy, dry-run/preview, audit log.
- Sensitive-data redaction: no raw accounting PII goes to the LLM as-is.
  Use masked / dummy / representative names for ledgers, parties, GSTIN, PAN,
  addresses, phone/email, bank details, and narration free text.
- Deterministic de-masking only at the MCP call boundary, never inside prompts.
- Excel read/write for imports, reconciliations and review sheets.
- Artifact/report generation from analysis (trial balance checks, GST summaries,
  mismatch reports, finalization checklist), exported as Excel/CSV/Markdown.

## Status

Milestone 1 — read-only trial balance review — is implemented. See
[`docs/design/2026-09-07-trial-balance-review-design.md`](docs/design/2026-09-07-trial-balance-review-design.md)
for the design and [`harness/`](harness/) for setup.

The gateway masks party, bank, capital and loan ledger identities, runs eight
trial balance checks in code, and writes de-masked reports to a directory outside
the harness's reach.

Milestone 2 (GST summary and mismatch), Milestone 3 (single-ledger scrutiny)
and the TDS compliance review (FY 2025-26) are implemented as well; the TDS
design of record is
[`docs/design/2026-09-14-tds-compliance-review-design.md`](docs/design/2026-09-14-tds-compliance-review-design.md).
The Income Tax Act depreciation review and the fixed asset purchase & sale
register (audit artifact with vehicle incidental-cost, vendor-settlement and
disposal checks) are implemented too.

So is the whole of the Winman Form 3CD return: Form 26AS reconciliation against
the books, the PF/ESI clause 20(b) review, the no-TDS-disallowance clause 21(b)
review, the clause 31 (l.269SS/l.269T) and l.269ST loans review, the clause 44
GST expenditure break-up and its nature-wise working sheet, the clause 18
additions/deletions depreciation review, and the TDS/TCS clause 34 summary. Each
lane reads its operator facts by file path only (a generated Excel template, a
day-book export, a TRACES or Winman export), and each has a `tb_write_3cd_*`
tool that fills a **copy** of the operator's Winman workbook — the source
workbook is never modified. The design of record for each lane is the
corresponding document in [`docs/design/`](docs/design/).

## Tool registry (40 read-only tools)

Every tool below is registered in [`src/index.ts`](src/index.ts); the
one-line summaries are condensed from each tool's own registered description.
**Read-only**: none of them write to Tally. The `tb_write_*` tools write
artifacts to the report directory on the operator's own disk, and `tb_write_3cd_*`
writes a copy of a Winman workbook.

### Basics — trial balance and single-ledger scrutiny

| Tool | What it does |
|---|---|
| `tb_list_companies` | List the companies open in Tally. |
| `tb_review` | Run the eight trial balance sanity checks as of a date and return masked findings; party ledgers appear as pseudonyms such as `Creditor 3`, nominal accounts by name. |
| `tb_ledger_activity` | Voucher-level context for one finding, by finding id. Returns masked rows. |
| `tb_ledger_scrutiny` | Scrutinise one ledger over a period, by finding id — never by ledger name: reconciles opening to closing, flags duplicate entries and bill references, large entries, round-sum journals, monthly spikes and gaps, join gaps and GST rate anomalies. |
| `tb_write_report` | Write the review report and findings sheet to disk; real names are restored on write. |
| `tb_write_ledger_report` | Write the ledger scrutiny report and findings sheet for one `scrutinyId`; real names and tax IDs are restored on write. |

### GST — period summary, returns mismatch, clause 44

| Tool | What it does |
|---|---|
| `tb_gst_summary` | Period GST liability per tax head (CGST, SGST/UTGST, IGST, CESS, GST-other): output tax, input tax credit, net. Aggregate only — no party data. |
| `tb_gst_mismatch` | Compare filed GST returns against the books, matched by tax identity in code; pass the page path of an operator-prepared JSON returns file, never pasted rows. |
| `tb_write_gst_report` | Write the GST review report and findings sheet to disk; real names and tax IDs are restored on write. |
| `tb_gst44_review` | Winman Form 3CD clause 44 review — break-up of total expenditure into GST categories, capital/revenue rows split by supplier GST status (registered exempt / composition / others / unregistered), computed from the books. |
| `tb_write_gst44_template` | Generate the fillable clause-44 operator template (GST Status sheet) into the report directory and return its path. |
| `tb_write_gst44_report` | Write the clause 44 review workbook: a Findings sheet, the break-up matrix (what Winman will import) and the per-party long format. |
| `tb_write_3cd_gst44` | Write the clause 44 rows into the Break-up of GST expenditure sheet of a **copy** of the operator's Winman 3CD workbook; `worksheetPath` takes the rows from the operator's approved nature-wise working sheet instead. |
| `tb_write_gst_working_sheet` | Generate the GST nature-wise break-up **working sheet** for the year (REVENUE and CAPITAL sheets in the prior-year hand-prepared layout), seeded per ledger from a treatment vocabulary, the prior-year sheet and the books' GSTIN evidence. |

### TDS, TCS and Form 26AS

| Tool | What it does |
|---|---|
| `tb_write_tds_template` | Generate the fillable Excel TDS operator template (Sections, Parties, Certificates, Challans, Statements) into the report directory and return its path. |
| `tb_tds_review` | TDS compliance review for FY 2025-26: not deducted, short deducted or deducted late; deposits missing or late; statements late or missing; s.201(1A) interest, s.234E fee and the s.40(a)(ia)/s.271C exposures. `dayBookPath` reads the books from an operator export instead of ~640 per-ledger reports. |
| `tb_write_tds_report` | Write the TDS review report, findings sheet and interest schedule to disk; real names are restored on write. |
| `tb_write_26as_template` | Generate the fillable 26AS party-mapping template (pre-filled with the mapping already in effect, plus a blank Bank Interest sheet that marks the 26AS banks and their interest/FD ledgers). |
| `tb_26as_review` | Tally-books vs TRACES Form 26AS reconciliation: TDS/TCS tax booked but absent from 26AS, 26AS tax the books never booked, gross-vs-taxable valuation mismatch, mapping gaps, late booking, export self-consistency, totals-only 194R/bank-194A and 20%-taxed FD interest. |
| `tb_write_26as_report` | Write the 26AS reconciliation report (markdown plus a workbook of findings, deductor reconciliation, books evidence and the mapping aid) to disk. |

### Depreciation and fixed assets

| Tool | What it does |
|---|---|
| `tb_depreciation_review` | Income Tax Act depreciation per block of assets for a year, against what the books charged, block-wise and asset-wise (WDV, additional depreciation, s.50); an operator depreciation file may seed verified opening WDV. |
| `tb_write_depreciation_report` | Write the depreciation review trio (markdown, findings CSV, workbook); real names are restored on write. |
| `tb_fixed_asset_register` | Fixed asset purchase & sale register for audit: one row per acquisition debit with date, asset, block, counterparty, vendor, amount and voucher identification; disposals, vehicle incidental-cost checks (s.43(1)) and vehicle-vendor settlement. |
| `tb_write_fixed_asset_report` | Write the register trio (markdown, findings CSV, six-sheet workbook); real names and voucher numbers are restored on write. |

### Other Winman Form 3CD clauses

| Tool | What it does |
|---|---|
| `tb_write_3cd_tds_tcs` | Write the clause 34 TDS/TCS rows of the last `tb_tds_review` into the TDS, TCS, Return details and Interest sheets of a copy of the operator's Winman 3CD workbook. |
| `tb_write_pf_esi_template` | Generate the fillable Excel PF/ESI operator template (Challans sheet — one row per challan or ECR payment) into the report directory. |
| `tb_pf_esi_review` | Winman Form 3CD clause 20(b) review — PF/ESI employees' contributions: extraction from the books, the strict 15th due date, s.36(1)(va) disallowance for late deposits, missing or amount-mismatched challans. |
| `tb_write_pf_esi_report` | Write the PF/ESI clause 20(b) review workbook: a Findings sheet and the clause 20(b) working paper (fund, wage month, collected, due, paid, delay, disallowed). |
| `tb_write_3cd_pf_esi` | Write the clause 20(b) rows into the P.F. and E.S.I. sheets of a copy of the operator's Winman 3CD workbook. |
| `tb_write_notds_template` | Generate the fillable No-TDS operator template out of a cached `tb_tds_review`'s clause 21(b) candidate rows (Include / Residency / NR Section / Nature / PAN, plus manual rows). |
| `tb_notds_review` | Clause 21(b) (No TDS Disallowance) review: merge the last `tb_tds_review`'s clause 21(b) candidates with the operator's decisions workbook; `Include=N` rows vanish with their cure reason restated, an NR mark routes a row to the non-resident sheet. |
| `tb_write_3cd_notds` | Write the clause 21(b) rows into the four No-TDS sheets of a copy of the operator's `No TDS Disallowance.xlsm`. |
| `tb_write_loans_template` | Generate the fillable loans operator template for Form 3CD clause 31 (l.269SS/l.269T) and l.269ST, pre-filled with the ledger list and with the ledger dropdowns backed from its hidden Ledgers sheet. |
| `tb_loans_review` | Clause 31 (l.269SS/l.269T) and l.269ST loans review: cash acceptances and repayments breaching the Rs 20,000 mode limits (s.271D/271E exposures), movements whose mode cannot be read, same-day splitting, the Rs 2,00,000-or-more cash register (s.271DA) and estimate honesty flags. |
| `tb_write_loans_report` | Write the clause 31 / 269ST loans review report workbook from the last `tb_loans_review`. |
| `tb_write_3cd_loans` | Write the clause 31 and 269ST rows into the Sec.269SS/269T/269ST sheets of a copy of the operator's Winman 3CD loans workbook. |
| `tb_write_dep3cd_template` | Generate the fillable Excel clause-18 depreciation operator template, pre-filled with the fixed-asset groups and asset ledgers from the day-book masters and with the Winman-block dropdowns backed from its hidden Blocks sheet. |
| `tb_dep3cd_review` | Winman Form 3CD clause 18 depreciation as per the Income-tax Act: the additions and deletions sheets, one row per asset acquisition or sale; deletions are recorded at the **actual consideration** received, never book value or the profit/loss on sale. |
| `tb_write_dep3cd_report` | Write the clause 18 depreciation review workbook: Additions, Parts, Deletions and Findings sheets. |
| `tb_write_3cd_depreciation` | Write the clause 18 additions and deletions into a copy of the operator's Winman depreciation workbook. |

Findings live in their own ordinal spaces (`TB-`, `GST-`, `LS-`, `TDS-`,
`NOTDS-`, `DEP-`, `FA-`, `D3CD-`, `AS26-`); the tables are `CHECK_ORDINAL`,
`GST_CHECK_ORDINAL`, `LEDGER_CHECK_ORDINAL`, `TDS_CHECK_ORDINAL`,
`NOTDS_CHECK_ORDINAL`, `DEP_CHECK_ORDINAL`, `FA_CHECK_ORDINAL`,
`D3CD_CHECK_ORDINAL` and `AS26_CHECK_ORDINAL` in
[`src/types.ts`](src/types.ts) — never renumber one to make room for another. The
TDS law table with its C1–C8 confirm markers lives in
[`src/tds-law.ts`](src/tds-law.ts) and its
interest money figures come out only through the report writer.

Excel read/write has since shipped as well: the operator templates, the review
workbooks and the Winman workbook fillers all read and write `.xlsx`/`.xlsm`
through the project's own zero-dependency zip+XML stacks (`src/xlsx.ts`,
`src/xlsx-read.ts`, `src/xlsm.ts`).

Later milestones, in order: the finalization checklist; and only then the
guarded write path.
