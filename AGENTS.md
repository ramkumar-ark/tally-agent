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
  findings is by construction until it masters its TDS flags or the
  operator file lands (a separate captain call).
