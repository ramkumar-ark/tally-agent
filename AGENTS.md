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
  (package `tally-prime-mcp-server`; ships a committed `dist/`, no build
  needed). Confirm any candidate by grepping its `dist/` for the five tools
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
