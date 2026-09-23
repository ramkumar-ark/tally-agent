# Winman Form 3CD round-trip foundation + PF/ESI funds (clause 20(b)) — Design

Status: design of record. Implementation plan is a separate artifact.
Date: 2026-09-23.

This is the design of record for filling the Winman Form 3CD `PF ESI funds.xlsm`
clause 20(b) sheets from Tally books plus an operator challan template, on a
foundation the other four 3CD workbooks reuse unchanged. Sections 2, 3, 4 and 6
below are reproduced verbatim from the implementation plan's report; §10 records
the live validation of the round trip.

---

## 2. The Winman import protocol (established empirically)

This is the shared foundation. Everything here was read out of the actual files; none of it is documented by Winman.

### 2.1 The workbooks are self-describing

Every Winman 3CD sheet carries its own import schema in hidden rows. From `xl/worksheets/sheet1.xml` of the PF ESI workbook:

```
r1 [hidden]: A1='EmployeePFESIfunds' | B1='P.F.' | C1='7' | D1='4.03.50.10.*.00'
r2 [hidden]: A2='DUEDATE' | B2='PAIDON' | C2='AMOUNTPAID' | D2='AMOUNTCOLLECTED'
r4:          A4='Due date' | B4='Paid on' | C4='Amount  paid' | D4='Amount collected'
r5:          A5='P.F.Contributions'
r6 [hidden]: A6[s88]='-' | B6[s88]='-' | C6[s89]='-' | D6[s89]='-' | E6[s90]='-' | F6[s93]='-'
```

- **row 1** — `A1` form id, `B1` sheet key, **`C1` = the first data row**, `D1` = Winman's internal field path.
- **row 2** — the machine column keys. This row, not the human header, is the contract.
- **row `C1`−1** — a hidden all-`'-'` **prototype row** that carries the styles a data row must use.
- Human header rows sit between and differ per sheet (`P.F.` puts headers on r4, `Other Funds` on r5). **Never key off the human headers.**

`C1='7'` and the prototype at r6 hold for all three data sheets. The same shape, with different keys, is in all five workbooks.

The handshake lives on a hidden `INTER` sheet:

```
r1: A1='$WiNsArAlXlImPoRt2$' | B1='9.6.1' | C1='1623' | D1='2026-2027' | E1='F' | G1='1'
```

→ protocol marker, Winman version, build, **AY 2026-2027**, and `G1=1` which switches validation on.

### 2.2 What the VBA proves

`xl/vbaProject.bin` → `Module1` (689 lines, decompressed to scratchpad). Three findings decide the whole design:

**(a) The clipboard carries a path, not data.** Winman opens and parses the `.xlsm` from disk:

```vb
Public Sub CommonCopy(SheetName As String)
    blnValid = ValidateMandatoryFields(Worksheets(SheetName))
    If blnValid = False Then Call ShowValidationMessage: Exit Sub
    If Trim(ThisWorkbook.Path) = "" Then
        MsgBox "Please save the file and then click on 'Copy' button.", ...
    Else
        Call Workbook_BeforeSave_event(False)
        Call CheckAndCopy2Clipboard("±XLPATH±" & ThisWorkbook.Path & "\" & ThisWorkbook.Name & _
             "±XLPATH±" & "±XLSHEET±" & SheetName & "±XLSHEET±")
    End If
End Sub
```

**(b) Excel unconditionally re-saves the file before Winman reads it.** `Workbook_BeforeSave_event(False)` calls `WorkBook_HideSheets`, then `ThisWorkbook.Save`, then `WorkBook_UnhideSheets`.

> **This is the single most important fact in the foundation.** The file Winman parses is always an *Excel-written* file. Our output therefore only has to be good enough for **Excel to open it without a repair prompt** — Excel then rewrites the package canonically (normalising inline strings into `sharedStrings`, recomputing `spans`, etc.) before Winman ever sees it. That collapses a large class of OOXML-pedantry risk.

**(c) `C1` is the first data row, and validation is trivially satisfied for PF/ESI:**

