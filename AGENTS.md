# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges found during Milestone 1 (trial balance review)

- The downstream `tally_get_ledger_vouchers` tool (in the sibling
  `tally_prime_mcp_server` repo, `src/tools/reads.ts`) returns a report
  envelope object (`{ source, company, ledgerName, ..., vouchers: [...] }`),
  not a bare array. Row fields are `partyLedgerName`, `counterLedgerName`,
  and `matchedLedgerName` — there is no `counterparty`/`ledgerName`/`party`
  field. `src/downstream.ts`'s `ledgerVouchers()` extracts `.vouchers`, and
  `src/review.ts`'s `NAME_FIELDS` list uses the real field names. Re-check
  this against the live server if `tally_prime_mcp_server` changes shape —
  the recorded fixtures do not update themselves.
- `src/vault.ts`'s `Vault.entries()` must return each alias in its original
  case (e.g. `"Creditor 1"`), not the lowercased lookup key used internally
  for case-insensitive `resolve()`. Getting this backwards silently breaks
  `demaskText` (the alias text in a masked finding/report never matches),
  which is exactly the de-masking path the trial balance report depends on.
- **Tally's ledger master balances are raw Tally sign: negative = debit** —
  while everything downstream of the gateway is positive = debit (R-MCP-5).
  The sibling server's own `tally_trial_balance` flips with `-toAmount(...)`
  (its `src/tools/reads.ts`), and `src/downstream.ts`'s `ledgers()` flips it
  at the gateway boundary too (fixed 2026-09-13, source-verified only). From
  WSL, live Tally is reachable at `127.0.0.1:9000` under mirrored networking;
  the NAT-mode host address `172.21.80.1` is stale and times out — do not use
  it. Its fixtures encode the raw master
  sign (`test/fixtures/tally-responses.json`). Any new consumer of master
  balances should rely on this convention, never re-flip.
- The masking group-name allowlist (`CLEAR_ROOTS`/`PRIMARY_GROUPS` in
  `src/classify.ts`) was verified against one live company, SJ Infra
  (FY 25-26), on 2026-09-08 — 63 groups read from `tally_get_groups`,
  corrected in commit `e883445`. What that verification found:
  - Tally spells it `"Branch / Divisions"`, with spaces around the slash.
  - A top-level group's `parent` field is not empty — it is a U+0004
    control character followed by `" Primary"` (Tally's internal root-of-
    primaries node). The ancestry walk treats that value as a root
    terminator exactly like an empty parent.
  - `Bank OD A/c`, `Secured Loans` and `Unsecured Loans` sit under the
    primary group `Loans (Liability)`, not at top level.
  - A real company can park operational sub-groups directly under Sundry
    Creditors (e.g. `SALARY`, `Wages`, `SITE EXPENSES`, `SUB CONTRACTORS`);
    these mask correctly by ancestry with no special-casing — this is
    exactly why the policy is default-mask rather than an enumerated
    mask-list.
  - This was verified against ONE company. A different company can still
    carry group names neither verification has seen; default-mask plus
    `config/overrides.json` is the safety net for that, not a guarantee
    the allowlist itself is complete.
- `TALLY_MCP_ARGS` must be a JSON array of strings whenever any path in it
  contains a space (every path does on the machine this was verified on) —
  see `src/config.ts`'s `parseDownstreamArgs`. A plain whitespace-separated
  value still works only when no argument contains a space.

## Sharp edges found wiring milestone 1 up for real (2026-09-09)