```vb
Public Function ValidateMandatoryFields(xlSH As Worksheet) As Boolean
    If Val(Worksheets("INTER").Cells(1, 7).value) < 1 Then ValidateMandatoryFields = True: Exit Function
    startRow = Val(xlSH.Cells(1, 3).value)                  ' C1 = first data row
    lastRow  = xlSH.UsedRange.row + xlSH.UsedRange.Rows.Count - 1
    lastCol  = xlSH.Cells(2, 1).End(xlToRight).Column       ' a gap in row 2 truncates this
    For col = 1 To lastCol
        If InStr(xlSH.Cells(2, col).value, "+") > 0 Then ... ' "+" marks a mandatory column
    For row = startRow To lastRow
        If Application.WorksheetFunction.CountA(...) = 0 Then GoTo NextRow  ' blank rows skipped
```

No PF/ESI key carries a `+`, so validation passes for any data we write. (Note the `End(xlToRight)` behaviour: on `Other Funds`, `E2` is empty and `F2='NAMEOFFUND'`, so `lastCol` stops at D and the fund-name column is never scanned. Harmless here; relevant if a later sheet has mandatory keys past a gap.)

Also, sheet visibility is driven by `A1`:

```vb
If InStr(1, iSheet.CodeName, "SHDATA", vbTextCompare) = 1 Then
    If Trim(iSheet.Cells(1, 1).value) <> "" Then      ' A1 non-empty == "sheet in use"
        If iSheet.Visible <> xlSheetVisible Then iSheet.Visible = xlSheetVisible
```

So row 1 must survive intact or the sheet stops appearing for the operator.

### 2.3 The cell-encoding contract, proved against Winman's own output

The `Form 26AS` workbook in the same folder is the same Winman wrapper **with real data rows already written by Winman**. Raw XML from `xl/worksheets/sheet1.xml`:

```xml
<!-- prototype row: every cell t="s" -> '-', styles carry quotePrefix="1" -->
<row r="7" spans="1:10" hidden="1"><c r="A7" s="90" t="s"><v>144</v></c><c r="B7" s="91" t="s"><v>144</v></c>...</row>

<!-- a data row Winman wrote: strings via sharedStrings, numbers bare, EMPTY COLUMNS OMITTED (no E8/G8/H8) -->
<row r="8" spans="1:10"><c r="A8" s="77" t="s"><v>145</v></c><c r="B8" s="81" t="s"><v>146</v></c><c r="C8" s="86"><v>36000</v></c><c r="D8" s="86"><v>36000</v></c><c r="F8" s="86"><v>1800000</v></c><c r="I8" s="77" t="s"><v>83</v></c></row>
```

And a **date** cell, from the `Advance tax` sheet of the same workbook:

```xml
<c r="C8" s="109"><v>45938</v></c>   <!-- Excel serial 45938 = 2025-10-08 -->
<c r="C9" s="109"><v>46094</v></c>   <!-- 46094 = 2026-03-13 -->
```

The style relationship is exact and holds four times over in Winman's own output — **the data-row style is the prototype style with `quotePrefix` removed, identical in every other attribute**:

| purpose | prototype xf | data xf | numFmt | formatCode | quotePrefix |
|---|---|---|---|---|---|
| date | `s110` | `s109` | 172 | `dd\-mmm\-yy` | 1 → absent |
| amount | `s92` | `s86` | 1 | builtin | 1 → absent |
| text A | `s90` | `s77` | 49 | builtin (text) | 1 → absent |
| text B | `s91` | `s81` | 49 | builtin (text) | 1 → absent |

**The same twins already exist in the PF ESI workbook**, so no `styles.xml` edit is needed for this feature:

| PF/ESI column | prototype xf | data twin | numFmt | formatCode |
|---|---|---|---|---|
| `A` DUEDATE, `B` PAIDON | `s88` (qp=1) | **`s80`** | 172 | `dd\-mmm\-yy` |
| `C` AMOUNTPAID, `D` AMOUNTCOLLECTED | `s89` (qp=1) | **`s84`** | 3 | `#,##0` |

So the writer rules are:

1. Data rows start at `C1`; write one `<row>` per record.
2. Write only the columns keyed in row 2. Omit the `<c>` entirely for a blank value — Winman does.
3. Numbers: bare `<v>`. Dates: **Excel serial** as a bare `<v>` (days since 1899-12-30 — `serial()` already exists at `src/xlsx.ts:43`). Strings: `t="inlineStr"` (Excel normalises these into `sharedStrings` on its mandatory re-save, so `sharedStrings.xml` never has to be touched). **PF/ESI needs no strings at all** — two dates and two numbers.
4. Style each cell with the prototype's style minus `quotePrefix`.
5. Update `<dimension ref="...">` to the last written row.
6. Leave rows 1, 2, the human headers and the prototype row byte-identical.

### 2.4 Why the existing writer cannot be reused

The package has **119 entries**, including 8 JPEGs stored uncompressed (method 0), `printerSettings*.bin`, 30 `ctrlProps`, 15 `vmlDrawing`s, a 268 KB `xl/vbaProject.bin` and a 14 KB **`xl/vbaProjectSignature.bin`**.

`src/xlsx.ts`'s `zip()` (`src/xlsx.ts:128`) builds entries **from strings only** (`Buffer.from(content, "utf8")`, always deflate) — it cannot carry binary parts, so `buildWorkbook` would destroy the macros, the signature and the images.

→ **A new module doing a surgical rewrite: copy 118 entries' compressed bytes verbatim, re-deflate exactly one worksheet part.** Because `vbaProject.bin` is never touched, `vbaProjectSignature.bin` stays valid.

### 2.5 Round-trip verification method

Excel is installed and **COM automation works from WSL** — verified:

```
$ ls "/mnt/c/Program Files/Microsoft Office/root/Office16/EXCEL.EXE"   # 78,409,024 bytes
$ /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \
    '$x=New-Object -ComObject Excel.Application; $v=$x.Version; $x.Quit(); "EXCEL_COM_OK version=" + $v'
EXCEL_COM_OK version=16.0
```

(`powershell.exe` is not on `PATH` in this WSL distro — the absolute path above is required. WSL interop is registered and enabled.)

The verification chain, in order of cost:

| # | Level | Automatable | What it proves |
|---|---|---|---|
| V1 | **Structural** — re-read our own output, assert every non-target entry is byte-identical (name, method, CRC-32, compressed bytes) to the source; assert rows 1/2/headers/prototype of the target sheet are unchanged | yes (vitest) | we damaged nothing |
| V2 | **Excel opens it clean** — COM `Workbooks.Open`, assert no repair record, assert `Sheets.Count == 18` | yes (script) | the XML is valid enough for the mandatory re-save |
| V3 | **Macro contract** — `Run "WorkBook_UnhideSheets"`, assert `P.F.` is visible; `Run "ValidateMandatoryFields"` on `P.F.`, assert `True` | yes (script) | Winman's own gate passes |
| V4 | **Winman import** — operator clicks Copy on the `P.F.` sheet, pastes into Winman clause 20(b), confirms the rows land | **no — captain-operated** | the whole contract |

V1–V3 belong in the repo. **V4 is the honest manual boundary** and is called out as such, exactly like §18.1 live validation in the depreciation design.

---

## 3. Books analysis — what Tally can and cannot supply for clause 20(b)

Source: an offline day book export (`daybook-export-25-26.json`, 16 MB, 14,359 vouchers, FY 25-26; synthetic names and amounts throughout this section). Full-FY movement of both fund payable ledgers, each voucher classified by its counter-ledgers:

```
Provider PF Payable A/c
  20250401 #21     DR(clear)   -50,400   -> Nova Consultants            [opening liability]
  20250430 #421    CR           33,200   ACCRUE(employer)
  20250430 #422    DR(clear)   -61,200   -> Consulting Charges, Nova Consultants
  20250430 #423    CR           30,400   COLLECT(employee, in salary jv)
  20250531 #860    CR           28,200   COLLECT(employee, in salary jv)
  ...
  20251031 #3481   CR           31,700   ACCRUE(employer)          [<- Nov accrual dated in Oct]
  20251130 #3960   CR           29,200   COLLECT(employee, in salary jv)
  20251130 #3961   DR(clear)   -60,900   -> Consulting Charges, Nova Consultants
  ...
  20260331 #6224   CR           28,300   COLLECT(employee, in salary jv)
  20260331 #6225   CR           30,800   ACCRUE(employer)          [uncleared at year end]

the ESI payable ledger
  20260131 #5006   CR            1,300   COLLECT(employee, in salary jv)
  20260228 #5525   CR            1,300   COLLECT(employee, in salary jv)
  20260331 #6224   CR            1,300   COLLECT(employee, in salary jv)
```

### The employee series is complete and clean