- **The upstream Tally MCP server is `F:\Software Projects\tally_prime_mcp_server`**
  (package `tally-prime-mcp-server`; its `dist/` is gitignored build output,
  not committed — run `npm run build` in that folder after pulling its changes,
  then restart the gateway/session to pick them up). Confirm any candidate by
  grepping its `dist/` for the five tools
  `src/downstream.ts` calls. The `tally_mcp_server_v6` directory under
  `F:\AgenticWorkspace\Tally Prime Automation\` is a decoy — an unrelated older
  server registering none of them — and its `1766393040_`-prefixed sibling is
  empty.
- **Never compare `import.meta.url` to `process.argv[1]` as strings.** A file
  URL percent-encodes a space; argv does not. Getting this wrong made the
  gateway exit 0 in silence on every install path containing a space, which a
  harness reports only as "the server would not start". Same root cause bit
  `URL.pathname`, which yields the `/C:/...` form that Windows `fs` rejects.
  Both are now `fileURLToPath`-based in `src/index.ts` (`isEntrypoint`,
  `overridesPath`), covered by `test/entrypoint.test.ts`. Any new path
  derivation in this project should go the same way.
- `loadOverrides` fails open by design — a missing overrides file is normal —
  so it now takes a `warn` callback and `src/index.ts` prints the reason to
  stderr. Silence there is what hid the `pathname` bug for a whole milestone;
  keep the warning if that code is touched.
- **The `Read(<reportdir>/**)` deny rule also blocks Bash reads of that path**,
  verified in isolated `claude -p` runs (control without the rule leaks the
  file; control on a non-denied path proves Bash was genuinely enabled). So a
  single `Read(...)` rule is sufficient and no Bash restriction is needed. The
  method for re-verifying is in `harness/claude-code.md`.
- `harness/claude-code.md` is the verified, real-paths setup document and the
  single owner of the machine specifics; `harness/opencode.md` deliberately
  points at it rather than duplicating them.

## Sharp edges found during Milestone 2 (GST summary & mismatch, 2026-09-13)

- The masked tax-ID channel (design: `docs/design/2026-09-13-gst-summary-mismatch-design.md`)
  is the pattern every later tax-ID feature must follow: fetch IDs internally
  via the narrowest downstream field set (`tally_get_ledgers` verbose:true —
  *not* `tally_get_ledger`, whose ban stands), ingest ID-bearing operator data
  by file path only (`tb_gst_mismatch`'s `returnsPath`), correlate through
  vault aliases (`TaxId N`), and keep `redactTaxIds` on every outbound string.
- **Money figures in finding details must never be bare 6+-digit numbers**:
  `scrubDigits` eats digit runs of ≥6, and bare `"100000.00"` reaches the
  model as `"[number].00"`. GST details use Indian grouping
  (`1,00,000.00`) for this. The M1 check details still use `toFixed(2)` —
  the same latent collision is un-fixed there (milestone boundary).
- Party buckets in `gstBooks` must be creatable from either a tax line or a
  taxable line — whichever the voucher lists first — or taxable value reads
  zero for the normal Tally layout (party line before tax lines).

## Sharp edges found during Milestone 3 (single-ledger scrutiny)

- Every outbound string passes `scrubDigits` (6+ digit runs → `[number]`),
  so finding details must use `src/format.ts`: `money()` (Indian grouping)
  and `displayDate()` (`16-Jan-2026`). A bare `YYYYMMDD` or `100000.00`
  reaches the model mangled.
- Ledger balances for a period come from `tally_trial_balance` (date-bounded,
  positive = debit), never from the ledger master: the raw Tally master sign
  (negative = debit) is flipped once at the gateway boundary by `ledgers()`
  (see the M1 bullet above), but `CLOSINGBALANCE` is not bounded by any date.
- The downstream ledger report nests `taxBreakup.taxLedgers[]` and
  `matchCandidates[]`; `maskVoucherRow` in `src/review.ts` masks and sweeps at
  every depth. A new nested name field must be added to `NAME_FIELDS`.
- `matchedSide` is `"debit"`/`"credit"` from the live server but `"Dr"` in the
  older M1 fixture row; `ledgerVoucherRows()` accepts both.

## Sharp edges found during the WSL setup (2026-09-14)

- The gateway→upstream request timeout defaults to the MCP SDK's 60 s, which
  aborts `tb_review` on any real company. `TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS`
  (parsed in `src/config.ts`, passed to `client.callTool` in
  `src/downstream.ts`) raises it; the upstream's `TALLY_TIMEOUT_MS` and Claude
  Code's `MCP_TOOL_TIMEOUT`/`MCP_TIMEOUT` must rise with it. The real ceiling on
  a large company is the upstream connector's whole-company voucher export (40 MB
  trial balance, 53 MB GST day book, no date filter), which can drive Tally into
  its `Error` state; a timeout there is upstream, not the gateway, and Tally
  recovers only on restart. Per-setup details: `harness/claude-code.md`'s WSL2
  section.
- WSL2 mirrored networking puts Tally at `127.0.0.1`, not a NAT-mode host IP;
  POSIX permission rules need the `//` prefix
  (`Read(//home/ram/tally-reports/**)`); and `TALLY_DEFAULT_COMPANY` is
  recommended because the upstream will not auto-select the loaded company. See
  `harness/claude-code.md`.

## Sharp edges found adding check 8 (ledger in wrong group)

- A finding `detail` may quote a ledger's whole name, never a word of it.
  `maskFinding` swaps only the whole string for its pseudonym, so a quoted
  fragment of a masked name reaches the model. `test/leak.test.ts` holds
  `orchid` and `medical` as secrets to catch exactly this.
- The `wrongGroup` key of `config/overrides.json` is read by
  `loadWrongGroup` (`src/overrides.ts`), separately from `loadOverrides`.
  Unlike `loadOverrides`, it throws on a bad keyword. `Finding.expected` may
  hold a group nature (`expense`, `asset`, …) as well as a side.

## TDS compliance review (design of record)

- The TDS review design is `docs/design/2026-09-14-tds-compliance-review-design.md`
  (operator-file contract, `TDS-` ordinal space, law table with its C1–C8
  confirm markers) — read that doc before touching `src/tds*.ts`.
- The TDS review rides the per-ledger monthly Ledger-Vouchers path, never the
  Day Book; the operator TDS file is the TDS `returnsPath` channel (path only,
  TANs never echoed); the FY-25-26-only law table lives in `src/tds-law.ts`
  with its C1–C8 confirm flags.
- **Booking-side sign (fixed 2026-09-22):** a TDS booking is a **debit** row
  on an expense/purchase ledger (a normal `Dr Expense / Cr Party` voucher);
  downstream of the gateway positive = debit, so `extractEvents`
  (`src/tds.ts`) tests `r.amount > 0` and takes `gross: r.amount`. The
  predicate previously tested a **credit** (`r.amount < -ZERO`), which never
  fires for a normal booking, so every real booking was invisible (0 findings);
  the unit fixtures encoded the same inversion until corrected with the fix.
  Never re-flip the sign: the gateway flip is `src/downstream.ts`'s `ledgers()`
  and `ledgerVoucherRows`' `sideSign`, once, at the boundary (R-MCP-5). The
  payment (party-ledger debit) and duty (credit = deduction, debit = deposit)
  predicates were already correct and are unchanged.
- **TDS party→master resolution is indexed once** (`masterOf`, `src/review.ts`'s
  TDS session): `analyzeTds` calls `panKeyOf`/`entityOf`/`deducteeTypeOf`/
  `certificateRateOf` per booking, and the linear `masters.find` each closure
  used blocked the event loop for 30+ min on a real FY 25-26 day-book run
  (~6.8k bookings against ~2.7k masters). Never reintroduce a `find` there;
  `test/tds-review-perf.test.ts` is the regression guard. On finding-heavy runs
  the remaining cost is masking (`maskKnownNames`, `src/mask.ts`): O(findings ×
  vaulted names), rebuilding a RegExp per entry per string.
- **The engine's duty side is the union of master-flagged duty ledgers and the
  operator template's `TDS Duty` rows** (`dutyLedgerNamesAll`, `src/review.ts`).
  Tally masters on a real company can carry zero TDS flags, leaving the
  master-derived set empty and every booking reported as undeducted; the
  template's `Ledger Kind: TDS Duty` rows are then the only duty signal.
  Master-flagged behaviour is unchanged (the union is a superset), canonical-key
  deduplicated; `test/tds-duty-ledgers.test.ts` guards both cases. Populating
  the duty side is necessary but not sufficient: if the books genuinely contain
  few duty credits against many bookings, the bulk of `tds_not_deducted` is
  **substantive**, not a wiring artifact — read that total as an upper bound.

## Sharp edges found fixing the s.194Q threshold (2026-09-23)

- **A non-wholeYear section's liable base is the running cumulative through
  each booking, never the year total.** The pre-fix code measured against the
  year-end aggregate, so every pre-crossing booking was liable whenever the
  year's excess covered it (on a real FY 25-26 run: 3,433 194Q findings, median
  ~₹888). `analyzeTds`'s per-aggregate loop now sorts a copy by date, computes
  the crossing with a running `before`, then a second pass tracks `cumulative`
  and takes `max(0, min(gross, cumulative - threshold.aggregate))`. Never
  re-measure against `agg.gross` here; `wholeYear` sections keep the old
  whole-year rule.
- **194Q is applicable by default** (captain, 2026-09-23). The
  buyer-turnover condition is an operator fact, not book evidence: the
  template's **optional `Settings` sheet** (`194Q Applicable`, pre-filled `Y`)
  and the JSON `section194QApplicable` key suppress the whole section when
  false; absent or blank means applicable. `parseOperatorTemplate` tolerates a
  missing Settings sheet (`settings194QApplicable`), `EMPTY_TDS_OPERATOR`
  carries `true`, `analyzeTds` skips 194Q aggregation when suppressed, and
  `TdsReviewResult.section194QApplicable` reports the state. Operator
  walkthrough: `docs/operator/tds-operator-template.md`.
- Measuring offline: a stub downstream whose `groups`/`ledgersTax` reject plus
  a day-book bundle runs `Session.tdsReview` with no live Tally (the session
  degrades by design and reads the bundle's groups/ledgers).

## Sharp edges found implementing depreciation (2026-09-16)

- The design of record is `docs/design/2026-09-16-depreciation-verification-design.md`
  (including §18.1 live validation) — read it before touching `src/depreciation*.ts`.
- The Ledger Vouchers report honours only the **last month** of a multi-month
  range (month chunking is correctness, not optimisation) and some rows leak
  **forward** into later windows, which is why the range re-filter in
  `ledgerVoucherRows` (`src/downstream.ts`) must never be removed.
- Block rates come from the **group** name; a `%` in a **ledger** name is a
  GST rate and must never be parsed as one (live ledgers end `- 18%` / `- 28 %`).
- Book depreciation is identified by the counter ledger's group and name
  (`/deprecia/i` under an expense root), never by voucher type or a year-end
  date; the live annual journal predates year end and leaves later
  acquisitions undepreciated (check `DEP-012`).
- A disposal can be routed entirely outside the asset ledgers (credited to a
  disposal ledger under `Sales Accounts`), so the disposal-signal income
  ledgers are a required input, and `DEP-007` fires critical on an unmatched
  disposal-signal row.
- **The depreciation review's two-pass residual skip does not fire on live
  Tally**: Ledger Vouchers seen from the expense side returns per-voucher rows
  (voucher-total amount, one display-particulars counterparty), so per-asset
  charge attribution is impossible there and pass 2 fetches every asset
  ledger. A full-FY run is ~12 min (needs the 900 s timeout chain in
  `harness/claude-code.md`); the skip remains under `TALLY_AGENT_DEP_DEBUG`
  diagnostics. See design §18.1 before trying to "fix" the skip.
- Masked review output masks block group names too (over-redaction beyond
  design §3's letter); the workbook de-masks them via the vault. Recorded so
  the two documents do not look contradictory.
- **The pass-2 fetch skip is a transport optimisation and must never decide
  scope** (fixed 2026-09-30, `isAssetRowInScope` in `src/depreciation.ts`,
  used by `depreciationReview` in `src/review.ts`). The skip drops ledgers
  whose closing−opening+charge residual is ~0 — which is every IDLE asset once
  the FY depreciation journal is deleted. `input.ledgerRows` was built from the
  skip list, so 20 idle ledgers (₹92.4 lakh of opening) vanished and their
  block share was piled onto the movers, inflating e.g. TANDEM ROLLER from
  ₹4,69,609 to ₹14,00,183. Scope is "moved OR has a non-nil opening", full stop
  (`isNil(bookOpening)` is the nil test — never a truthy check). An asset
  ledger with a nil TB balance at BOTH ends is not an asset row and gets no
  row: 4 of the 24 candidates on the real company were nil-both-ends, which
  is why 20 rows appear, not 24.
- **Every asset is computed at its OWN rates; the block total is never spread**
  (2026-09-30, captain; `computeAssetFigure`/`attributeBlockToAssets`,
  `src/depreciation.ts`). The old `allocateToAssets` pro-rata'd the block over
  the assets, which blended one blended rate (14.954% on the reviewed company)
  into every asset and made each asset-wise difference an artifact of the
  split. Now: full rate on the asset's own opening WDV, full rate per
  acquisition put to use ≥180 days and half per acquisition under 180 days
  (per ACQUISITION, not per ledger — `shortPeriod` is `true` only when every
  addition is short, and a mixed asset gets a `mixed put-to-use:` note), and the
  asset's OWN sale/writeoff/discount credits netted against that asset alone.
  The asset column then sums to the statutory block total by itself.
- **A block-level item is stated on its own line, never spread**
  (`attributeBlockToAssets` → `BlockResidual`, the Assets sheet's
  `Block-level difference — not attributable to any one asset` row, and
  `dep_block_residual_unattributed`, DEP ordinal **16**). Genuine causes: an
  operator block opening WDV that is not the sum of the assets' openings,
  `additionalDepreciationCarryForward`, a credit that reached past the asset it
  was booked on, s.50, `extinguished`. The ONE exception is rounding:
  `ROUNDING_TOLERANCE` (one rupee, exported from `src/depreciation.ts` and the
  single knob) — a residual within it is pure per-asset paise drift, so the
  LAST asset is restated to `block total − Σ others` and no residual is
  reported. The import-JSON generator reads the workbook, so a non-ledger row
  with a non-zero amount is a hard import error there.

## Sharp edges found implementing the TDS spreadsheet input (2026-09-16)

- The design of record is
  `docs/design/2026-09-16-tds-spreadsheet-input-design.md` (kept in the
  firstmate data tree, section-source report). Section resolution is
  `resolveSection(expenseLedger)` — one argument, no party — and a bare
  `194-I` key is rejected everywhere; only `194-I(a)` (plant/machinery) and
  `194-I(b)` (land/building) exist in the law table.
- `src/xlsx-read.ts` (reader) deliberately shares **no code** with
  `src/xlsx.ts` (writer): two independent zip+XML stacks, both zero-new-deps.
  The writer's `Sheet extends state` (used for the Winman fixture's
  veryHidden `List` decoy) is the only writer-side addition since the
  depreciation plan.
- Template parser and Winman parser share the error contract: sheet, row
  (as Excel shows it), column letter + header — never a cell value (a stray
  operator cell can be a PAN/TAN). The parse of the generated blank template
  is `EMPTY_TDS_OPERATOR`, which is also the no-operator-facts run input.
- Winman's Deductor block TAN is parsed and **dropped immediately**; it is
  never bound to a variable any caller can see. Winman challans are derived
  from the **Deduction sheet's allocation** joined to the Challan sheet by
  `(id, quarter)` (challan ids restart each quarter); the Challan sheet's own
  section label is never a section key, and a bare `194I` label counts into
  `skipped.noSection` instead of folding to either 194-I sub-section.
- `OperatorParty.pan`/`panRow` exist only for §8.4's template-vs-Winman PAN
  agreement check (error cites the Parties row, never the value); the JSON
  channel never sets them, and nothing downstream reads the PAN directly —
  the Winman-name join adopts the PAN through `vault.pseudonym(.., "tax_id")`
  like every other tax id.
- The writer emits `{header:""}` blanks fine, but `buildWorkbook` maps data
  cells positionally against `columns` — a row cell past the column list is
  silently dropped (the winman fixture caught this).

## Sharp edges found adding manual 26AS matches and links (2026-09-30)

- Design of record is design doc §14 (operator channel; captain's ruling that
  AUTOMATIC matching stays exactly as it is). Code `src/as26.ts`
  (`selectManual`, `assertManualParties`, `resolveManualMatches`,
  `resolveManualLinks`, `MANUAL_MATCH_SHEET`/`MANUAL_LINK_SHEET`), the two
  sheets in `src/as26-template.ts`, the `manualLinks` override in
  `src/as26-bill.ts`, and the `recon[].manualLinks` rebuild in `src/review.ts`
  (`as26Review`'s masking block — a new recon field carrying real dates/refs
  MUST be rebuilt there or `sweepStrings`/`scrubDigits` eats or leaks it).
- **Manual matches run inside `reconcileParty`, after the 1:1 and
  `pairEqualLeftovers` stages and before the invoice-anchored/subset search.**
  That is the only placement where a declared match beats the automatic stages
  and cannot be consumed twice by them; the pool it resolves against is
  therefore exactly what the two unmatched sheets show. Manual LINKS resolve
  against the party's whole books/sales pools instead, because a paired entry
  still gets a bill-value comparison.
- A manual match is a `recon[].combinations` entry with `basis: "manual"`, so
  everything downstream (B/D id reservation, `explained` rows, the Combination
  sheet, finding pointers) works unchanged — do not add a parallel mechanism.
  `LinkBasis` gained `"manual"` in BOTH `src/as26.ts` and its `src/as26-bill.ts`
  twin; a new consumer must handle it in both.
- **Instructions are bound to `(side, date, tax)`, never to a row id** — ids are
  assigned per run from sorted rows and move. Dates are parsed by
  `parseOperatorDate` (report format / `YYYYMMDD` / ISO / Excel serial);
  `GridCell.isDate` is what distinguishes a serial from a number.
- **Refusals throw, never silently drop**, and cite sheet + row + column letter +
  header — never a cell value. `assertManualParties` runs once before any party
  is reconciled so an instruction naming an unknown or shared-ledger party fails
  the whole run rather than one party. A shared-ledger party is totals-only by
  construction and therefore refuses instructions.
- The identity `Σ unmatched books − Σ unmatched 26AS = booksTax − as26Tax`
  (within `AS26_TAX_TOLERANCE`) holds with and without instructions, and
  per-party `booksTax`/`as26Tax`/totals never move: only `ambiguous` and
  `combinationExplained` shift, and only towards "explained". Guarded in
  `test/as26-manual.test.ts`.

## Sharp edges found round-tripping the Bank Interest sheet (2026-09-30)

- `bankInterestSheet` (design §12.5) wrote `rows: []` while every other
  operator sheet is pre-filled from the map in force, so
  `tb_write_26as_template` DROPPED the operator's bank list on every re-fill.
  A bank left off the sheet stops being a bank (it falls back to bill-level
  reconciliation and loses its 194A totals comparison), so a re-fill silently
  changed the review's basis: measured on Narayanan, one bank party went
  unmapped, totals moved 17,172,194 -> 17,097,558 and two `mapping_gap`
  findings appeared. Fixed by passing `map.banks` through; guarded by a
  round-trip test in `test/as26-template.test.ts`.
- The sheet's parser reads ONE row as (bank name, ONE interest ledger, ONE FD
  ledger) and REFUSES a ledger named twice anywhere on the sheet, so a
  pre-fill must emit one row per ledger, repeating the bank name.
- **Never trust a row id from an earlier report** when picking rows for a demo
  or for an operator instruction: ids are assigned per run from the sorted rows
  and move with the data. On Narayanan, row ids read off the v9 workbook pointed
  at different entries on the current baseline. Bind by (date, tax), as the
  manual channel does.

## Sharp edges found adding the offline day-book input (2026-09-22)

- The gateway's `StdioClientTransport` cannot receive a whole-FY day book —
  three of three attempts ended `McpError -32000: Connection closed` with the
  upstream exiting `code=0` mid-response, while a raw newline-delimited stdio
  client took the same export without trouble. This is why the day book is a
  file channel and why `scripts/export-daybook.mjs` eschews the SDK.
  Live-verified: whole-FY 14,356 vouchers = 16.0 MB written in 126 s.
- A Ledger-Vouchers call costs a near-fixed ~5.7 s whatever its row count,
  and `fetchLedgerRows` is sequential, so cost scales with *call count*
  (~600 active ledger-months ≈ 57 min). Optimise call count, never payload
  size — passing `dayBookPath` removes the calls entirely (measured month
  comparison: live 39 s vs file 12 s).
- The live day book returns `date` and sometimes `voucherNumber` as JSON
  **numbers**. `normDate` and the projector coerce with `String(...)`; any
  new comparison must too. A `===` between a string date and a numeric one
  fails silently and looks like "no data" — the Task 9 join probe hit
  exactly that before switching to `String(...)` on both sides.
- The same export can carry an **object** where the field is typed `string`:
  `partyLedgerName` arrived as `{}` on 167 of 2,968 vouchers of a real FY
  bundle, and `String()` turned it into the literal `[object Object]`, which
  then read as a ledger name all the way into a finding detail
  (`gst44_party_not_in_masters`) and a report cell. `partyName`
  (`src/downstream.ts`) is the single coercion — string trims, object yields
  its first usable name field, empty object is ABSENT so the voucher's own
  creditor-entry fallback runs — and `gst44`/`gst44-worksheet` run their party
  through it too. Never `String()` a raw Tally field; an absent name beats a
  fabricated one (post-fix the affected journals land honestly in
  `gst44_unattributed_expenditure`, not under a phantom party's bucket).
- `readFile` + `JSON.parse` on a 67 MB day book measured **483 MB peak RSS
  in 3.0 s** (300k synthetic vouchers; scales roughly linearly, so the 64 MB
  `TALLY_AGENT_DAYBOOK_MAX_MB` default is safe on any machine with ≥4 GB
  free). Streaming is not needed below the ceiling.
- The verbose ledger master export carries no PAN and no TDS flags (the
  upstream never requests those fields) — those facts come only from the
  operator TDS file. What the masters really supply is `parent`, which
  drives classification and masking; a bundle's `ledgers`/`groups` arrays
  substitute for it (`mastersSource: "bundle"`), and with neither every
  ledger default-masks and raises `tds_daybook_ledger_unmastered`.
- The live Ledger-Vouchers report **dedupes its display rows**: entries
  repeating the same date, voucher type and amount collapse to one row, so
  a day-book projection legitimately yields 2,399-FY findings where live
  yields ~10 fewer `tds_not_deducted` per matching month window (whole-FY
  detection). The projector is per accounting entry — do not imitate the
  display dedupe to make the paths "match" (same D5 reasoning; recorded in
  design §10, 2026-09-22).

## Sharp edges found implementing the 26AS mapping template (2026-09-23)

- The fillable 26AS party-mapping template (`src/as26-template.ts`,
  `tb_write_26as_template`) is the Excel sibling of the TDS template: the
  operator fills the "Tally ledger" column and passes it back as
  `as26MapPath`. `loadAs26MapFile` dispatches on extension
  (`/\.xls[xm]$/i`) to `parseAs26MapTemplate`, else `loadAs26Map`;
  `Session.as26Review` calls `loadAs26MapFile`, so the JSON map is unchanged.
  Worksheet row numbers and JSON entry indices are different NUMBER spaces —
  the template error cites the 1-based Excel row, the JSON error the 1-based
  entry index; both never echo a name.
- The template is written directly by `buildWorkbook` (NOT the de-masking
  `writeWorkbook` vault wrapper): it carries real 26AS and ledger names on the
  operator's disk, like the report workbook, and nothing in it was ever
  masked. `tb_write_26as_template` pre-fills previously effective mappings
  (from the map) and one row per distinct canonical 26AS name (tax summed
  across summaries) for iterative re-fill; a name mapped to several ledgers
  emits its deductor row plus one follow-on row per extra ledger (same
  name/kind, blank tax), so a multi-ledger map round-trips on re-fill.
- The Tally-ledger dropdown is always backed by the `Ledgers` sheet's range
  (`Ledgers!$A$2:$A$N`), never an inline OOXML list: an inline list is one
  comma-joined quoted string capped at 255 chars and breaks on a comma or
  quote, so it cannot carry a real company's ledger list (thousands of names).
  The writer's `Column.validation` accepts `{ formula }` for exactly this; the
  `Ledgers` sheet is written even when the list is empty. The list comes from
  `dayBookPath` (`readDayBookLedgerNames`, which reads only `ledgers[]` and
  skips the period validation `readDayBook` enforces) else live masters
  (`Session.ledgerNames`, degrades to [] with a warning when Tally is down).
- Design of record §10 covers the workflow; operator walkthrough is
  `docs/operator/26as-mapping-template.md`.

## Sharp edges found implementing 26AS reconciliation (2026-09-22)

- The design of record lives in `docs/design/2026-09-22-form-26as-reconciliation-design.md`
  (ordinal table, tolerances, honesty rules, privacy contract, operator
  mapping workflow) — read it before touching `src/as26*.ts`.
- TRACES 26AS summary sheets are matched by normalized sheet name
  **ignoring hidden state** — every TRACES data sheet is hidden, unlike the
  Winman parser's visible-only filter. Detailed-sheet names band down
  (carry the last non-blank forward); transaction dates are text
  `dd-MMM-yyyy`, and float tails like `230000.8900000001` are round-2'd at
  the parser.
- TAN/deposit/subtotal columns are never bound by the parser; errors cite
  sheet/row/column, never a cell value. Real TRACES headers carry `(Rs.)`
  suffixes, so `bindHeader` is two-pass — exact token first, prefix second
  (`Amount Paid / Credited(Rs.)` ≠ `amountpaidcredited`); first bind wins,
  which is also what keeps `GROSSRECEIPT` from stealing its
  `GROSSRECEIPTSASPER26AS` column.
- check 003 is **taxable-only** since D3: `assessable_value_mismatch` compares
  26AS gross against books taxable (Sales-Accounts-root debit magnitudes) with
  `AS26_VALUE_TOLERANCE` (1000); the GST-inclusive reading was dropped from the
  check and re-homesteaded on the Deductors sheet. Its detail ends with the
  honest pointer "Bill-level value rows, where present, carry the per-invoice
  detail." — never promise a sheet that may be empty.
- `matchParties` is mapping-only (captain deviation): no canonical
  auto-match exists anymore — unmapped/ambiguous pairs become `mapping_gap`
  findings; `config/as26-map.json` follows the overrides-file semantics
  (missing→EMPTY+warn, malformed/dup/blank throw citing the entry NUMBER),
  `config/as26-map.sample.json` ships committed, and `tb_26as_review` takes
  an optional `as26MapPath` override for iterative correction.
- Books evidence split: deductions ride the month-chunked receivable-ledger
  path (`deductionEvents`, positive=debit at the boundary — never re-flip),
  sales ride the voucher walk (`booksSales`, one BooksSale per outward
  voucher, taxable = Sales-Accounts-root debit magnitudes; ref =
  `voucherNumber` because `VoucherRow` has no `reference` field). Party+period is
  the join; `kindOf`/`partyOf` are exported additively from `src/gst.ts`.
- `booksSales`' `kindOf` needs `ctx.groupOf(ledger)` populated from the
  **ledger master pairs** (`ledgersTax`/bundle ledgers), NOT the group tree:
  without a master row for a sales ledger its sale silently vanishes (test
  fakes must include sales-account ledgers in masters).
- All dates the review result emits are `displayDate`-formatted at the
  session boundary (schedule labels, recon items, book events): a bare
  `YYYYMMDD` string in any outbound string is eaten by `scrubDigits`
  (`[number]`). `tb_26as_review`'s books dates included.
- The 26AS books-side credit ledgers are the operator's **Credit Ledgers
  sheet** on the mapping template (`As26Map.creditLedgers`, `CreditLedgerMapping
  {ledger, kind}`, sheet name `CREDIT_SHEET`). The override is **PER KIND**:
  a kind with declared ledgers uses exactly those (verified against the ledger
  masters — an unknown name is a hard error, never dropped), a kind with none
  declared still runs the heuristic. Never make it whole-list: declaring only
  the year-scoped `TDS (FY:25-26) A/c` under `Loans & Advances (Asset)` must
  not silently drop a `TCS A/c` the rule already finds. The all-heuristic run
  keeps its hard error; a run that took a declared ledger never raises it (a
  company that books no TCS at all must not be told to name one). `counts.
  creditLedgerSource` is `{tds, tcs}`, one `"map"`/`"heuristic"` per kind.
  JSON maps carry no `creditLedgers` (template-only, the `banks` precedent).
- `receivableLedgers` is a name heuristic (`(tds|tcs)` + `receivable` under
  an asset root) with a hard operator-facing error when it finds nothing;
  when ledger masters degrade, a voucher-entry name fallback applies. The
  planned group-override key for it is NOT built (open follow-up).
- The combination search is honesty-bounded: unique-both-ways 1:1 pairing,
  subsets sized 2..4, >1 fit ⇒ `ambiguous` stays unmatched, >40 unmatched
  per side ⇒ `combinationSearchSkipped` flag; totals never mutate.
- The written workbook de-masks cells+titles on disk only
  (`writeWorkbook` + vault); its Deductors sheet carries
  `booksTaxableValue`/`booksGrossValue`/`as26GrossValue` set in
  `analyzeAs26`, and its Mapping sheet lists matches UNION gaps so an
  empty-map report doubles as the operator's correction worksheet.
  `maskedCountAs26` counts parties under `/^(\w+) \d+$/`.
- Two traps in the 26AS books path (fixed 2026-09-23, `src/review.ts`
  `as26Review`):
  - Every rows `Map` handed to `rowsByLedger` must be keyed by
    `canonicalKey(name)`, never the raw ledger name — a real ledger's
    uppercase letters make a raw key unreachable and the whole books side
    silently reads zero (the live and TDS day-book paths already did this;
    the 26AS day-book branch did not).
  - `receivableLedgers` must be given the **group tree as well as the
    ledger pairs** (`[...masterPairs, ...groups]`): a ledger's immediate
    parent is usually a group, so a ledger-only chain never reaches an
    asset root. Only fall back to the loose voucher-name heuristic when
    masters are genuinely absent (`masterPairs.length === 0`), never merely
  because the run is a day book — otherwise GST TDS receivables (under
  `Duties & Taxes`) are misread as income-tax TDS.
- **One 26AS deductor may own several Tally ledgers** (a customer split across
  a site ledger and a head-office ledger). `matchParties` groups mappings by
  `${kind}|${nameKey}` and emits one `PartyMatch` whose `ledgerKeys`/
  `ledgerNames` (original case, mapping order) hold the whole group; the
  `ledgerName` display label is `ledgerNames.join(" + ")` and is what every
  finding and the report's Mapping sheet print. `reconcileParty` filters with
  `new Set(match.ledgerKeys)` and `analyzeAs26` looks sales up with
  `match.ledgerKeys.flatMap(...)` — any new per-party computation must
  aggregate over the whole group, never one ledger. Both loaders keep only
  `seenPair`: a repeated 26AS name is fine, a ledger mapped to SEVERAL names is
  fine (a shared-ledger group, below), and only an exact ledger+name repeat
  is refused, citing entry/row number only. `maskReconMatch` masks `ledgerNames`
  element-wise as well as `ledgerName`, so the original-case array never
  escapes through the `...m` spread.
- **Shared-ledger groups (one Tally ledger, several 26AS names, 2026-09-29):**
  `matchParties` unions the name groups that share a ledger — as connected
  components over the bipartite name↔ledger relation, **partitioned by kind**,
  so a ledger mapped to a TDS and a TCS name stays two parties (the books side
  is kind-filtered, so no double count). A component with ≥2 names carries
  `shared: true` + `members[]` (each name's own 26AS tax and ledgers); both
  fields are ABSENT for a one-to-one party, so existing maps stay byte-identical
  (emit order = `groupsByKey` insertion order, ledgers in first-appearance
  order). **`analyzeAs26` splits a group into one Deductors row per 26AS name**
    (`sharedPartyRows`, `src/as26.ts`): each member gets a plain one-name
    `PartyMatch` — its own `as26Name`/`as26NameKey`, the GROUP's `ledgerKeys` so
    the shared pool is visible, no `shared`/`members` — and
    `reconcileParty(..., { skipBooks: claimed })` runs against a pool no earlier
    member consumed, so the 26AS transaction-level pairing IS the attribution
    (first member wins, the §2026-09-30 combo-reuse discipline; `dedIdx` keeps its
    original index, which `buildBillRows` needs). `booksTax` is recomputed from
    exactly the paired/combination entries so none is counted twice, and
    `unmatchedBooks` is emptied. A member's value is the invoice its own
    transaction links to (`claimedTdsCapacity` + `linkInvoiceWithCapacity`,
    first-wins per invoice) and its `as26Gross` is its own summary rows' gross
    sum — the old "sum the members' gross" special case is now structural (a
    member row is an ordinary one-name party), which is what fixed the CMDA
    group reporting 2,61,97,200 for 8,34,44,807 of receipts. Hence no member is
    `totalsOnly`: 001/002/003/007/008 and the drill-down rows all run per name,
    and the group's `as26_totals_mismatch` wording is dead.
  - **The residue row is what the books side keeps honest.** Anything no name
    claimed (deductions, invoices, other income) becomes one extra row: party
    cell = the shared LEDGER (books-side naming), `as26Tax` 0, `as26Name` `""`
    (so `maskReconMatch` needs its blank short-circuit), its entries as
    `unmatchedBooks` on "Books not in 26AS" and its own 001 finding; no value
    basis/delta and 003 silent. Σ member rows + residue = the group's books
    total by construction, so `result.totals` never moves.
  - **Party ids: `P<n>`, `P<n>.<i>` per name, `P<n>.u` for the residue** —
    `<n>` is the group's ONE base id, not its first row's position: a split group
    consumes exactly one base id, so every other party keeps the id it had before
    the split and the sequence stays contiguous and stable between reruns
    (captain 2026-09-30; ids are cross-references on the two unmatched sheets
    and in the markdown, so one that moves when a party is reported on more rows
    breaks a reader's join). `analyzeAs26` stamps `PartyRecon.partyBase` while
    walking `partyRows` — a plain row takes the next base, a group's first row
    (`sharedRow.index === 1`) takes one and its other names plus the residue
    reuse it. One helper, `reconPartyId(reconIdx, recon)`, feeds BOTH the
    Deductors sheet (`report.ts`) and `billRows.partyId` (`review.ts`), which is
    what keeps the two unmatched sheets cross-referencing the per-name rows;
    `reconIdx` is only the fallback for a hand-built row with no `partyBase`.
    The Mapping sheet
    still emits one row per member; `as26Markdown`'s "Shared ledger …" block now
    prints one line per row plus a group total. `reconcileParty`'s own
    `match.shared` short-circuit survives ONLY as the direct-call fallback for a
    hand-built match — never reintroduce it as the engine's answer. Known limit:
    `buildBillRows` keeps the whole group pool, so a member's V row may link an
    invoice another member also linked (the "Bill value mismatch" sheet only).
- **Bill-level drill-down shipped 2026-09-24** (`src/as26-bill.ts`, pure;
  wiring/masking in `src/review.ts`; three sheets in `src/report.ts`; design
  doc §11):
  - **Section strings are normalized before `lawOf`.** TRACES writes rent as
    `194I(a)`/`194I(b)`; `normalizeAs26Section` maps those onto
    `194-I(a)`/`194-I(b)` (case/hyphen/space tolerant) at the `linkInvoice`
    lookup only. Every other string passes through unchanged, so sections
    absent from the law table (`194R`, `206CL`) honestly fall to
    `approximate`. The row always stores/emits the ORIGINAL section — never
    rewrite a displayed section.
  - **`linkBasis` is the four-step A2 scheme** `reference` → `taxable-rate`
    → `invoice-rate` → `approximate` (no sale ⇒ `none`); rate steps use
    `lawOf(section).rates.standard` (a decimal) and are date-gated. The
    `Bill value mismatch` sheet's V rows are emitted ONLY for non-approximate
    links whose delta exceeds `AS26_VALUE_TOLERANCE`; an approximate link
    never produces a V row.
  - **The day-book channel has no bill reference**: `BILLALLOCATIONS.LIST`
    NAME is empty in the reviewed company and `parseVoucherRows` drops bill
    allocations anyway, while `projectLedgerRows` hard-sets `reference: ""`.
    Only the live channel surfaces `LedgerVoucherRow.reference` (carried into
    `BooksDeduction.reference`), so linkage step 1 fires live only; steps 2–4
    carry a `dayBookPath` run. Documented gap, no code change (M-5).
  - **The three new sheets exist with ids matching the pointers**: `Books
    not in 26AS` (`B1..`), `26AS unmatched` (`D1..`), `Bill value mismatch`
    (`V1..`), each with `link basis` + `window` columns; combination-consumed
    entries are absent from the two unmatched sheets. Finding details append
    `see <sheet> rows <ids>.` AFTER masking (001/008→B, 002/005→D, 007→B+D,
    003→V) and omit the pointer when the party has no such rows.

## Sharp edges found adding totals-only 194R/bank-194A and 20% FD TDS (2026-09-26)

- Design of record is design doc §12. Party routing is **totals-only at party
  level** (a party whose every summary section is 194R, or 194A with the
  operator-marked bank): books deduction events carry no section, so a
  per-section split is impossible, and a mixed party keeps bill-level
  behaviour. Checks 001/002/007/008 and all `buildBillRows` loops skip
  `recon[i].totalsOnly` parties; 005 stays.
- `As26Map.banks` comes only from the template's new **Bank Interest** sheet
  (JSON channel never sets it); **presence on the sheet is the bank mark** —
  "is a bank" is never guessed from names. `matchParties` unions the bank's
  interest/FD ledgers into the party, so the bank pilgrims even when its
  ledgers are absent from the master list.
- The bank-194A books side is built ONLY from the operator's ledgers
  (`review.ts`): one event per voucher touching a bank ledger; the TDS credit
  counts only inside such a voucher and only on a receivable ledger. FD
  debit is carried, never compared. A marked bank with zero ledgers surfaces
  check 009 as **review** (no zero-books critical).
- is20 (`src/as26.ts`): `|tax − 0.20×interest| ≤ max(1, 0.01×interest)`; a
  20% event is excluded from the totals compare and emitted as
  `result.fd20` (raw `BankBooksEvent[]`) → the session masks party/date →
  the `FD interest 20% TDS` workbook sheet (`F20-n` rows + a totals row).
  `writeAs26Report` tolerates a `fd20` of undefined (`?? []`) because older
  test fixtures build results without it.
- Mind the datetime and ordinal precedents: `count()` in `src/format.ts`
  formats a NUMBER — `${count(arr)}` is not `${arr.length}` (regression twice
  in one afternoon); checks 009/010 extend `AS26_CHECK_ORDINAL` (frozen table
  in the design doc §6 was not renumbered — new checks are appended).

### FD auto-assignment (addendum 3/3a, 2026-09-26, `src/as26.ts`)

- The Bank Interest sheet's FD column is **optional**; FD ledgers are
  auto-detected (`isFdLedgerName`: ancestry hits canonical `deposits
  (asset)` — only when ledger masters exist, `masterPairs.length > 0` in
  `as26Review` — AND the name carries whole-token FD/F.D/F-D/FIXED+
  DEPOSIT; EMD/security/retention never). Assignment: distinctive token or
  short form of exactly ONE listed bank → name-match; else exactly one
  bank listed → only-bank; else unassigned ⇒ one review finding
  AS26-011 `fd_ledgers_unassigned` (count + credit total via `money()`,
  names only in the workbook "FD ledger auto-assign" sheet).
- Short forms = curated rows (`BANK_CURATED_SHORTFORMS`, extend by adding a
  row; canonical-key match — a branch suffix in the 26AS name breaks the
  curated hit) + derived initialisms over tokens where **trailing generic
  words after the last "of" are stripped while keeping the first tail word**
  (so "United Bank of India" keeps UBI — stripping its INDIA made the
  derived UBI a UB and mis-assigned; and a grand filter is pointless —
  initial of every word, words-but-"of", words-before-"of"). Generic words
  (`BANK_GENERIC_WORDS`) include city names; extend on misfires.
- Matching is whole-token; a run of single-letter tokens joins, so "U.B.I"
  tokenises as U/B/I and still matches UBI (initials are punctuated).
  Two-letter forms are standalone tokens only — inside words never match.
  A short form fitting 2+ listed banks matches none (unassigned).
- Everything 3a-derived is simulated in tests: no real-data run — counts/
  amounts only on live verification.

## Masking sharp edges (whole-token substitution, 2026-09-23)

- `maskKnownNames`, `demaskText` and `maskFinding`'s ledger substitution in
  `src/mask.ts` are whole-token only, never bare substring replaces. A 26AS
  schedule row label or sale voucher reference can be the bare string `"1"`,
  vaulted under the doc role as `Doc N`; a substring replace turned
  `"1,40,011.00"` into the pseudonym three times and `"01-Apr-2025"` into
  `"0Doc N-Apr-2025"` (see the regression tests in `test/mask.test.ts`).
- Boundary guards: word boundaries always; a purely numeric value
  (`/^\d+$/`) additionally requires no numeric connector (`. , / : -`)
  attached to a word character, so `1` matches neither `1,40,011.00` nor a
  date's year. Alphabetic names must still match inside hyphenated references
  (`Inv-Acme Traders-2201`) — over-tightening the guard leaks real names
  (`test/leak.test.ts` catches it).
- `maskKnownNames` matches existing vault aliases first and leaves them
  untouched, or a real value that is a token of its own alias (`1` inside
  `Doc 1`) would re-substitute to `Doc Doc 1`.

## Winman 3CD PF/ESI design (2026-09-23)

- Read `docs/design/2026-09-23-winman-3cd-pf-esi-design.md` before touching
  `src/xlsm.ts` / `src/winman3cd.ts` / `src/pf-esi*.ts` — it is the design of
  record for the Winman 3CD round-trip foundation and clause 20(b) PF/ESI.
- The xlsm package stack (`src/xlsm.ts`) is a THIRD independent zip stack: no
  shared code with `src/xlsx.ts` (writer) or `src/xlsx-read.ts` (reader).
- Winman rows 1/2/6 are hidden machine state (row 1 form id = the discriminator,
  row 2 machine keys), the first data row is row 7, and `writeSheetRows` must
  keep rows `< firstDataRow` byte-identical or Winman re-import breaks.
- `pfEsiLedgers` (config/overrides.json) reaches the review through both
  channels (session default and per-call `overridesPath`); an explicit
  per-fund empty array replaces the heuristic wholesale — only a missing key,
  `null` or bare `{}` is unset. Evidence channel: day book primary, live
  Tally fallback; contributions arrive as fund-ledger credits (negate-free:
  `findFundLedgers`/`employeeEvents` take abs). V4 (Winman import click) is
  captain-operated and recorded in the design doc §10.1.

## Winman 3CD loans 269SS/T/ST (2026-09-25)

- Clause 31 (l.269SS/l.269T) and l.269ST live in `src/loans.ts` +
  `src/loans-law.ts` (its C1–C8 confirm table is the rules of record) with the
  operator template in `src/loans-file.ts` (`tb_write_loans_template` →
  `tb_loans_review` → `tb_write_3cd_loans`).
- The Winman loans sheet names carry `&` ("Sec.269SS Loans & Deposits",
  "Sec.269T Repayments Cheque & DD") and workbook.xml stores them escaped
  (`&amp;`). `resolveSheetPart` matches DECODED attribute values, so lookups
  must pass the unescaped name — a raw-bytes comparison against the part text,
  or the escaped form, never matches. The test fixture encodes exactly this.
- Unlike PF/ESI's date+number-only sheets, the loans sheets carry text columns,
  so `write3cdLoans` resolves every vault alias back to its real value through
  the cached `lastLoansVault` snapshot (26AS-template write-side precedent; on
  the operator's disk only). The operator PAN/Aadhaar rides
  `LoansSheetRow.panAlias` RAW through the engine (both books and template
  rows); `Session.loansReview`'s `maskRow` is the SINGLE vaulting point
  (`vault.pseudonym(.., "tax_id")`) — the engine never repaints a raw value as
  a pseudonym itself.
- Journal-mode movements are never auto-breaches (C3): a loan event with no
  cash/bank counter and no operator override earns one `loans_mode_unknown`
  advisory per party and no row; narration hints (RTGS/NEFT/IMPS/UPI) or the
  Settings `Default bank mode` give a bank movement its F-token (C4, default
  ECS).
- Bank-party loans are exempt counterparties (C6): an operator-declared
  `exempt` party's buckets are excluded from rows and from the
  splitting/max-amount advisories entirely.
- MAXAMOUNT/SQUAREDUP are movement-only from a 0 opening (C7): when ledger
  masters are absent (`mastersSource: "absent"`) each moving party earns a
  `loans_max_amount_estimated` advisory and the peak is an estimate.
- Loans checks occupy ordinals 19–26 in `CHECK_ORDINAL` (`src/types.ts`);
  ordinals 15–18 belong to the concurrent clause-44 lane (captain ruling).
  Never renumber.
- Sheet5 (Sec.269T Repayments Cheque & DD) is engine-empty by construction —
  the books cannot invent a declared cheque/DD repayment — and needs a
  sheets-4-style operator declaration channel (like `Cash-breach-declared`
  feeding sheet4) before it can carry rows.
- The fill clones `write3cdPfEsi` mechanics: INTER handshake asserted, per
  sheet the formId `269SS/269T_LoansAc/RpinCash` pinned; only non-empty sheets
  are written, a sheet the workbook lacks is skipped with a stderr warning,
  and a workbook carrying none of the seven refuses. Target is
  `<stem> - filled - <YYYYMMDD>.xlsm` inside the `outPath` directory (or the
  exact `outPath` when it ends in `.xlsm`), with a `realPathId` self-overwrite
  guard. Optional cells are written only when the row carries them — a
  defined-but-empty text value (`bearer: ""`) omits the cell rather than
  writing an empty inlineStr.

## Sharp edges found adding the loans 269SS/T addenda (2026-09-26)

- **OD/OCC-ancestry ledgers are BANK for loans review** (`bank od a/c`/`bank occ a/c`
  anywhere in the ancestry chain, canonical match; `isBankOdLedger`/`isBankOdLoan`
  in `buildLoansCtx`). They are bank for mode inference and 269ST externals (so OD
  cash withdrawals/contra transfers leave sheet6), AND they are excluded from
  loanLedgerEvents entirely — OD "loans" never row on sheets 1/3 even though they
  sit under Loans (Liability).
- The clause-31 auto-exempt map: `loanAutoExemptNames` (bank-name match on an
  NBFC-guarded token list; reason order **OD/OCC ancestry > bank name match >
  secured-loan ancestry**) → check `loans_auto_exempt` ordinal **27** (19–26
  never renumbered; test/loans-tools.test.ts pins the CHECK_ORDINAL total at
  23). Operator Y/N always wins; blank ≠ exempt at parse time; review-time
  auto-exemption must be flagged with the exact detail `auto-exempt: bank name
  match` / `auto-exempt: bank OD/OCC ancestry` / `auto-exempt: secured loan`
  (Secured Loans ancestry exempting, `isSecuredLoanLedger`). Template pre-fill
  happens ONLY at generation (tb_write_loans_template). `UB` is a whole-word
  token — a bank-lender name must clear BOTH the NBFC stem guard AND a bank
  token: the guard regexes are stems (`(?:^|[^a-z0-9])Financ` with no trailing
  boundary) so they match Finance/Financial; a whole-token guard never would.
- Two identity/openings channels are additive next to `{name,parent}` in day-book
  bundles: ledgers may carry `pan`/`gstin`/`address` (PAN/gstin uppercased,
  address keep-case) and `openingBalance` — **the bundle value rides the RAW
  Tally master sign (credit positive = loan outstanding); it is NOT already
  gateway-flipped, so the bundle path sets `openings` with the raw value and
  callers must not negate it again**, while the live trial-balance path keeps
  `-row.balance` (TbRows are gateway-flipped positive=debit, one more negation
  to outstanding). Double-negating the bundle value costs exactly 2× opening in
  MAXAMOUNT (009 fix, 2026-09-26, commit 724d366).
  Precedence: template PAN/address > master PAN/GSTIN-derived > master address;
  `maskRow` stays the single vaulting point. Openings never enter the 269SS/T
  crossing test (MAXAMOUNT only). The `loans_max_amount_estimated` gate is
  per-party `openings.has(key)` when the caller passed a map, else legacy
  `mastersPresent` — don't collapse the two.
- The upstream `tally_prime_mcp_server` needed a verbose `IncomeTaxNumber` → `pan`
  field (patched + built 2026-09-26; needs a server restart); it does NOT fetch
  Tally's Address (a list field in masters). PAN/address on real data stays
  not-yet-exercised until the operator re-exports the day book with the updated
  `scripts/export-daybook.mjs` (which now runs `tally_get_ledgers` verbose:true).

## Sharp edges found implementing clause 44 (GST expenditure breakup, 2026-09-25)

- Design of record: `docs/design/2026-09-24-gst-44-clause-44-design.md`; plan at
  `/home/ram/firstmate/data/ta-3cd-gst-breakup-plan/report.md`; code
  `src/gst44*.ts`, tools `tb_write_gst44_template` / `tb_gst44_review` /
  `tb_write_3cd_gst44` / `tb_write_gst44_report`; operator walkthrough
  `docs/operator/gst-44-operator-template.md`.
- **The Winman row-2 key `REGISTEREDUNDERGST` names the *not-registered*
  column F** — the registered-entity split rides C/D/E (`TOWARDSSUPPLIES`
  exempt, `COMPOSITIONSUPPLIER`, `OTHERS`). Never map columns by key-name
  intuition; the inversion imports the form backwards.
- `writeSheetRows` drops pre-existing rows ≥ firstDataRow, and the real
  workbook pre-fills only the `Capital Expenditure`/`Revenue Expenditure`
  labels in column A (rows 8/9) — the writer must carry the
  `PARTICULARS` labels itself or the import gets two label-less rows.
- The real workbook's xf 88 (quotePrefix numFmt 1) has no style twin, so the
  first clause-44 write also rewrites `xl/styles.xml` via
  `resolveStyleTwins`' append path (PF/ESI's workbook did not); the sheet's
  column G has no row-2 key and is never written.
- Day-book `ledgers[]` carry no GSTIN, so `gst44Review` calls the narrow M2
  `ledgersTax()` channel **live even beside a day book** (approved Decision 2,
  Q3) — a standing deviation from the PF/ESI "never alongside" rule.
  With no GSTIN evidence and uncovered spend-carrying parties it throws a hard
  operator-facing error (never fabricates unregistered by default).
- Bills of mixed evidence per party are split across buckets per voucher (Q5);
  composition is reachable only through the operator template's GST Status
  sheet; a GSTIN master with no tax charged defaults to the exempt column with
  a `gst44_composition_unknown` ambiguity finding (C6).
- The report's Clause 44 sheet title also echoes
  `Total expenditure: money(sum)` — numbers only, no names — so the C5
  books-total figure is checkable on-sheet; findings ordinals are
  TB-space 15–18 (`GST44-015..018-%d` ids).
- **TOTALEXPENDITURE is the BOOKS total (captain's v1 brief, 2026-09-27)**
  on every route to the Winman sheet: `readWorksheetTotals` uses the row's
  column B/I (`amount`), and `gst44()`'s `mkRow` adds the row's unattributed
  spend to its buckets. The four split columns (C/D/E/F = G+H) are unchanged,
  so a row deliberately does NOT add across — the shortfall is column J (not
  supply / paid to govt) plus anything unattributed. The unattributed finding
  stays informational (`review`/`warning`) and must never fail or block the
  fill. Never "restore" `total = amount - notSupply` or the attributed sum.

## Sharp edges found implementing the nature-wise working sheet (2026-09-26)

- Phase B of the captain's addendum (analysis of record:
  `/home/ram/firstmate/data/ta-3cd-gst-breakup/gst-working-sheet-analysis.md`).
  Code `src/gst44-treatments.ts` (vocabulary), `src/gst44-prior.ts`
  (prior-year reader), `src/gst44-worksheet.ts` (engine),
  `src/gst44-worksheet-template.ts` (writer); tool `tb_write_gst_working_sheet`;
  findings TB-028/029/030 (ordinals 28–30 after the merge: 19–27 are the
  concurrent loans lane; TDS-table-only numbering).
- **Column B (captain 2026-09-26h): REVENUE is the ledger's net FY movement
  (debits minus credits); CAPITAL is the debit total (additions only).** The
  26e fix had made the walk debit-only throughout (`if (e.amount <= 0) continue`),
  which left a real mismatch: the REVENUE "As per books" total was
  ₹72,12,02,418.73 against Tally's purchase + direct + indirect expense total
  ₹71,46,12,343.70 — the entire ₹65,90,075.03 difference was the credit side
  (returns, discounts, credit notes) of 19 three-root ledgers that debit-only
  column B dropped. Revenue now accumulates signed entries into `amount` and
  every treatment pot, so B and the buckets tie Tally to the paisa (modulo
  Tally's own aggregate rounding). Capital still skips credits: a year-end
  depreciation credit is the annual charge, not a reversal of an addition
  (netting it produced a negative capital sheet, −₹27.8 lakh, on the first real
  run), so capital's `amount` stays a debit sum and the 26e zero-row drop still
  holds. The Phase-A analysis doc's "≈₹3.16 cr" capital figure is the abs-sum of
  both sides, not the debit total.
- The FY 25-26 day book's group parents arrive **HTML-escaped** in the raw
  export (`"&#4; Primary"` for the root-of-primaries control char); the gateway
  reader de-escapes. Any direct raw-JSON probe must account for that.
- Real-run lesson: `Bad Debts Written Off A/c` seeded Exempt through party
  evidence (registered customers, no tax) before a `bad-debts` policy rule was
  added — written-off debts are not expenditure on any supply. Party-evidence
  seeds for non-purchase ledgers deserve the same scrutiny each run.
- Prior-year `Rates and Taxes` carried not_supply (J ₹40.46 lakh), agreeing with
  the policy rule, so it raises no change finding; the only prior_year_changed
  finding on the real run is Pooja Expenses (split profile, largest column kept).
- Addendum 2026-09-26g fixes (same regen `...-20260926f.xlsx`): new
  `bill-factoring` POLICY rule (interest/discount on bill factoring or
  financing → exempt; deliberately not bare `factoring`, which would hijack a
  taxable `-18%` factoring fee); and a `0%`-name ledger keeps its no-tax
  registered part exempt (`Acc.noTaxGstin` seeds D, taxed spend stays in F via
  a mixed seed — voucher-level tax flags can mix on one ledger, e.g. a freight
  line on a taxed purchase bill). Pre-existing `Financing Charges A/c`
  no-policy test updated: 26g supersedes it.
- Addendum 2026-09-26f fixes (two halves, same regen `...-20260926e.xlsx`):
  supplier GSTINs live in Tally's `LEDGSTREGDETAILS.LIST` sub-blocks
  (APPLICABLEFROM-dated, multi-registration capable), NOT in `PartYGSTIN` —
  `FETCH` cannot see them, only `NATIVEMETHOD LEDGSTREGDETAILS` (verified TDL
  mechanics; fix lives in the sibling `tally_prime_mcp_server` as `regListGstin()`,
   latest-dated non-empty block wins).
  The gateway needed no change: `writeGstWorksheet` already gap-fills bundle
  GSTINs from live `ledgersTax`. And the engine no longer seeds exempt from
  "GSTIN + no tax lines" (blocked-credit s.17(5) tax can sit inside the asset
  cost, e.g. the Creta) — a registered supplier with no tax now seeds others
  with a move-to-exempt-only-with-evidence note (`Acc.noTaxGstin`, mirroring
  26e's `taxNoGstin`). Exempt from party evidence is therefore dead; only
  policy/evidence/prior/`0%`-pattern seeds reach column D.
- Addendum 2026-09-26e fixes (`src/gst44-worksheet.ts`, `src/gst44-treatments.ts`):
  capital drops zero-debit rows (year-end depreciation credits); a voucher that
  charged GST seeds others even when the supplier master carries no GSTIN (the
  seed reason tells the operator to verify the registration — RCM is the known
  limitation); new `credit-card` evidence rule; `insurance` (incl. the
  `insurence` misspelling) always beats `urd`, with a `gst44_ws_rule_conflict`
  warning when a later evidence rule disagrees.
- Seeded D/E/F/G/H/I/J cells: D/E/H/J are literals but F/G/I are formulas
  (I=B, G=I-H-J, F=G-E-D) with no cached values until Excel recalculates — so
  a raw read of the .xlsx sees F=blank. Diff runs via Seeded-as + H literals,
  or implied F = B-H-J-E-D.
- **Approved-sheet → Winman write (2026-09-27, Q-F flow):** `tb_write_3cd_gst44`
  takes an optional `worksheetPath`; with it, `src/gst44-worksheet-read.ts`'s
  `readWorksheetTotals` recomputes the two clause-44 rows from the working
  sheet's LITERAL cells only (B, D, E, H, J) using the sheet's own identities
  (I=B, G=I−H−J, F=G−E−D) — never reading G/F/I, which are formulas with no
  cached value until Excel recalculates. Winman mapping: TOWARDSSUPPLIES=D,
  COMPOSITIONSUPPLIER=E, OTHERS=F, REGISTEREDUNDERGST=H (the unregistered
  column), TOTALEXPENDITURE=I=B (the books total, C5); the split columns
  C+D+E+F = G+H fall short of it by J (not supply / paid to govt), which has
  no clause-44 column. Without `worksheetPath` the source
  is unchanged (cached review rows). The source .xlsm is never overwritten.

## Sharp edges found implementing No TDS Disallowance (clause 21(b))

- Read `docs/design/2026-09-24-no-tds-disallowance-design.md` before touching
  `src/notds*.ts` or the notds branches of `src/review.ts` — it is the design
  of record for the 3CD clause 21(b) fill (s.40(a)(i)/(ia)/(ib)/(iii)).
- Section spelling map: the law key `194-I(a)` reaches the Winman TDSSECTION
  cell as `194I (a)` and `194-I(b)` as `194I (b)`; every other law key is its
  own spelling; a bare `194-I` throws everywhere.
- **The agent computes no disallowance percentages** — the sheets carry payment
  facts only; Winman applies 30%/100% itself. Percentages appear only in
  masked review prose quoting the law.
- **21(b) rows ARE the review findings, not a rescan** (2026-09-26 005): rows
  project `analyzeTds`'s own `clause21b: Clause21bBookRow[]`, accumulated at
  the exact `tds_not_deducted` / staged `tds_short_deducted` / `tds_not_deposited`
  raise sites (per-booking, 194Q party-month, and timing-only per-partner-draw).
  `booksCandidates` is now a pure projector over those rows — it must never
  re-derive a liability predicate from `events`/`liabilities` again, or the
  four sheets stop reconciling to the review (the 20260926j bug: 194Q flooded
  every per-booking liability → 1924 phantom rows; 194T was one lump row
  instead of one per partner draw). Advisories (`tds_threshold_crossed`,
  `tds_late_deposit`, master-gap) carry no 40(a)(ia) amount and are rightly absent.
- A per-partner 194T expense share rides `TdsDeduction.drawGross` (set only in
  the `draws` split in `extractEvents`); the timing-only monitor's row uses it
  for `gross`. `winmanSectionKey` (`src/tds-file.ts`) already normalizes Winman
  labels to law keys, so `a.section === d.section` challan matching is correct
  — a "deposited 0" row means genuinely uncovered, not a spelling mismatch.
- **`Clause21bBookRow.gross` is the UNDEDUCTED expense, not the payment**
  (captain 2026-09-26): on a `not_deducted`/`short_deducted` row it is
  `liable tax / applicable rate` (194Q party-month: only the liable excess
  beyond the ₹50 lakh crossing), and `tdsDone`/`tdsDeposited` are **0** — no tax
  was deducted on that portion. Only a `not_deposited` row still carries the
  payment base with `tdsDone` = the deduction. The engine's clause21b push
  sites own this (src/tds.ts); `booksCandidates` stays a pure projector, so
  never re-derive an amount in `src/notds.ts`. Rate guards there must test
  `rate > 0`, never `> ZERO` — `ZERO = 0.005` is a money tolerance and the
  194Q rate is 0.001, so `> ZERO` silently falls back to the full base.
- The clause-21(b) lane reads the TDS operator template, so it must be rebased
  onto whichever main carries the TDS lane's current `Settings` schema (e.g.
  `Late Deduction Interest`, 26o 061-067). `parseOperatorTemplate` throws on an
  unknown Settings row by design — do not loosen it to unblock a stale base.
- **A no-deduction 21(b) row must show an explicit `0` in the TDS done /
  TDS deposited columns** (captain 2026-09-27; a blank cell read as "not
  reported"). `write3cdNoTds` (`src/review.ts`) therefore emits each cell
  whenever the sheet carries the column (`doneKeyOf`/`depositedKeyOf`), not
  only when the value is `> 0`; the `40(a)(iii)` sheet has neither column key
  and stays unchanged. Test: `test/notds-write.test.ts` "writes an explicit 0…".

## Sharp edges found building the tax-audit workflow (2026-09-30)

- The four `tb_audit_workflow_*` tools (`src/workflow.ts`, registry
  `src/workflow-registry.ts`, state `src/workflow-state.ts`, packaging
  `src/workflow-package.ts`; operator walkthrough
  `docs/operator/audit-workflow.md`) bundle every review lane. Handlers run
  **in-process through the handlers map** (`ctx.call`), never over the MCP
  wire; `tb_audit_workflow_run` runs **one step per call** because a step can
  take minutes and each call must fit the existing timeout chain. The
  workflow folder always stays under `cfg.reportDir`; `guardTargets` refuses
  any `outDir`/`outPath` outside it or containing a user input.
- **`<workflow dir>/latest/` is derived output**: the newest copy of every
  step's output folder (real copies, never symlinks — the captain opens them
  from Windows) plus a `README.md` naming the source pass. `rebuildLatest`
  (`src/workflow.ts`) rebuilds it when a pass closes (`writeArtifacts`, gated
  on `pass.closedAt`) and on every `tb_audit_workflow_status` call that names a
  workflow — that second path is what backfills a workflow created before the
  folder existed (one status call). Selection walks `m.passes` newest-first
  for a NON-EMPTY step folder (`stepDirName`, plus `uniquePath`'s ` (N)`
  names, preferring the folder the step's own outputs point into): an empty
  folder is a needs-input/failed step that produced nothing there, so an older
  pass keeps its files — which is the whole point of the folder. It is built
  in `latest.build/` and swapped in (old `latest.old/`), so a failed copy
  throws instead of leaving a half-empty `latest/`, and the rebuild only ever
  READS `pass-*` and operator inputs. `test/workflow-latest.test.ts` covers
  newest-pass-per-step selection, stale-file replacement, the status backfill
  and the pass-close rebuild.
- `after` in `WORKFLOW_STEPS` is **ordering only** — planning and readiness
  live in `planPass`/`stepReadiness` (`src/workflow-state.ts`); required-input
  gating, not sequence, holds a step back. The notds step refreshes the TDS
  review cache itself (fingerprint-guarded per workflow) — it never relies on
  the tds step's cache entry.
- Every string that leaves the workflow tools passes the same scrubbers as
  the rest of the gateway: `scrubReason`/`scrubbed`/`noteScrub` (`src/mask.ts`
  via the session vault). A generator's or spawn's raw error text is NOT safe
  — `test/workflow-leak.test.ts` plants a PAN-shaped error and asserts the
  intake reasons, step errors, INDEX.md and summary.json are clean. Shape
  scans over INDEX/summary must strip hex runs first: sha256 digest
  fragments match `PAN_SHAPE` case-insensitively.
- **To add a review lane to the workflow: append to `WORKFLOW_STEPS` and
  `WORKFLOW_INPUTS` (`src/workflow-registry.ts`) and extend
  `test/workflow-registry.test.ts`.** The step order is pinned by tests
  (`01-…`–`10-…` dir names); inserting a step reshuffles every later prefix,
  which old workflow folders on disk would misread.
- `tb_audit_workflow_export_daybook` (the brief's Q2) shells out to
  `scripts/export-daybook.mjs` as its own child process — never route a
  whole-FY day book through the stdio transport (the 26AS sharp edge). The
  upstream entry script is the first `.js` argument of `cfg.downstreamArgs`
  (`TALLY_MCP_ARGS`); unresolvable ⇒ the day book stays missing with a
  plain configuration message, never a throw. A **user-supplied** day-book
  path always wins; the tool's own earlier export (`source: "generated"`) is
  moved aside (`daybook.json.old`) and replaced. The export is validated
  with `readDayBook` before it is recorded `present`, and the child's stderr
  is scrubbed before it reaches the model. Tests inject `spawnDayBookExport`
  through `registerWorkflowTools`' third argument — the fake never spawns.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Sharp edges found implementing TDS (2026-09-15)

- Pending C5, `interestOn`'s round100 applies the ₹100 treatment only to
  sub-₹100 figures; exact figures (the ₹225 worked example) pass through
  untouched behind `TALLY_AGENT_TDS_ROUND100_OFF=1`.
- Plan QA: Task 2's verbatim test pinned 12 checks but Task 9 names a
  `tds_threshold_crossed` advisory; resolved as ordinal 13 — the TDS table only
  (TB/GST/LS never renumbered).
- The live Tally gateway at 127.0.0.1:9000 returned `tally_list_companies`
  timeouts on 2026-09-15's run attempt, so Task 13's live `tb_tds_review`
  validation remains open, captain-assisted; the mechanical timeout chain is
  documented in `harness/claude-code.md`.
- Task 13's live validation was completed 2026-09-15: both narrow-month and
  full-FY runs execute end-to-end with the Task 12 degradation (see §10 of
  the TDS design doc), but the company's masters carry 0 TDS flags — zero
  findings is by construction until it masters its TDS flags or the operator
  file lands (a separate captain call).

## PAN from GSTIN when the master PAN is empty (2026-09-23)

- A ledger master with no PAN but a well-formed GSTIN now yields a derived
  PAN: `panFromGstin` (`src/review.ts`) requires a 15-char GSTIN whose
  chars 3-12 match `PAN_SHAPE` (`/^[A-Z]{5}[0-9]{4}[A-Z]$/`). The derived PAN
  feeds the same paths as a master PAN — `panOf`/`panAliasOf` (vault
  pseudonym), `entityOf`'s PAN 4th character, and therefore the s.206AA
  decision. A malformed/short GSTIN yields nothing (unchanged behaviour).
- Precedence: operator-template/Winman PAN > explicit master PAN > GSTIN-
  derived. The operator/Winman override deletes the key from `panDerived`, so
  an overridden deductee never carries the derivation note. `ctx
  .panDerivedFromGstinOf` (optional on `TdsCtx`) drives the
  `" (PAN derived from GSTIN)"` detail suffix; raw PAN/GSTIN never leave the
  vault.
- The no-PAN rate is a hard 20% (`S206AA_RATE` in `src/tds.ts`), NOT
  `law.rates.noPan` — the 194Q `noPan: 0.05` entry is unused. Never wire
  `rateFor` to `law.rates.noPan` without a captain call; the design of record
  is the s.206AA floor.
- Measured on one real FY 25-26 day-book run (counts/amounts only): 206AA-note
  findings 3162 → 771, 194Q `tds_not_deducted` 2296 → 1912, `tds_master_gap`
  542 → 416, total not-deducted ₹82,09,983 → ₹15,06,375; 1873 findings now
  carry the derivation note. The drop is the expected direction (many masters
  carry a GSTIN but no PAN); the residual 206AA findings are masters with
  neither.

## Sharp edges found implementing grouped 26AS matching + addendum 5a (2026-09-26)

- **The day-book channel has no `d.reference`** — invoice ties for the
  ref-group stage (`reconcileParty`, addendum 5) must be recomputed with
  `linkInvoice` (moved into `src/as26.ts`, re-exported by `src/as26-bill.ts`;
  circular dep now flows one way). Key the groups by `normRef(link.sale.ref)`;
  approximate-basis links count (the live 194C party's whole tie is
  approximate). The workbook "linked invoice ref" column and the engine
  agree by construction.
- **Grouped fit is unique-both-ways or nothing**: exactly one group per
  target AND one target per group; more fits ⇒ `ambiguous`, item stays
  unmatched. Combined with the bounded subset search, 11+1 book-journals
  against one 26AS row is the canonical case (B1–B11/D1).
- `as26Review`'s 5th argument is the MAP PATH STRING, not a parsed map.
- **Every party label is PER SIDE (captain 2026-09-29), never a " + "-joined
  list.** A 26AS entry is named by the 26AS deductor name
  (`vault.pseudonym(_, "debtor")`); a books entry by the ONE ledger it is
  booked on (`pseudoKey` → `maskLedgerName`). Concretely: `Deductors` (the
  party-level sheet) and the party-level findings `as26_totals_mismatch`,
  `as26_tax_not_in_books`, `assessable_value_mismatch`,
  `unresolved_combination`, `late_booking` carry the 26AS name;
  `books_tax_not_in_26as`, `deduction_without_sale` and `fd_20pct_tds` carry
  the books ledger. Bill rows follow their sheet: `booksded` rows name their
  own deduction's `ledgerKey` (they are books entries), `as26`/`value` rows
  name the 26AS deductor. A Combination matches row is named by its TARGET's
  side (`c.party`, filled in `as26Review`; a books target resolves through
  `deductions[target.dedIdx].ledgerKey`). `BankBooksEvent.fdLedger` exists
  because an FD-20% row is a books entry and must name the FD ledger. A
  multi-ledger group has no single books name, so `booksLabel`/`fdLabel` fall
  back to the 26AS name. Findings that have no ledger by nature keep naming
  the 26AS party: `mapping_gap` (`g.ledger ?? g.name`), `export_inconsistent`
  (`s.name`), `live_rows_unattached`, `fd_ledgers_unassigned`.
  **The row-id pointer join therefore CANNOT compare the finding's label to
  the row's label** — a books finding is labelled with a ledger and a 26AS
  finding with the deductor, while each row carries its own side. Every row is
  registered in `byParty` under EVERY label of its party
  (`labelsOfRow` = own cell + 26AS name + each of its ledgers), so
  `byParty.get(f.party)` resolves whichever side the finding used.
- The Mapping sheet keeps BOTH names ("26AS name" + "mapped ledger"); a
  shared-ledger group is no longer ONE joined Deductors row — it is one row per
  26AS name (plus a residue row), so there is nothing to join.
- **A `P<n>` party id cross-references the two unmatched sheets (captain
  2026-09-29).** `P1`, `P2`, … counting PARTIES, not rows — `PartyRecon.partyBase`
  (the `recon` index is only the fallback for a hand-built row) — or `P<n>.<i>` /
  `P<n>.u` inside a shared-ledger group, always through
  `reconPartyId`, never a hand-built `P${i+1}`;
  `BillRow.reconIdx` carries the index out of `buildBillRows`, `as26Review`
  stamps `partyId`, and the same string sits on the Deductors row, on
  `Books not in 26AS` and on `26AS unmatched` (column B of both). It is the
  captain's answer to "are these two entries the same party?", needed because
  the two sheets name opposite sides (a ledger vs a deductor). The id is
  BLANK only for a row with no recon index (hand-built/older results) — never
  a wrong id; in practice every row is built inside a `recon` loop. The
  Deductors column insertion shifted that sheet's value columns by one: keep
  the "books interest" / "gross incl GST" placement test honest.
- Bank parties report ONE books-tax channel (the operator-mapped events),
  both in check 009 and on the Deductors sheet; value delta picks the
  closest basis (taxable / GST-inclusive / interest) and names it.
- The bounded search's skip bound is 40 unmatched items per side; the skip
  is stated in plain words on the party's findings (append after masking).

## Sharp edges found restoring the bank 194A books tax (2026-09-26)

- The bank 194A books-tax channel (`src/review.ts` bankEvents) must test the
  receivable row as a **debit** (`amount > 0`); testing it as a credit zeroed
  every real bank event and kept the 20% rule dormant on live data. Bank
  `touched` is voucher-wide (entry order varies); the receivable debit counts
  when the voucher carries a mapped interest/FD ledger OR the row's display
  counterparty is one (`counterpartyOf`). A bank's FY interest total then
  splits honestly into a regular stream plus a set of `fd_20pct_tds` events
  whose tax is exactly 20% (excluded from the totals compare).

## Sharp edges found adding the rate-exact fallback's unexplained-only pool (2026-09-26)

- The addendum-7 rate-exact fallback's pool must be the UNEXPLAINED journals
  only — no `linkInvoice` link at all (any basis, approximate included) under
  the same capacity-aware linker the sheets use — never the whole unmatched
  tail. Approximately-anchored journals already have an invoice explanation,
  however weak; letting those guesses into the pool manufactures competing
  exact subsets that bury the true one (live: four pre-invoice journals
  summing exactly to their invoice's TDS lost among anchored decoys, 8 fits,
  honest give-up). `anchorOf` (`src/as26.ts`) is computed with the same
  `linkInvoiceWithCapacity` + ledger scoping the sheets use, so engine and
  workbook agree by construction; `test/as26.test.ts` pins both directions
  (unexplained-only unique fit matches; fully-anchored pool stays unmatched).
- `linkInvoice` prefers same-ledger candidates when `ledgerKey` is present
  (deductor spanning zone ledgers); every caller that has a ledger key must
  pass it (`reconcileParty` pools, `buildBillRows`), or cross-zone deposits
  anchor to the wrong zone's invoice and the pools disagree.

## Sharp edges found routing income-counterparty TDS debits (2026-09-26, addendum 9)

- Deduction events key on the row's display counterparty, which is the
  deductor on a normal two-line TDS-vs-party voucher — but on a gross-up
  journal (Dr TDS + Dr party, Cr income) the largest opposite-sign row is the
  income ledger, so the event keys to income, gaps as unmapped, and never
  joins the deductor's totals (live: a gross-up journal crediting an exempt
  income ledger left one deductor's 26AS over its books by exactly the TDS).
  `deductorKey` /
  `rekeyDeductionsToDeductor` (`src/as26.ts`, wired in `src/review.ts`'s
  day-book branch) fall back to the voucher's party line ONLY when the
  counterparty is not a party ledger and the party line is one (under Sundry
  Debtors/Creditors — a retention-money ledger is itself Sundry Debtors, so the
  party line must never win blindly: most normal debits carry it while the
  counterparty is the true deductor). No voucher or no party-type party ⇒ key
  kept, honest gap. The live path has no voucher party and is untouched.
- `rekeyed !== deductions` aliasing: when the re-key is skipped, never
  `length = 0` + re-push the same reference — that empties the array (killed
  6 review/report tests). Guard with `if (rekeyed)` on a nullable.

## Sharp edges found on retention-release journals (2026-09-29)

- A retention-release journal is SIX lines and its internal
  `Dr Retention / Cr Warranty Liability` transfer is the largest
  opposite-signed line of the tax row, so `counterpartyOf` named the warranty
  bucket and `rekeyDeductionsToDeductor` then fell to `partyLedgerName` —
  which is the retention bucket, itself a Sundry-Debtors ledger that passes
  `isPartyLedger`. Live: one deductor's whole 45,70,053.00 read as books tax
  0.00 and was filed against an unmapped retention bucket, inflating 26AS
  over books and making a 194C shortfall appear where none exists.
- **Mirror exclusion is OPT-IN (`CounterpartyHint.skipMirroredPairs`), not a
  change to `counterpartyOf`'s default.** A line mirrored by an equal-amount,
  opposite-signed line on a DIFFERENT ledger is an internal transfer, and
  that is exactly what an asset transfer in `classifyMovements`
  (`src/dep3cd.ts`) is — making it the default would reclassify depreciation
  transfers. Only `as26Review`'s `projectLedgerRows` call opts in.
- The mapped-deductor rule fires only where the party-line fallback would
  have won, requires that party line to be unmapped, and needs EXACTLY ONE
  mapped party ledger on the voucher (`soleMappedDeductorOf`). Two ⇒ today's
  answer stands and the event surfaces as an unmapped gap. `isMappedDeductor`
  is built from `map.mappings` alone — never the Bank Interest sheet, or a
  bank interest posting would key its receipt to the bank instead of the
  party.
- **The live 26AS books side is lifted by the connector's entry composition
  (2026-09-29):** the blocker above was the missing composition, and the
  connector now attaches it — `tally_get_ledger_vouchers` takes
  `includeEntries: true` and returns per-row `entries` (full voucher
  composition, amounts already positive=debit), the voucher's real party
  (`voucherPartyLedgerName`) and a match basis. `ledgerVoucherRows`'s
  `opts.includeEntries` carries it (`LedgerVoucherRow.entries`/`voucherParty`/
  `entryMatchBasis`, `LedgerVoucherFetch.entriesAttached`) and
  `vouchersFromLedgerRows` (`src/as26.ts`) rebuilds day-book-shaped `VoucherRow`s
  keyed by voucher identity + a SORTED composition signature — two ledgers
  reporting the same voucher dedupe to one, and each report row joins exactly
  one rebuilt voucher. The live branch then projects through the SAME
  `projectLedgerRows(..., { skipMirroredPairs: true })` and
  `rekeyDeductionsToDeductor` as the day book, so the retention-release
  journal reaches its deductor live. Never reintroduce a `r.ledger` raw map key
  here: every `rowsByLedger` consumer canonicalises, and a raw key silently
  zeroes the whole books side (this exact bug shipped one broken commit).
  - **A row with no `entries` is unattached, never guessed.** `vouchersFromLedgerRows`
    returns them; all of them with no attached voucher throws
    `AS26_LIVE_ENTRIES_UNAVAILABLE`, a build that never reports the field throws
    `AS26_LIVE_ENTRIES_UNSUPPORTED` (both name `includeEntries` + `dayBookPath`),
    and a partial set raises the `AS26-012` / `live_rows_unattached` advisory
    (count, date range, receivable-side total) instead of attributing it.
  - **Whole-FY live is transport-infeasible, by design of the other lanes:**
    `tally_get_vouchers` (the sales / other-income / bank sides) cannot carry a
    year over stdio — measured 3 months OK, 4/6/12 months `MCP error -32000:
    Connection closed` (85s / 175s / 218s). A live 26AS review is therefore a
    period-length run, and a whole FY still wants the day book. The live
    Ledger-Vouchers report also DEDUPES its display rows, so a live run reads
    a little under a day-book run of the same window (one 237.00 row on
    28-Mar-2026, reported as the AS26-012 advisory) — the documented display
    dedupe, not an attribution loss.
  - The connector must be rebuilt (`npm run build` in
    `tally_prime_mcp_server`) or a stale `dist/` reads as
    `AS26_LIVE_ENTRIES_UNSUPPORTED`; that message exists for exactly that.
  - **The day-book branch ignores `fromDate`/`toDate`** (the bundle's own
    window governs, by design — the export is the reviewed period), so parity
    against a live period run needs a windowed copy of the bundle; a full-FY
    day book re-run with a 3-month window returns the full-FY numbers.
  - Parity reference: `data/ta-26as-live-entries/report.md` (Q1 FY 26 window,
    live vs day-book totals, findings, runtime). Tests:
    `test/as26-entries-rebuild.test.ts` (composition rebuild + the two
    refusals + the advisory) and `test/as26-live-guard.test.ts` (refusals,
    bundle run, other lanes still live).

## Sharp edges found implementing the 3CD TDS/TCS summary (2026-09-24)

- Design of record: docs/design/2026-09-24-tds-tcs-3cd-design.md. Read it before touching src/tds3cd.ts / src/tcs*.ts.
- The Winman TDS dropdown spells the rent sections "194I (a)"/"194I (b)" (space, no hyphen) while the law table uses
  "194-I(a)"/"194-I(b)": the only conversion is the WINMAN_TDS_SECTIONS table, never string surgery. Column K of both
  the TDS and TCS sheets is tax deducted/collected BUT NOT DEPOSITED (Winman's header), not the total.
- Quarter cells in Return details/Interest sheets take numeric literals 1-4 (dropdown INTER!$D$86 is numeric);
  the engine's "Q1".."Q4" converts only at the write3cdTdsTcs boundary.
- The operator TAN lives RAW in session memory (panOf precedent), reaches disk only inside the filled workbook,
  and must never appear in an error, preview, or tool response. Shape errors cite the Settings row, not the value.
- Interest-on-TDS quarters whose statement form is outside the sheet's five-form dropdown (24Q/26A/26Q/26QB/27Q)
  are skipped and listed in skippedInterestQuarters as "Q2:26QE" — form+quarter only.
- 206C(1H) is intentionally absent from TCS_NATURES (Finance Act 2025 removed it); the 13 Winman nature strings
  are exact-match (no trim) — a stray space breaks the dropdown on import.

## Sharp edges found in the 8-item TDS fix batch (2026-09-26)

- **Duty-line attribution (item 7):** `counterpartyOf` now returns the voucher's
  `partyLedgerName` whenever that party ledger is present among the entries and
  is not the line itself; the largest-opposite-sign rule is only the fallback.
  This is what joins `Dr Expense / Cr Party (net) / Cr TDS` deductions. The
  LIVE path cannot be fixed gateway-side: the upstream Ledger-Vouchers report
  row carries one display counterparty (`counterLedgerName`), no per-line
  entries — a false TDS-001 on live runs means the upstream must expose the
  party ledger per row.
- **The Deductor TAN is now parsed** (`WinmanFacts.tan`, item 1): it fills a
  missing operator Settings TAN, an operator value always wins, and a
  conflict raises a `tds_master_gap` diagnostic naming neither value. It lives
  in session memory like a PAN (panOf precedent) — never in an error, preview
  or tool response; it reaches disk only inside the filled workbook.
- **No-PAN master-gap is per party+section and only when TDS is due** (items
  4+5): an agg is reportable when it crossed its threshold, had a liability
  above tolerance, or its party had a joined deduction. Below-threshold
  parties are silent. Each gap's amount is that section's own gross.
- **Exposures:** s.40(a)(ia) is 30% of the EXPENDITURE (booking gross) of the
  affected bookings — `notDeductedBase`/`notDepositedBase` accumulators — not
  30% of the tax; s.271C = notDeducted + shortDeducted and now fires on a
  short-only run (no fully-missed deduction needed).
- **Deductee type is the PAN's 4th character** (P/H/C/F/A/B/T/L/J/G), incl.
  PANs derived from GSTINs; the Tally-master `tdsDeducteeType` field is no
  longer read and the "deductee type missing or Unknown" finding is gone.
  Letters a section's `pan4thChar` table does not name fall back to that
  section's standard rate inside `rateFor`.
- **Day-book bundles now carry per-ledger `pan`+`gstin`** (item 3):
  `export-daybook.mjs` runs `tally_get_ledgers` verbose; `readDayBook`
  normalizes both to null-able strings, older bundles load unchanged, and the
  bundle fills only PAN/GSTIN gaps the live masters left (live wins). Full
  PAN carry-through on a fresh export also needs the upstream's
  `tally_get_ledgers` verbose fields list to add `IncomeTaxNumber`
  (report deliverable, upstream repo) — until then the export carries the
  GSTIN and the PAN derives from it.
- Fleet findings label themselves now (item 2): statement findings say
  `statement Qn`, exposures carry a blank deductee; `maskLedgerName("")
  === ""` (blank short-circuit; never mint a pseudonym for "") and the
  statement labels are force-cleared in `tdsReview`'s classifier.

## Sharp edges found implementing the 2026-09-26c TDS addendum (joinEvents, ambiguous duty, 194-I)

- **joinEvents phase-1 must never claim across sections** (`src/tds.ts`): the by-voucher pick and the
  month-window filter both require `d.section === b.section`. A cross-section claim made BOTH bookings
  fire TDS-001 and removed the tax from the deposit chain (measured 8 vouchers on real data). When a
  duty row's section is null (ambiguous ledger), deposits join only by `e.ledger === d.ledger` — the
  `ledger` stamp on TdsDeduction/TdsDeposit is what makes that work.
- **Ambiguous duty ledgers resolve per row, never per ledger**: `dutyCandidatesOf` (optional on
  TdsCtx) supplies the ledger's candidate sections; `extractEvents` intersects same-voucher (else
  same-date, counterparty-matched) debit-expense sections with that candidate set and adopts the
  section only when exactly one remains. Evidence outside the candidates never resolves (contradictory
  evidence, never guess); unresolved rows stay skipped under the ledger-level TDS-012, and two-line
  journals with no resolving same-date bill stay unresolved by design.
- **perMonth is a whole-month rule, not excess-only**: when `threshold.perMonth` is set (194-I a/b),
  every booking of a month whose total exceeds the threshold is fully liable (month-scoped sibling of
  wholeYearOnCross); `agg.crossed` fires at the first booking of the earliest over-threshold month.
  Aggregate-only sections are untouched.
- **Null-section deposits belong to no Winman section**: `tds3cd.ts`'s deposit loop skips
  `dep.section === null`; never widen that to "resolve by ledger".

## Sharp edges found implementing the 2026-09-26i TDS addendum (subsequent-year challan coverage)

- **Winman challan coverage is deductee-level, never section+month** (`src/tds.ts`
  `SubsequentDeposit`, `src/tds-file.ts` `WinmanAllocation`, `src/review.ts` winmanName
  join): a post-FY challan covers a book deduction only on same party (template Winman
  Deductee Name, exact trimmed match — §8.4 precedent, never fuzzy) + same section +
  same deduction month + tax within `TDS_TOLERANCE`, only when the books carry no 1:1
  deposit for it, only when the challan date is after the FY end and on/before the
  `s139DueDate` audit-case date (`src/tds-law.ts`), each allocation consumed once. Live
  proof: the template mapped the rent ledger to a 194T-only Winman name while the
  return's 19,000+6,600 pattern sat under a different deductee — the four Feb/Mar rows
  correctly stayed `tds_not_deposited`. A wrong declaration fails closed; never
  "fix" it with fuzzy matching — the operator corrects the name.
- **Challan matching runs before the month pool and skips it** (`analyzeTds`): a
  challan-covered deduction never consumes pool FIFO and never fires `tds_not_deposited`
  (so no s.40(a)(ia) base); lateness interest (ii) still runs deduction→challan date as
  `tds_late_deposit`, and `tds3cd.ts` excludes the covered credit from notDeposited
  (the 21(b) writer needs the same exclusion — applied worktree-local in the wt-e
  merge for the e-workbook; the sibling branch owns that file).
- **The month pool never contains a 1:1-joined debit** (fixed with 26i): the pool
  double-spent it — once through the join, once as pool — so a February book deposit
  silently covered March's need. `test/tds-subsequent.test.ts` guards the 26i paths;
  the wt-e merged-tree port procedure (copy wt-notds, port hunks, rebuild, run
  notds-write-e.mjs) is session scaffolding, not repo process.

## Sharp edges found implementing the 2026-09-26k TDS addendum (perMonth year guard, 194Q month matching)

- **The 194-I perMonth proxy is gated on the year cap** (`stampLiabilities`, src/tds.ts): the FA 2025 proviso
  tests ₹50,000 per month or part of a month, but the books' voucher month is only a proxy (one voucher can
  book several months' rent as one lump — the TDS-013-75 false positive). Months partition the year, so
  "some month > 50k" ⇔ "year > 50k × 12"; the proxy now counts only when the year gross exceeds
  `perMonth * 12`. Accepted residual: a genuine single >50k month in a ≤6L year stays silent (captain's
  word, 2026-09-26). The old per-booking fixtures pin the guard — scale synthetic 194-I runs past the 6L cap.
- **194Q findings match at party-month level** (pass 2): the month's resolved duty credits
  (`monthCredit`) are matched against the month's whole liability — zero credits raise ONE
  `tds_not_deducted` per party-month, partial credits raise ONE `tds_short_deducted` for the shortfall;
  the per-booking not/short raise is skipped for 194Q only. The ₹50 lakh FY crossing and the C8
  excess-only base are untouched, and the 1:1 join still drives late-deduction/deposit chains for the
  joined row. Month-level details carry the same panNote (206AA / PAN-derived) suffix — tests assert it.
- **Run-to-run comparisons must pin the operator file version**: the 20260926f run predates the
  template dedup (its backup `tds-operator-filled-rvs-25-26-dedup-backup-20260926f.xlsx` has 0 statement
  rows vs 4 now), so statement_missing 3→0 and some deposit-chain reshuffles between f and g are operator
  data changes, not engine changes. Winman allocations under an undeclared deductee name are dropped by
  the 26i join in every run — a corrected threshold just changes which bookings surface them, turning
  late_deposit wording into honest `tds_not_deposited` (fail-closed).

## Sharp edges found in the 2026-09-26o TDS batch (same-PAN, debit notes, 194T)

- **A deductee is keyed by PAN when known, else its canonical ledger name** (`deducteeKeyOf`, src/tds.ts).
  It is used in aggregate keys, `monthLiability`, `monthCredit`, `joinEvents` and the subsequent-year
  challan match. Two Tally ledgers of one PAN are one deductee for every per-party figure; never fall back
  to the raw ledger name in a new per-deductee computation.
- **`netDebitNotes` nets an expense-ledger credit from a TDS party against that deductee+section's
  bookings, LIFO (most recent open bill first)**, and drops a fully-netted booking. The grain is
  **deductee + section, not ledger**: a materials debit note on one material ledger must cancel a bill on
  another material ledger of the same party (verified on a real materials party). Expense credits count in
  any voucher type, including `Debit Note`. An advance credit (note before any bill) carries forward.
- **`counterpartyOf`'s duty-line rule (src/tds-daybook.ts)**: with an empty `partyLedgerName`, a
  duty-ledger line's counterparty is the voucher's known party line (largest-magnitude party entry,
  same-sign first) — not merely the largest-opposite-sign expense line. This is what recognises
  `Dr Interest / Cr Party (net) / Cr TDS on Interest - 194A` journals. The hint is supplied by `review.ts`
  from the duty/party key sets; without it the old fallback stands.
- **A deductee's total short-deducted tax for the FY below ₹100 is not reported**
  (`SHORT_DEDUCTION_MIN`, src/tds.ts), measured per deductee across all rows/sections, not per row. The
  suppressed amount also leaves the s.271C base.
- **194T is timing-only** (`timingOnlySection`, src/tds-law.ts): no not-deducted / short / threshold /
  no-PAN finding ever fires for it; deposit lateness and not-deposited still do. A 194T booking may be
  formed even when its counterparty is **not** in `ctx.tdsParties` — partner remuneration credits the
  partners' Capital/Current accounts, so the operator's 194T expense mapping (not a declared party) is the
  liability signal. Because the 1:1 partner join often cannot fire (lump journals give each partner a
  different counterparty), a section-level monitor raises `tds_not_deposited` for the un-covered credit
  and feeds the section's whole booking gross into `notDepositedBase` once — the s.40(a)(ia) exposure is a
  bounded estimate, never per-partner. The 21(b) clause-34 row aggregates 194T by section.
- **A lump duty credit splits per partner draw** (2026-09-26o item 038/039): a 194T voucher credits the
  duty ledger once and debits EACH partner current account (`Dr A 15L / Dr B 15L / Cr Duty 30L`). The
  day-book projection stamps the credit row's `draws` (`LedgerVoucherRow.draws`, src/downstream.ts /
  src/tds-daybook.ts `projectLedgerRows`) and `extractEvents` emits one deduction per draw (proportional,
  last draw takes the round2 remainder). Deposit coverage for a timing-only section then matches by
  **section + deduction month + tax alone** (`loose = timingOnlySection(d.section)` in the subsequent-challan
  loop), because the partner Capital Accounts are not operator Parties / Winman names — an allocation whose
  Winman name no template party declares is carried into `ctx.subsequentDeposits` with `party` = the raw
  Winman name rather than dropped (src/review.ts). The live Ledger-Vouchers path has no voucher composition
  and keeps the single-counterparty behaviour. The section's s.40(a)(ia) base is proportional to the tax
  actually NOT deposited (`section gross × undeposited tax / the section's total tax`, 2026-09-26o item 041):
  a challan that did cover its share removes that share of the base — never the whole section gross. The same
  proportional rule applies per booking (`b.gross × ded.tax / liability`) for non-timing sections, so a split
  draw that carries only part of a booking's tax disallows only that share.
- **Duty and expense classification is the operator's `Ledger Kind`** (`kind?: "expense" | "duty"`,
  omitted = expense; src/tds-file.ts, src/review.ts `expenseLedgerNames`). A hand-built test operator that
  omits `kind` on a duty row makes that ledger expense too, so its duty credit is read as a reduction of
  the same deductee+section — always set `kind: "duty"` on duty rows in fixtures.
- **A subsequent-year challan's own Interest column is the interest actually paid** (2026-09-26p):
  `WinmanAllocation.interestPaid`/`challanId` come from the Challan sheet's `Interest` column joined by
  `(ID No., Quarter)`; `SubsequentDeposit.interestPaid`/`challanId` carry them to the engine. A timing-only
  credit covered by such a challan now raises `tds_late_deposit` with s.201(1A)(ii) interest
  (`1.5% × calendarMonths(deduction, deposit)`, stamped on `ded.interestII`) — but **only for an orphan
  credit** (`if (d.booking) continue`, src/tds.ts): a booked credit's lateness is already raised by the
  per-booking `ded.subsequentDeposit` branch, so reporting it here too would double-count. The clause-34
  `Interest on TDS` row's `paid`/`paidOn` are taken from those challan stamps, **deduped by
  `subsequentChallanId`** (one challan covering several deductions of a section — the two 194T partners —
  has its single interest counted once; `section|depositDate` is only the fallback key).

## Sharp edges found fixing the 194-I annual limit (2026-09-30)

- **194-I's ₹6,00,000 limit is a CUMULATIVE test, not a whole-year switch**
  (`TdsLawEntry.cumulativeOnCross`, `src/tds-law.ts`; `stampLiabilities`, `src/tds.ts`). The old
  `wholeYearOnCross` flag set `liableBase = b.gross` for *every* booking once the year ever crossed, so a
  party whose first bills sat inside the limit was reported not-deducted on them. Now the crossing
  **booking index** (`crossIdx`, -1 = never crosses) decides: pre-crossing bookings get `liableBase 0`,
  the crossing booking gets the whole running `cumulative`, later bookings their own gross. The
  `crossIdx < 0` guard is load-bearing — without it `i > crossIdx` is true for every booking and a
  never-crossing party becomes fully liable. The **index** is required, not `agg.crossDate`: several
  bookings can share the crossing date and only the later one carries the crossing. 194-C keeps plain
  `wholeYearOnCross` (its 1,00,000 aggregate really does make the whole year's bills liable), and the
  year-total tax (`totals.bySection`) is unchanged — only the *rows* moved.
- **A not-deducted row on the crossing booking quotes the cumulative, and its clause-21(b) `gross` is
  the liable base, not `b.gross`** (the 194Q `liability / rate` precedent). Detail reads "…payable on the
  6,89,000.00 booked to this date, including the earlier bookings within the annual limit, but no duty
  credit was found."
- **The crossing booking owes the cumulative LESS the tax the books already deducted on that
  party's earlier bookings of the year** (firstmate inbox 010, 2026-09-30; pass 2 of
  `analyzeTds`). `preCrossTax` = `round2(Σ taxPaidOn over bookings.slice(0, crossIdx))`, where
  `taxPaidOn` is the share tax when the credit is a consolidation share and `ded.tax`
  otherwise; at `i === crossIdx` the liability becomes `round2(Math.max(0, base - preCrossTax))`.
  Pass 2 computes its **own** `crossIdx` (the `before` loop that used to sit there was DEAD —
  its `!agg.crossed` guard can never fire once pass 1 set the field — and `before` was unused),
  which is what keeps the index aligned with the walk below it. Measured: the 194-I(b) rent
  party deducts 10% on all eleven bills; the old code charged its 05-Feb crossing Rs 66,000
  against a single Rs 6,000 credit and invented a Rs 60,000 short-deducted. Netting the ten
  earlier Rs 6,000 credits leaves Rs 6,000 payable, which the 05-Feb credit covers exactly.
  The same netting corrected the 194-I(a) crossing finding from Rs 13,780 to Rs 800 (its
  Rs 12,980 credit is booked against a pre-crossing bill) and made that party exact —
  Rs 44,660 due − Rs 43,560 credited = Rs 1,100 = its two reported findings.
- **A silent booking (zero liability) that carries a joined credit still runs the
  credit-keyed checks** (firstmate 2026-09-30). The walk head is now
  `const found = deductionOf(b); const base = round2((b.rateApplied ?? 0) * (b.liable ?? 0));
  if (base <= TDS_TOLERANCE && !found) continue; const silent = base <= TDS_TOLERANCE;` — the
  194C(6) transporter branch and the `liabilities.push` row are gated on `!silent`, while
  late-deduction, Rule 30 late-deposit, deposit-mismatch and not-deposited all still run on
  the credit. A deduction is a fact about the books, not about whether the bill it pays was
  chargeable. This restored four late-deposit and five late-deduction findings that the
  silence fix had dropped, and it is why the warning count rises while the critical count
  falls. `deductionOf`/`taxPaidOn` exist so the netting can read credits of bookings the walk
  skips.
- **An amount match must be settled before the date walk** (`pairExactAmounts`, `src/tds.ts`, run from
  `joinEvents` before the by-voucher/nearest-date pass; it returns immediately when `stamped` is off).
  The 2026-09-26g tiebreak only looked at the *current* booking's candidates, so an earlier booking could
  take by date a credit that was the later booking's exact liability — the 20-Aug 194-C crossing bill
  claimed a 1,967 credit owed to the 30-Aug bill. Pairs are claimed strongest-match-first: same-voucher
  pairs, then smallest `|tax − liability|` (so an approximate match can never steal an exact one's
  credit), then dates; each booking and each credit once. Blast radius is real — it also *reveals* a
  previously hidden 194-Q late-deposit.
- **An operator/Winman PAN must reach `panOf`, not just `panAliasOf`** (`src/review.ts` §8.4). `rateFor`
  reads `panOf` (via `entityOf`), so a PAN adopted from the Winman return through the template's
  `winmanName` was invisible to the rate table and a 194-C *individual* paid the 2% standard. The
  precedence is deliberate: the adopted PAN fills a **gap** — it sets `panOf` only when the key is
  absent or was GSTIN-derived, never over a real master PAN (the client's own master data keeps the
  rate, and a GSTIN-derived PAN is exactly what the operator declaration supersedes). `panDerived` is
  deleted in both branches, so the "(PAN derived from GSTIN)" note disappears.
- **`cumulativeOnCross` is SECTION-NEUTRAL (captain 2026-09-30, second half).** The annual-cumulative
  reading is the rule for EVERY section whose threshold is an annual aggregate — the flag now sits on
  **194C, 194-I(a), 194-I(b), 194J, 194A and 194H**; 194Q keeps its own "only the amount beyond the
  crossing" rule (`max(0, min(gross, cumulative - aggregate))`) and 194T stays timing-only. A per-bill
  `single` limit is tested INDEPENDENTLY and still makes one large booking liable whatever the
  aggregate has done (194C's ₹30,000 — a ₹41,000 April bill against a non-crossing aggregate is still
  reported at 2%). On the reviewed company 194-C went 31 → 13 not-deducted findings with the total
  RISING (₹9,779.07 → ₹11,787.46) and 194-J 7 → 5, because a crossing row now carries the year to
  date; 194A/194H raise nothing on that book, which is an honest "nothing to report", not a no-op bug.
- **The netting must be applied BEFORE the silence test** (`src/tds.ts` pass 2). `liability` is
  `i === crossIdx ? max(0, base - preCrossTax) : base`, and only THEN is `silent = liability <=
  TDS_TOLERANCE` tested — netting after the gate raises a **zero-amount `tds_not_deducted`** on a
  crossing bill whose cumulative is fully covered by earlier voluntary deductions.
- **`depositDue`'s December special case read the year backwards** (`src/tds-law.ts`). It passed
  month **1** *with* the `monthOverflow` (`mkDate(y, 1, 7, 1)`), and `mkDate` does the rolling itself,
  so a December deduction came out due **07-February of the same year** — ten months in the past. Every
  December deduction then read as a late deposit: 28 false `tds_late_deposit` rows (₹8,11,543.00) on
  06-Jan-2026 deposits that were a day EARLY. `mkDate(y, m, 7, 1)` already rolls the year, so the fix
  is to DELETE the special case; March's `${y}0430` stands. `depositDue` is the single due-date source
  (`src/tds.ts` + `src/tds3cd.ts`), so one change covers late-deposit, not-deposited and 3CD interest.
- **An over-deduction is a BANK, not a second liability** (captain 2026-09-30, third point;
  `excessBank` in pass 2 of `analyzeTds`, `src/tds.ts`). A bill's credit **above that bill's
  own liability** is not that bill's business — it is a credit against a later bill of the
  same party, section and year, and the engine now banks it and spends it oldest-first
  (`fromBank = Math.min(excessBank, base)` before the silence test, `excessBank +=
  max(0, dedTax - liability)` after). The `crossIdx`/crossing netting it replaced was the
  one-booking special case of exactly this; **never reinstate a per-crossing net** — the bank
  covers it and the two would double-count. The captain's measured case: 194-C, 55,764 booked
  15-Oct with 4,354 deducted 16-Oct (the whole year's 2% in advance), 1,61,917.20 booked
  26-Dec with no credit, year 2,17,681.20 → 4,353.62. v7 reported 3,238.34, v8 reported
  nothing, v9 reports **1,114.90** (4,353.62 less the 3,238.72 of the advance that belongs to
  December rather than to October). 194-I(a) is untouched by the bank — the SRP party still
  reconciles exactly at 44,660 − 43,560 = **1,100** — because its 12,980 already sat on a
  pre-crossing bill whose own liability was 0.
- **`tds_late_deducted` interest is charged on the amount DUE, not on the credit**
  (`dueAtDate = Math.min(dedTax, liability)`, `src/tds.ts` pass 2). The same captain's case:
  4,354 paid 16-Oct against a 15-Oct bill owing 1,115.28 — run 8 charged interest (i) on
  4,354, run 9 on **1,115.28** (Rs 11.15 for one month). An advance payment is not "paid
  late", and the tax it over-paid belongs to a later booking, which is charged interest from
  that booking's own due date. `dueAtDate <= TDS_TOLERANCE` also silences the row entirely
  when nothing was due by the deductible date (a booking inside an annual limit, or one the
  bank already covered): that is what removed 10 of the 24 194-Q lateness rows, and the 194-Q
  and 194-C credit-based `shareOn` interest paths must be checked the same way if they are
  ever extended to an excess.
- **The crossing booking must not re-charge what an earlier bill already owed**
  (`chargedSoFar`, pass 2 of `analyzeTds`; firstmate 2026-09-30). The cumulative-limit path charged the
  crossing the FULL year-to-date tax, which includes the liability an earlier booking was charged on its
  own account — under s.194C(5) a single bill over Rs 30,000 is chargeable whatever the aggregate does.
  The captain's case: a 15-Oct bill of 55,764 charged 1,115.28 on its own account, and the 26-Dec crossing
  then charged the whole 4,353.62 that includes it, so run 9 reported 1,114.90 on a party that paid
  everything. **`b.liable` at the crossing is the cumulative GROSS** — net `rate × b.liable`, never
  `b.liable` directly, or you subtract tax from gross and 20 tests fail. The invariant this restores,
  worth pinning per party/section/year: statutory tax charged across a party's bookings equals the tax on
  the year's liable base exactly, and reported not/short-deducted equals `max(0, due − deducted)`.
- **The three reconciliation gaps a 375-party sweep found are CLOSED (run 11, 2026-09-30, inbox
  016)** — see the "backward settlement" and "voucher identity" bullets below. The sweep
  instrument still is: patch `dist/tds.js` with a
  `process.env.TDS_RECON` block immediately before its `    return {` at the END of `analyzeTds`
  (where `aggs`, `liabilities`, `events.deductions` and the pushed `findings` are in scope), then
  restore `dist/` with `npm run build`.
  Read the identity against the **PRE-POOL** due side, and section by section: for every
  per-booking section `due = Σ` the walk's `base` (the statutory charge it stamps in the plan
  phase, before any credit is applied), for 194Q `due = Σ liabilities[].liability` (that
  section is reported party-month, so each month has its own row and a base sum is unusable
  there). `Σ liabilities[].liability` is POST-pool and is **not** the due side for the rest:
  a bill an advance settled drops out of it while the advance is still counted on the credit
  side, so the identity reads the credits too rich by exactly the advance. That single
  mistake invented a phantom ₹364.79 residual on a 194-C party and a phantom ₹1,114.90 on
  another (inbox 021). Dump `base` by splicing the plan-push line
  (`plan.push({ b, base,` → inject a `globalThis.__reconBases` collector keyed
  `section~party~date~gross`) — **the injected JS must use single quotes**; a double quote
  inside the double-quoted replacement string silently corrupts `dist/tds.js`
  (`node --check` it). `.scratch/recon-v12.json` is the current dump, `recon-check2.mjs`
  takes the dump path as argv. On the real book this leaves 13 of 375 aggs out by >₹1 and
  **not one of them is a defect**: 2 × 194T (timing-only, never reports), 9 under
  `SHORT_DEDUCTION_MIN` (each a whole-party shortfall), and two rupee-rounding rows
  (₹1.21 and ₹1.31, each six challans rounded to the rupee). The 194-C party of inbox 019/021
  ties: due 6,444.81 (= 1% of its 6,44,481 of charges) − credits 6,281 = 163.81 against the
  reported 162.50.
- **The carry-forward is BIDIRECTIONAL within the year (run 11, hardened run 12).** The bank is a
  LIST of unspent credit (`pool: {ded; date; remaining}[]` in pass 2's plan phase, which replaced
  v10's `excessBank` scalar), not a running figure in date order. After the forward pass it is
  offered again to EARLIER unpaid bookings of the deductee+section+FY, oldest open first,
  and a booking settled that way is reported as `tds_late_deducted` (interest (i) from its own
  deductible date to the credit date), never as not-deducted. Invariants, all load-bearing:
  (a) a booking may never take back a rupee its OWN credit banked (`if (row.ownTax >= row.base)
  continue` in the forward pass — without it the captain's inbox-014 case reports 1,114.90 on a
  party that paid everything); (b) a credit dated BEFORE a booking is an advance, never a late
  deduction (`e.date >= row.b.date` in the backward pass); (c) **the forward pass carries its own
  date filter `if (e.date > row.b.date) continue` — a credit dated after a booking is the backward
  pass's business alone.** Without (c) the captain's own case reports nothing at all: the
  01-Jan-2026 payment would discharge the November bills in the forward pass, with no finding and
  no interest. And **the backward cover must NOT be folded into the forward pass's `want`**:
  keep a separate `fromBank` accumulator and do `row.liability -= fromBank` only, or the forward
  pass takes a second bite of the same credit for a booking already settled backwards (run 12 lost
  ₹202.29 of false short-deduction and ₹0.50 of interest to that). The late-deduction `covers` loop
  likewise measures covers against `liability + Σ backs` — the PRE-pool amount — since a booking
  settled entirely backwards has a zero liability and would otherwise raise no row at all.
  194Q settles at MONTH grain the same way (`QSlot`/`qpool` in the 194Q block): a month's excess
  settles the oldest earlier uncovered month, never a same-or-earlier one. A back-settled booking
  is barred from the whole deposit chain (`if (!ded) continue`) — the credit's deposit facts and
  its 40(a)(ia) base are already reported on its own primary booking, and re-running them would
  double-count.
- **A backward settlement's interest reaches the 3CD interest sheets (run 12;
  `TdsDeduction.backInterestI`).** The sheets sum interest stamped on each DEDUCTION, and a
  backward settlement is not a deduction — it is what one deduction did to another booking's bill,
  so run 11 could report the interest in the findings while the workbook showed none. A separate
  additive field now carries exactly that interest (the per-booking `else cover.ded.backInterestI
  = round2((… ?? 0) + interest)`, and the 194Q block's stamp moved OFF `interestI` onto it, so one
  carrier owns all backward interest and nothing counts twice). `tds3cd.ts`'s `interestTdsRows`
  adds every `backInterestI` to its own quarter of the financial year — the quarter of the CREDIT's
  date via `quarterOfDate` (FY-based: a January deduction is Q4, not Q1) — gated on
  `operator.lateDeductionInterest`, and the gate is applied to the whole loop so the component
  vanishes with the setting. It is added in BOTH the books and the Winman bases and **merged into
  neither**: on the Winman basis the return's own late-payment computation already charges the
  payment's own interest (i) on the same deduction, so adding that again would double count, and
  only the backward charge (bills the return never saw) is added. Narayanan: interest payable
  38,651.00 → **38,705.00** (+54.00), all in the Q4 row.
  Under `Late Deduction Interest = N` the 194Q month-pool pass drops the `tds_late_deducted` ROW
  itself, exactly as the per-booking `covers` loop does (2026-10-08): only the `push` is guarded —
  the credit still settles the month's pool, so not-deducted/short figures and every s.40(a)(ia)
  exposure stay put and interest totals stay 0.
- **A voucher NUMBER is not a voucher identity (run 11; `sameVoucher` in `src/tds.ts`).** Tally
  numbers each voucher type in its own series, so "P/12" is a purchase bill of the year and also
  a journal of the year. A credit joins a booking as sitting on the booking's own voucher only
  when number AND date agree; it is used in `pairExactAmounts`'s `voucher` preference AND in
  `joinEvents`' `byVoucherCands`. This closed the deferred ₹462 194Q collision and the
  1,211.70 mis-pair, and it cost the suite ~20 fixtures that paired a credit weeks or months
  from its bill on the number alone — **the fixtures were rewritten (each credit now carries
  its own Journal/Payment voucher number inside the 30-day window), never the rule weakened.**
  Do not reintroduce a date-free voucher join, and do not "fix" a failing fixture by relaxing it.
- **Compare two day-book exports by voucher COMPOSITION, never by `date|type|number`**
  (run 14). Asking "what did the operator change in the books?" against a fresh export
  showed 289 differing `date|type|number` keys of which exactly 9 were real edits: the rest
  is Tally renumbering after the corrections, which is exactly the trap the bullet above
  records inside the engine. Key each voucher by its sorted entry signature
  (`ledger|amount` multiset) and the real changes fall out in one pass — that is how run 14
  found the two re-ledgerings (`Repairs - Machinery - Service - URD` → `Spares - URD` on
  JAYARAJ's 31,643 bill, and five VRV bills from `Professional Fees - 18%` to
  `Labour Charges Payable-18%`) and dismissed a 1.4-crore GST receivable reclass as
  out of scope. **The instrument is `.scratch/diff-exports.mjs <old> <new>`** (run 15): it
  keys each voucher by its sorted `ledger|amount` multiset and diffs the multiset OF
  SIGNATURES WITH COUNTS, never a per-voucher key — vouchers sharing a composition are
  interchangeable, and a `date|type|number` diff of the same two exports reported 995
  phantom edits. Two consecutive fresh exports (v14 → v15, 11,466 vouchers, 7,295 distinct
  compositions each) differ by exactly ONE composition gone and ONE new — the same ₹1,010
  read `Labour Contract Expenses A/c|1010.00 ;; MURUGAN SILT CATCHPIT A/c|-1010.00`
  (a `Journal`) and now reads `Cash|1010.00 ;; MURUGAN SILT CATCHPIT A/c|-1010.00`
  (a `Cash` receipt) — so a real books edit shows up as a PAIR of signatures, and a real
  re-ledgering shows up as one gone plus one new on the SAME amount.
- **An operator remap changes the LIMIT STRUCTURE, not just the section name (run 14).**
  `Repairs - Machinery - Service - 18% A/c` moving 194J → 194C took one party from
  ₹13,863 of not-deducted to ₹1,386.30 and produced a NEW ₹465.22 finding for another,
  because 194J charges 10% on every bill over ₹30,000 while 194C charges 1–2% above a
  ₹1,00,000 ANNUAL aggregate (`cumulativeOnCross`) — the same payments largely fall inside
  the limit. Never read a remap as "the same liability under a new heading", and **check the
  rate the new finding lands on against the sub-clause** (that ₹465.22 is 1%, i.e. 194C's
  works-contractor/transporter rate, where a technical contract would be 2%).
- **A journal whose signs are inverted against every other journal in its party IS a debit
  note; that is a book fact, not an engine defect (run 14).** MURUGAN SILT CATCHPIT's
  01-Apr-2025 journal of ₹1,010 debits the party and credits the expense ledger, so
  `netDebitNotes` LIFOs it against the most recent open bill (1,75,253 → 1,74,243) and the
  finding becomes a ₹346.43 short-deduction on the next bill, funded by the first bill's
  ₹10.57 of over-credit. The smallest counterfactual (negate those two amounts, change
  nothing else) moves it to ₹357.00 not-deducted — ₹10.57, not the ₹20 an operator reading
  the same voucher expects, because the April charge's own tax is exactly offset by the
  reduction it had been granting. When a captain says a finding is "understated by Rs N",
  build that counterfactual before touching the engine; here it proved the reported figure
  right and the books wrong.
- **The amount tie-break must compare what the booking is CHARGED, not its gross statutory
  liability** (`TdsBooking.chargeNet`, stamped in `stampLiabilities`, read by `pairExactAmounts`;
  run 11). `pairExactAmounts` asked whether a credit equalled `rate × b.liable` while the walk
  charges a crossing booking net of `chargedSoFar`, so an operator's netting-derived credit
  matched nothing and fell to the first bill the date order reached. The netting applies
  **ONLY at `crossIdx`** — applying it to every booking breaks 11 tests (194-C's 30,000
  single-limit bill must keep its full liability; two same-day 194-I bills must pair
  19,000→950,000 and 6,600→330,000). `stampLiabilities` runs before `joinEvents`, so the
  field is always available.

- One real-data caution, recorded not fixed: a booking that owes **no** tax can still take a
  duty credit the walk has nothing better to do with (the walk has no zero-liability guard —
  tried, reverted, it broke a deposit test), so where a silent bill absorbs a credit that
  belonged to a later bill, that later bill can still report a shortfall the books have in
  fact paid. Conservative, never an under-report. Separately, a `tds_threshold_crossed`
  advisory does not name the sibling Tally ledgers of one
  PAN it aggregates, so a party split over two Tally ledgers sees one ledger's name against a total it
  cannot reproduce (correct figure, incomplete disclosure — captain withdrew a disclosure fix for it on
  2026-09-30 because two ledgers of one PAN are one deductee under 194Q).

## Sharp edges found adding the TDS payable statement (2026-10-01)

- Design of record `docs/design/2026-10-01-tds-payable-statement-design.md`;
  operator walkthrough `docs/operator/tds-payable-statement.md`. Code
  `src/tds-payable.ts` (pure projection + pricing), `src/tds-payable-template.ts`
  (both workbooks + the run digest), `src/tds-payable-file.ts` (strict parse),
  the session methods in `src/review.ts`, the two tools in `src/index.ts`, and
  the appended `payable` workflow step.
- **The payable lane reads the TDS session's PRIVATE facts, never a report
  JSON.** `tdsPayableCandidates()` needs the cached books (clause 21(b) rows
  with their `deductionDate`, PANs/GSTINs), which a saved review result does
  not carry; a run that reloads a v-N JSON must re-run `tb_tds_review` (or feed
  `dayBookPath`). `deductionDate` was added to `Clause21bBookRow` and the staged
  short row as an OPTIONAL field and set at the push sites only — nothing in the
  review's own computation may read it, or a payable re-run would move the
  findings.
- **A decisions workbook is bound to its run by a digest of the sorted CRITICAL
  ids, not by row position** — ids are assigned per run, so a workbook from
  another run (even the same company) is refused. The digest is compared and
  never printed (six hex digits trip `scrubDigits`). Bind any operator
  instruction by (finding id, check, party, date) as the as26 lanes do.
- **s.201(1A) leg (ii) runs from the DEDUCTION date to the payment date**; the
  Rule 30 due date (`depositDue`) only decides whether the leg is charged
  (`tds.ts` pushes and `tds3cd.ts:287` measure it the same way). A leg measured
  from the due date forgives every month the tax was held before it fell due.
  Leg (i) is 1% from the booking to the payment date for a shortfall that was
  never deducted (deemed deducted when the challan is paid), so its leg (ii) is
  zero by construction. `interestOn`/`calendarMonths`/`depositDue` are reused
  from `src/tds-law.ts` — never a second interest formula here.
- **A blank or deleted Decision is `undecided`, never "not a finding"**: the
  statement refuses while any critical row is open, naming it. The rate is read
  from `panOf(party)` (already GSTIN-derivable) and a party with no PAN at all
  takes the s.206AA `S206AA_RATE` floor as its rate with the label
  `Not determinable (no PAN)`; PANs appear ONLY inside the statement workbook —
  the decisions workbook and every outbound string are PAN-free.
- The workflow step is APPENDED after `loans` (`test/workflow-registry.test.ts`
  pins the order); the tool surface is now 46 tools, pinned by
  `test/server-tools.test.ts` and `test/leak.test.ts` — a new tool fails both.
- **The payable statement must be priced off a review taken with the SAME
  evidence channel as the run the operator finalised** (firstmate review,
  2026-10-01). The critical set and every PAN come from that run: the
  reproduced Narayanan v15 channel is day book + operator template + the Winman
  TDS export (`winmanPath`) + the verbose ledger masters UNAVAILABLE (so
  `books.mastersSource` is `"bundle"` and PANs are the Winman's, `panAdopted`
  72). Re-run with live masters reachable and the same files gives 48 criticals
  and 27 no-PAN rows at the s.206AA 20% — a different liability, not a payable
  bug. The channel is visible in the review JSON (`books.mastersSource`,
  `winman.used`, `mastersAvailable`), so prove the ids match the finalised
  review before reporting a total.
- **The rate column is a statutory rate, never `liability / gross`.** `gross`
  is the engine's base, smaller than the bill for a threshold/cumulative
  section, so the ratio read 10.0151% for a 10% rate and 0 where `taxPayable`
  was 0. Resolution is now liability `rate` → `party|date|section` (the 194Q
  party-month key) → `rateFor` over the review's own context, bound into
  `TdsBooksCache.rateOf`; null only when the section is out of the law table.
- **The "due date of deposit" is the Rule 30 date of the ORIGINAL deduction or
  booking** (7th of the next month, 30-Apr for March) — never the date after
  the payment, which made every shortfall row read 07-Nov-2026 regardless of
  age. `statementRow` uses `depositDue(deemed ? bookingDate : deductionDate)`.
- **s.201(1A) leg (ii) is measured from the DEDUCTION date**, not from the Rule
  30 due date: `analyzeTds` and `tds3cd.ts:287` both gate on the due date and
  measure from the deduction, and a leg from the due date forgives every month
  the tax was held before it fell due.
- **The statement sheet's title notes are part of the deliverable and its
  header row index is a test constant.** The notes on `Payable statement` are
  what the operator reads for the deemed-deduction, due-date and rate rules, so
  a rule change must edit them (`buildPayableStatement`'s `title` in
  `src/tds-payable-template.ts`) — the v18 fix changed the due-date and rate
  notes only after the shipped workbook still told the operator the old
  "Rule 30 date after that payment" rule. Each title line is one sheet row, so
  adding a line moves the header down and breaks
  `test/tds-payable.test.ts`'s `headersAt(sheet(...), N)` (now 9).
- **A statement workbook is verifiable without any PAN reaching the log**
  (2026-10-01). `readWorkbook` on the operator's disk gives the columns
  `Party PAN` (not "PAN") and `Rate of deduction` as a DECIMAL with a percent
  number format, so a verifier must compare numbers, not formatted strings.
  Two checks settle both rates and the kind column offline:
  `rate == lawOf(section).rates.pan4thChar?.[pan[3]] ?? law.rates.standard`
  and `pan[3] === "C" ⇔ kind === "Company"`. On Narayanan every one of the 14
  rows is `P` (12) or `F` (2) — so the two 194-I(a) rows at **2% with a
  Non-company kind are a FIRM's reduced rate** (4th char `F`), not a
  mis-resolved rate, and no operator certificate was involved: the
  Certificates sheet of the DRAFT-20260928 template parses to zero rows
  (  `op.certificates.length === 0`), so a certificate is never the explanation
  for a rate on that channel. Read the certificate sheet through
  `parseOperatorTemplate` rather than sheet XML, whose cells were numeric
  only.
- **The v19 rework (design addendum §13)** supersedes the bullets above on
  three points, all firstmate's spec: (a) the amount column on BOTH workbooks
  is `payableBase(c) = round2(shortfall / rate)` so `amount × rate = TDS to be
  paid` to the paisa (falls back to the row's expense only when no rate
  resolves); (b) the statement drops `TDS that should have been deducted` /
  `TDS actually deducted` and renames `Shortfall to pay` → **`TDS to be paid`**
  (the decisions workbook keeps those columns as context), so a statement
  title/summary edit must move in step with `statementColumns` — the header
  row index is still 9 with exactly 8 title lines; (c) the **date of deduction
  is operator input defaulting to `periodEnd`** (`buildStatement` takes
  `periodEnd` + the `deductionDates` map, both YYYYMMDD-checked) and the
  interest re-parameterises to IT, not to the payment date: leg (i) booking →
  that date, leg (ii) that date → payment only past `depositDue(that date)`,
  which is also the deposit-due-date column (30-Apr-2026 for 31-Mar-2026).
  `tds_not_deposited` keeps the books' own date. The `Date of deduction`
  column is OPTIONAL in `parsePayableDecisions` (absent header / blank cell ⇒
  no date) so the filled v18 workbook still parses, and the statement result
  rows now carry `deductionDate` for the ready report.

## Sharp edges found resolving a month-end duty journal's section (2026-10-08)

- An ambiguous (multi-mapped) duty ledger's credit is resolved per row by
  `evidenceSection` (`src/tds.ts`) in this order: same-voucher expense →
  same-date bill → **same-month bill (new, 2026-10-08)** → nearest-bill
  fallback. The same-month step asks only whether the deductee's candidate
  charge bills of the credit's OWN calendar month all point to ONE section
  (the universe `allocateSplitCredits`' month consolidation covers); two
  sections or none falls through unchanged. Never raise
  `NEAREST_BILL_CAP_DAYS` instead — the cap is not what it looks like.
- **`NEAREST_BILL_CAP_DAYS` compares `YYYYMMDD` numerals, not days**
  (`dnum`, `src/tds.ts`): any cross-month pair differs by ≥ 70, so the
  "nearest bill, N days" fallback can only ever answer a SAME-month bill
  within 15 days, and its "N days" label is a day count only inside one
  month. A month-end two-line journal 21 days after its bill on a
  two-section duty ledger was therefore dropped before the credit ever
  entered `deductions` — a false `TDS-001-3` not-deducted — and the
  same-month step is what closes it. Raising the cap would not have reached
  cross-month pairs either.
- The step's diagnostic label is `resolvedBy: "same-month bill"` with
  `linkedBill` = the month's nearest bill; after this change the
  `nearest bill, N days` branch is reachable only when the month's bills span
  two candidate sections (pinned by test/tds.test.ts).

## Winman 3CD depreciation (clause 18 additions/deletions, 2026-09-27)

- Design of record: `docs/design/2026-09-27-winman-3cd-depreciation-design.md`; engine `src/dep3cd.ts`
  is voucher-level (day book only) and NEVER reuses `groupAcquisitions` — its 90-day same-party merge
  folds two same-day purchases into one row.
- Deletions are consideration received (money/party debit minus output tax, or the transfer out of a
  Sales-Accounts disposal ledger), never the asset credit: P/L-on-sale journals DEBIT asset ledgers on
  real books and must classify `sale_pl`, not as an addition. D3CD-006 is scoped to the Sales-Accounts
  chain (`SALES_ACCOUNTS` in `src/dep3cd.ts`) — an income-root test alone wrongly flagged a
  non-sale "Profit on Sale…" ledger under Indirect Incomes.
- The first-column block text must be one of the workbook's own dropdown strings (`readListValues`);
  Winman's validation is only a warning, so the writer refuses anything else. Rows carry no names —
  the writer needs no vault de-masking.
- D3CD findings have their own ordinal space; `CHECK_ORDINAL` is untouched. `INCLUDE_SAME_VOUCHER_CHARGES`
  is `false` (captain Q3: an expensed charge is not added), so D3CD-010 never fires; a cash-in-hand part
  over ₹10,000 is EXCLUDED and flagged D3CD-011 (Q9).

## Sharp edges found fixing the TDS pairing cascade and TDS-012-1 (2026-09-29)

- **One duty credit may cover SEVERAL bookings** (`TdsShare` on `TdsDeduction`,
  `allocateSplitCredits`/`splitSubset` in `src/tds.ts`, run before the 1:1 walk). A month of bills
  netted into one TDS journal is ordinary practice; under the strict 1:1 `claimed` set the credit
  attached to one bill, stranded the other, and the pairing cascaded by nearest date (measured on a
  real FY: 9 findings, ~95% of the not-deducted total, for deductions present in the books).
- **A share is a per-booking VIEW, never an event**: the credit keeps its own tax, its 1:1 deposit
  chain, its return-challan allocation and its month-pool place. A share must never enter those
  streams — a 26Q return carries ONE allocation for the journal, not one per bill, so injecting
  per-booking deductions into `events.deductions` would break the challan and pool matching.
  Consequences to remember: pass 2 reads `dedTax` (the share) in place of `ded.tax` everywhere;
  interest stamps go on the SHARE and `src/tds3cd.ts` sums `d.shares[].interestI/II` (stamping the
  parent would both double-count per booking and lose all but the last).
- **Exact 1:1 always wins over a split** (a credit that fits one liability is never spread), the
  search is bounded (`SPLIT_MAX_BOOKINGS` 4, `SPLIT_MAX_CANDIDATES` 12, same 30-day window as the
  1:1 join) and the tie-break is total (fewest bookings, tightest date span, earliest) so the choice
  never depends on iteration order.
- **The party-month coverage rule hides a same-month split.** `monthCredit >= monthLiability`
  already silences two bills and their credit when all three fall in one month, so a regression test
  for the allocation MUST place the bills in months the credit is not in, or it passes with or
  without the fix. (`test/tds-split-allocation.test.ts`.)
- **"Mapped" for a duty ledger means ≥1 candidate section, never `dutySectionOf !== null`** —
  `dutySectionOf` returns a section only for a SINGLE mapping, so reading its null as unmapped
  called the 194-I hire/rent ledger (mapped to both 194-I(a) and 194-I(b)) unmapped while all
  ₹4.42 lakh of its credits were in fact analysed per row. Without `dutyCandidatesOf` the caller
  cannot disambiguate at all, so the old gap wording is then the honest one.
- A not-deducted finding now ends with `creditEvidence(...)` (dates and `money()` only, never a
  name, voucher number or PAN) naming the credit that was considered — "no duty credit was found"
  sent the operator hunting a payment the books already held.

## Sharp edges found adding the same-month consolidation (2026-09-29)

- A Tally month-end deduction journal is booked against MANY expense vouchers of
  the same party in the same month. `allocateSplitCredits` (`src/tds.ts`) now has
  TWO scopes: the **month** scope (`d.consolidated = "month"`), whose whole-month
  unpaired set is tried first and is UNBOUNDED — that is what lets one credit clear
  any N > 4 — and only a partial month falls to the subset search bounded by
  `CONSOLIDATION_MAX_CANDIDATES` (12); then the existing 30-day **window** scope
  (`"window"`, `SPLIT_MAX_BOOKINGS` 4) for cross-month credits. Every bound that
  bites raises `tds_consolidation_search_skipped` (TDS ordinal 19) in plain words
  with both counts — never a silent skip. An exact 1:1 pairing still wins first.
- **`TdsReviewResult.consolidations` is the ONLY place a silently covered booking
  is visible** — a consolidated booking raises no finding at all, so a reviewer
  learns why it counts as deducted from that list alone (masked pseudonym,
  `displayDate`, `money()`; `TdsConsolidationSkip` never leaves the engine except
  as a finding).
- **A credit's deposit facts are the CREDIT's, never the share's.** Late deposit,
  deposit mismatch and not-deposited are raised once for `ded.tax` on the credit's
  primary booking (`creditReported`); the per-share repetition reported **734**
  late-deposit findings for 65 credits on a real FY. A consolidated credit
  additionally adds **no s.40(a)(ia) base**: one monthly deposit has to be
  resolved against the 2026-09-26e month pool first, and a base spread over the
  month's bills overstates the disallowance when the liability is only a
  post-threshold excess (194Q read a whole month of purchases as 17.7 cr of
  not-deposited expenditure).
- A same-month consolidation is never `tds_late_deducted`: the credit carries the
  month's BATCH date and a monthly-payment section is not due until the 7th of the
  month AFTER the booking, so a journal dated inside the booking's own month is
  not late. Testing `calendarMonths(...) === 0` was too narrow — a 01-Feb bill
  against a 28-Feb journal reads as one month and still fired.
- Measured on the Narayanan FY 25-26 day book (2026-09-29): not-deducted 61
  (₹59,016.23) and short-deducted 16 (₹18,753.99) **do not move** — the
  2026-09-26e party-month coverage rule already silences the whole-month case, so
  the new rule's value there is per-booking attribution into `liabilities` plus
  the `consolidations` list. Late-deducted fell 90 (₹25,32,674.72) → 37
  (₹16,94,976.00) and 65 consolidations cover 2,177 bookings. Open follow-up
  (deliberately untouched): the 194Q month pool is all-or-nothing per month, so
  lump monthly payments against per-party credits leave a short month uncovered
  and unpooled 194Q credits are still not reported.

## Sharp edges found fixing the 26AS combination reuse (2026-09-30)

- **One books entry may explain at most ONE 26AS match, of any kind.** `reconcileParty`'s
  `fitsByTarget` consumption loop (the tier-1/2 pools, whole-pool fallback and the rate-exact
  capacity fallback all land in that one map) built `gTakenBooks` but never tested a candidate's
  parts against it, so a journal that fitted two rows was consumed twice. The books side was then
  explained by a tax the 26AS side counted once and the per-party identity
  `Σ Books-not-in-26AS − Σ 26AS-unmatched = Deductors delta` broke by exactly that entry's tax
  (live: 24,256 on Greater Chennai Corporation, which is how the captain found it — the sheets are
  the tell, not the findings). The loop now resolves each fit's parts to `unmatchedBooks` indices
  and refuses a fit touching a consumed one; targets walk in 26AS row order (earliest wins) and a
  refused target stays unmatched together with its exclusive parts. **A new as26 group-matching
  stage must join the same `gTaken*` discipline**, and `test/as26.test.ts`'s "combo reuse" describe
  pins the per-party identity against `AS26_TAX_TOLERANCE × (paired + combinations)` — the slack is
  real: an accepted match may sit one rupee off and the sheets then legitimately miss by one.
- `as26-bill.ts` needs no change: it folds `r.combinations` into `Set<number>`s keyed by
  `dedIdx`/`txIdx`, so it inherits the fix and keeps B/D numbering stable.
- `totalsOnly` parties (design §12.1) carry **no** rows on the two unmatched sheets by design, so
  a bank `totalsOnly` party never nets to its delta — read the identity only for bill-level
  parties, and join the sheets on the `P<n>` party id (not the party name: the two sheets name
  opposite sides).
- `tb_write_26as_report` refuses in a fresh session ("run tb_26as_review first") — the review and
  the report write must share one driver session, and a scratch `pause`/narrative file must already
  exist or the driver waits forever (run it detached; a shell timeout kills the driver and loses
  the write).