| Fund | Months | Employee contribution (₹) |
|---|---|---|
| P.F. | 12 (Apr-25 → Mar-26) | 30,400 / 28,200 / 30,300 / 30,600 / 31,500 / 31,500 / 29,600 / 29,200 / 27,900 / 29,200 / 28,500 / 28,400 — **total 3,55,300** |
| E.S.I. | 3 (Jan-26 → Mar-26) | 1,300 / 1,300 / 1,300 — **total 3,900** |

ESI starts only in Jan-2026 (mid-year registration). **A fund must not be assumed to run all 12 months.**

### What books cannot supply

The `CLEAR` rows are **month-end journals to `Nova Consultants`, a PF consultant — not to EPFO/ESIC.** They are dated the month end, one month in arrears, and they bundle employee + employer + admin charges into one figure.

> **Therefore the books contain the amount collected but contain neither the actual deposit date nor the employee-share portion of the deposit.** `PAIDON` and `AMOUNTPAID` must come from an operator template backed by the ECR/challan receipts. This is not a limitation of our extraction — the facts are simply not in Tally.

### Column sourcing

| Winman key | Source | Notes |
|---|---|---|
| `AMOUNTCOLLECTED` | **Books** | employee-share credit to the fund payable inside the salary JV |
| `DUEDATE` | **Law table** | 15th of the following month (§4) |
| `PAIDON` | **Operator template** | challan/ECR date; may fall in the next FY (see below) |
| `AMOUNTPAID` | **Operator template** | cross-checked against books as a finding, never overwritten |

### Sharp edges the day book forced

- **Sign.** In the raw day-book export, `AMOUNT` negative = debit (AGENTS.md R-MCP-5); `ledgerVoucherRows`' `sideSign` flips this once at the gateway boundary so that **downstream positive = debit**. An employee contribution is a **credit** to a liability, so in normalised form it is **negative**. This is the exact shape of the TDS booking-side inversion recorded in AGENTS.md — the plan pins it with a test in Task 6.
- **3 vouchers carry `"entries": [""]`** (cancelled vouchers, e.g. `20250531 #413` with `isCancelled:"Yes"`, `partyLedgerName:{}`, `amount:{}` — `{}` is the export's empty-field placeholder). Any entry walk must filter to objects and guard amounts with `typeof === "number"`.
- **`date` and `voucherNumber` arrive as JSON numbers** — coerce with `String(...)` on both sides of any comparison (AGENTS.md).
- **One salary JV can touch several fund ledgers** — `#5006` on `20260131` carries both the EPF and the ESI employee share.
- **The employer series is irregular** (no Nov accrual; two in Oct) while the employee series is not. The feature reads only the employee side, so this irregularity does not affect it — but it is why classification must be per-voucher, not per-month-pattern.
- **A false-positive fund ledger exists**: `Weighing Machine XY-PF` under a depreciation-style group such as `Fixed Assets › Tools`. A name match alone is not safe; the liability-root test excludes it. This is a required test case.
- **March's liability is uncleared at year end** — its payment (due 15-Apr-2026) lands in FY 26-27, so the operator template **must accept a `Paid on` date outside the audited FY**.

### Source choice: day book vs live Tally

**Recommendation: the day book is the primary source; live Tally is a supported fallback with an explicit degradation.**

Classifying a payable credit as employee-share vs employer-share requires seeing the voucher's *other* entries. The day book carries complete `entries[]`. The live Ledger-Vouchers report does not: AGENTS.md records that it "returns per-voucher rows (voucher-total amount, one display-particulars counterparty)". Live, the discriminator has to be the single `counterLedgerName`, which works for this company's booking pattern but is fragile when a JV has many legs.

Cost also favours the file: a Ledger-Vouchers call costs a near-fixed ~5.7 s regardless of row count, and `fetchLedgerRows` is sequential — 2 ledgers × 12 months ≈ 2 minutes live, versus a single file read.

So: `dayBookPath` is the recommended input; without it the review runs live and raises `pf_esi_source_degraded` on any voucher it cannot classify confidently.

---

## 4. The law (sourced), with captain confirm points

Clause 20(b) of Form 3CD reports **employees' contributions** under **s.36(1)(va)** read with **s.2(24)(x)**. Its six columns are: serial number, nature of fund, **sum received from employees**, **due date for payment**, **the actual amount paid**, **the actual date of payment to the concerned authorities**. Winman's four writable keys map onto the middle four; Winman supplies the serial number and takes the fund from the sheet identity.

The employer's contribution is **not** reported here — it belongs to clause 26 (s.43B). The extraction therefore deliberately ignores every `ACCRUE(employer)` row.

**CBDT Notification 23/2025 (28-Mar-2025), effective 01-Apr-2025, did not amend clause 20.** It touched clauses 12, 19, 21, 22, 26, 31, 36B and 44. The `INTER` sheet's `D1='2026-2027'` confirms these workbooks are the AY 2026-27 build, consistent with FY 25-26.

### Law table (to become `src/pf-esi-law.ts`)

| Fund | Due date | Authority | Status |
|---|---|---|---|
| P.F. | **within 15 days of the close of the wage month** (i.e. the 15th of the following month) | Para 38 of the Employees' Provident Funds Scheme, 1952 | **sourced** |
| P.F. | the former 5-day grace period **no longer exists** | EPFO circular 08-Jan-2016, withdrawn w.e.f. February 2016 (PIB release) | **sourced** |
| E.S.I. | **within 15 days of the last day of the calendar month** in which the contribution falls due | Regulation 31 of the Employees' State Insurance (General) Regulations, 1950 | **sourced** |
| E.S.I. | 21 days → 15 days, from the June 2017 contribution | amendment to Reg. 31 | **sourced** |
| Both | a deposit **after** the due date is **permanently disallowed** under s.36(1)(va); s.43B does not rescue it, even if paid before the return due date | *Checkmate Services P. Ltd. v. CIT-1*, 2022 INSC 1069, SC, 12-Oct-2022 | **sourced** |

### Confirm markers (the `src/tds-law.ts` C-marker convention)

C1–C6 below are the law-table markers. Section 6 repeats them for the captain and
adds C7–C8, two books-side assumptions the plan makes; all eight ship in code as
`CONFIRM_POINTS` (Task 5).

- **C1 — the 15th falling on a Sunday or a bank holiday.** Neither Para 38 nor Reg. 31 contains a next-working-day extension; the ECR/ESIC portals accept the next working day in practice and tribunals have not been uniform. *The plan computes a strict 15th and emits an advisory finding when the 15th is not a working day — it never silently extends the date.* Confirm the intended treatment.
- **C2 — the Explanation to s.36(1)(va) defines "due date" as the date the assessee is required to credit the contribution "under any Act, rule, order or notification … or under any standing order, award, contract of service or otherwise".** A company-specific standing order could impose an earlier date than the statutory 15th. The plan uses the statutory date. Confirm no such instrument applies to the operator company.
- **C3 — what goes in `AMOUNTPAID`.** The combined EPF/ESI challan covers employee + employer + admin charges. Clause 20(b) concerns only the employees' contribution, so the plan reports the **employee-share portion** of the deposit. Confirm this is the firm's reporting practice (the alternative — reporting the whole challan — would make the column incomparable with `AMOUNTCOLLECTED`).
- **C4 — the March wage month.** Its due date is 15-Apr-2026, i.e. after the audited FY. The plan reports the row in FY 25-26 with its actual next-FY payment date. Confirm.
- **C5 — one row per wage month.** Clause 20(b) does not prescribe granularity; monthly is standard because the due date is monthly. Confirm monthly rather than a single annual row.
- **C6 — `Other Funds`.** The third sheet (`D1='4.03.50.45.*.00'`, with a `NAMEOFFUND` dropdown fed by `INTER!$F$8:$F$10` = *Gratuity Fund*, *Other*, *Superannuation Fund*) is **not implemented by this plan**: the operator company has no such fund in the books, and labour-welfare-fund due dates are state-specific and were not sourced. Confirm it can stay out of scope.

Sources: [EPF Scheme 1952 (EPFO)](https://www.epfindia.gov.in/site_docs/PDFs/Downloads_PDFs/EPFScheme.pdf) · [EPFO withdraws the 5-day grace period (PIB)](https://pib.gov.in/newsite/PrintRelease.aspx?relid=134398) · [ESI (General) Regulations 1950 (ESIC)](https://esic.gov.in/Tender/ESIReg1950.pdf) · [ESI due date 21→15 days](https://corporatelawreporter.com/esi-contribution-payment-last-date-changed-to-15th-of-every-month-w-e-f-1st-july-17/) · [Checkmate Services P Ltd v. CIT-I (SC, 12-Oct-2022)](https://indiankanoon.org/doc/112342327/) · [Clause 20 of Form 3CD — ICAI Guidance Note analysis (Taxmann)](https://www.taxmann.com/post/blog/tax-audit-checklist-on-clause-20-of-form-3cd-under-income-tax-act/) · [CBDT Notification 23/2025 — clauses amended](https://taxguru.in/chartered-accountant/major-amendments-form-3cd-effective-01-04-2025.html)

---

## 6. Open questions for the captain

All of C1–C8 were answered with the plan's defaults and confirmed by the operator on 2026-09-23; the confirmed wording lives in `src/pf-esi-law.ts` CONFIRM_POINTS.

**C-markers** — the same numbering as §4's law table, which is the canonical marker
space for this feature (the `src/tds-law.ts` convention: they live in the law table as
`confirm` strings and are restated here so the captain can answer them in one place).
C1–C6 are §4's, repeated in one line each; C7–C8 are two further points the plan
surfaced while decomposing the work.

- **C1 — the 15th falling on a Sunday or a bank holiday.** The plan computes a strict
  15th and raises an advisory finding rather than extending it. 15-Mar-2026 is a
  Sunday, so February 2026's PF hits this immediately. **Strict 15th, or next working
  day?**
- **C2 — a standing order or contract of service imposing an earlier due date**, which
  the Explanation to s.36(1)(va) would make binding. The plan uses the statutory date.
  **Confirm none applies to the operator company.**
- **C3 — what goes in `AMOUNTPAID`.** The plan reports the employees'-share portion of
  the combined challan, so the column is comparable with `AMOUNTCOLLECTED`. **Confirm
  that reading, and that the operator can supply the split** — the challan itself is one
  figure covering employee + employer + admin charges.
- **C4 — the March wage month**, due 15-Apr-2026 and therefore paid in FY 26-27. The
  plan reports the row in FY 25-26 with its actual next-FY payment date, and the
  template accepts that out-of-year date (Review Focus #5). **Confirm.**
- **C5 — one row per wage month** rather than a single annual row. **Confirm monthly.**
- **C6 — the `Other Funds` sheet** (`D1='4.03.50.45.*.00'`, `NAMEOFFUND` fed by
  `INTER!$F$8:$F$10` = *Gratuity Fund*, *Other*, *Superannuation Fund*) is **not
  implemented**: the books show no such fund and labour-welfare-fund due dates are
  state-specific and unsourced. The tool leaves that sheet untouched. **Confirm it can
  stay out of scope**; if not, it is one law-table row and one template column.
- **C7 — wage month vs voucher month.** The plan takes the wage month from the salary
  journal's own date, because the operator company books each month's salary on that month's last day.
  **Confirm no salary journal is ever dated into the following month** — if one is, the
  wage month has to come from the narration or an operator column instead.
- **C8 — part payments.** The template takes one challan per fund per wage month and
  rejects a second (Task 7). **Confirm a wage month is never deposited in two
  challans.** If it can be, `PAIDON` should carry the last date and `AMOUNTPAID` the
  sum, and the parser must aggregate rather than reject.

**Product and process questions:**

- **Q1 — where should the filled workbook be written?** The plan writes a **copy** to
  the report directory and never touches the source, because the source folder is the
  captain's live Winman working set. If you would rather it write next to the source
  with a suffix, say so — it is one default.
- **Q2 — may a Winman-shaped fixture be committed?** The plan commits a *synthetic*
  fixture only. The real workbook carries client data and a signed third-party VBA
  project, so V4 (the actual Winman import click) stays a manual, captain-operated
  step recorded in the design doc. Confirm that is acceptable rather than wanting a
  redacted real file in the repo.
- **Q3 — which is the authoritative books source for this feature?** I recommend the
  day book (`daybook-export-25-26.json`), with live Tally as a fallback. That
  matches §3's measurement and the existing `dayBookPath` channel. Confirm.
- **Q4 — fund ledger overrides.** The heuristic finds `Provider PF Payable A/c` and
  `the ESI payable ledger` correctly on the operator company and rejects the `Weighing Machine XY-PF`
  false positive, but other companies will differ. The plan adds a `pfEsiLedgers` key
  to `config/overrides.json`. Confirm that is the right escape hatch (it matches
  `wrongGroup` and `as26MapPath`).
- **Q5 — is the employer's share really out of scope?** I exclude it: clause 20(b)
  is s.36(1)(va) employees' contributions; the employer's share is clause 26
  (s.43B). Confirm — it is the single largest judgement in the mapping.
- **Q6 — execution method.** The plan is ten tasks whose interfaces interlock
  (Tasks 2–3 share a module; 6 and 8 share another). I recommend **native execution**
  in one session with a single whole-branch review at the end, because the plan
  already carries the design and a fresh context per task would re-derive the Winman
  protocol ten times. Say the word if you would rather have subagent-driven execution
  with a fresh reviewer per task.

**Not a question, a warning:** V4 — pasting into Winman and confirming the import —
cannot be automated from here and is not attempted in this plan. Until a captain runs
it once, the round trip is verified only as far as "Excel opens it clean, the macros
run, and `ValidateMandatoryFields` returns True" (V1–V3). That is a real but
incomplete guarantee, and Task 4 Step 3 is where the result gets recorded.

---

All fourteen questions above are carried as a single captain hold on the backlog task
`ta-3cd-pf-esi` (the implementation this plan gates), with the report as its pointer —
per `captain-hold-lifecycle`. Nothing here is blocked on me; the plan is complete and
buildable the moment C1–C8 and Q1–Q6 come back.

---

## 10. Live validation

To be completed by the implementing run, against the nameless live company, in
the shape of §18.1 of the depreciation verification design
(docs/design/2026-09-16-depreciation-verification-design.md).

The round trip is verified mechanically as far as V3 — V1 structural (every
non-target package entry byte-identical), V2 Excel opens the workbook clean, and
V3 Winman's own ValidateMandatoryFields gate passes — by
scripts/verify-winman-roundtrip.mjs and the vitest suites. **V4 — the Winman
import click — is captain-operated and cannot be automated from here:** the
operator opens the workbook from disk, clicks Copy on the P.F. sheet and pastes
into Winman clause 20(b), then confirms the rows land. It is the honest manual
boundary and is not attempted by the plan.

### 10.1 What the implementing run found

**V2 and V3 pass against the real workbook (2026-09-23).**
`scripts/verify-winman-roundtrip.mjs` was run on a scratch copy of the real
`PF ESI funds.xlsm` — the source file was never written to; the copy was made
to `/tmp`, and the output went to `/tmp` too. It wrote two sample rows into
`P.F.` via `writeSheetRows` and opened the result with Excel 16.0 over COM from
WSL2:

```
wrote 2 sample row(s) into "P.F." of /tmp/pf-out.xlsm (first data row 7, prototype 6, AY 2026-2027)
PASS  V2 sheets == 18
PASS  V3 P.F. visible after WorkBook_UnhideSheets
PASS  V3 ValidateMandatoryFields
PASS  V2/V3 lastRow == prototype + rows (8)
ROUNDTRIP_OK V2+V3
```

Excel opened the rewritten package with no repair prompt, `Sheets.Count == 18`,
and `WorkBook_UnhideSheets` made `P.F.` visible. `ValidateMandatoryFields(P.F.)`
returned `True`, and `UsedRange` ended at row 8 (prototype row 6 + 2 data rows).
V1 is the structural suite in `test/winman3cd.test.ts` and `test/xlsm.test.ts`.

Two Excel-from-WSL traps were found live and are encoded in the script: (a)
`$wb.Close($false)` hangs indefinitely once `ValidateMandatoryFields` has run —
`$xl.Quit()` alone releases the workbook, so the script does not Close; (b)
`$xl.Quit()` returns while the `EXCEL.EXE` process lingers, so the script
captures the app's PID from its window handle and force-kills only that
instance (never `EXCEL.EXE` by image name — the operator may have other
workbooks open).

**V4 is still pending.** The Winman import click is captain-operated: the
operator opens the workbook from disk, clicks Copy on the `P.F.` sheet and
pastes into Winman clause 20(b), then confirms the rows land. Until that
happens the round trip is verified only as far as V1–V3 — a real but incomplete
guarantee. Replace this paragraph with the observed result (date, workbook,
sheet, rows landed, and any Winman validation message) once V4 happens.
