# Tally Agent — GST Summary & Mismatch (Milestone 2) — Design

Date: 2026-09-13
Status: approved for implementation (firstmate task `ta-m2-gst-summary`)
Project: tally-agent (local-only)
Depends on: Milestone 1 (masking boundary unchanged), `tally_prime_mcp_server` (unchanged)
Requirements satisfied: R-MCP-6, R-P-9, R-R-4 (canon: `/home/ram/firstmate/data/ta-requirements-canon/report.md` §2 M2, §3.1, §3.3, §5.7)

## 1. Purpose and scope

Report GST liability from the books for a period, and flag return-vs-books
mismatches, without any raw GSTIN or PAN reaching the model.

**In scope**

- A masked tax-ID channel (§2) — the design decision every later tax-ID
  feature inherits.
- `tb_gst_summary` — period GST liability from the books: per tax head
  (CGST / SGST-UTGST / IGST / Cess / GST-other), output tax, input tax credit,
  net liability.
- `tb_gst_mismatch` — return-vs-books comparison joined on GSTIN, in code,
  producing findings in the M1 `Finding` shape.
- `tb_write_gst_report` — de-masked Markdown + findings CSV through the same
  report writer and the same report-directory boundary as M1 (R-R-1…R-R-4).
- The R-P-9 masker fix: GSTIN/PAN-shaped tokens redacted from every outbound
  string, with the leak test made non-vacuous (canon §5.7).

**Explicitly out of scope**

- Any per-ledger master dump. The `tally_get_ledger` ban (R-MCP-3) stands
  unchanged.
- Any write path (M6, gated on captain decisions).
- Excel output (M4) — including Excel/CSV *import* of return data; M2 reads a
  JSON returns file only.
- Fetching returns from a government portal; the operator supplies filed
  figures.
- RCM (reverse charge) classification — no deterministic signal without extra
  configuration; deferred.

## 2. The design problem: GSTIN-aware matching with no GSTIN at the model

GST mismatch work needs to join return rows (keyed by GSTIN) to book rows
(keyed by ledger name). The only downstream tool that returns GSTINs per
ledger together with address/bank/email/phone is `tally_get_ledger`, and the
gateway bans it (R-MCP-3). Raw GSTINs must never reach the model (R-P-9), and
the canon (§5.7) records that today they *would*: digit-run scrubbing cannot
catch `27AAAAA0000A1Z5` (no 6-digit run), and the known-name sweep only masks
already-vaulted party names.

### 2.1 Decision

**Vaulted tax-ID aliases over a gateway-internal GSTIN map, with file-mediated
return ingestion and shape-based redaction as the free-text backstop.**

Four mechanics, each reusing an M1 seam:

1. **Books-side GSTINs are fetched internally, never proxied.** The gateway
   calls the already-proxied `tally_get_ledgers` with `verbose:true`, which
   returns `gstin` and `state` per ledger alongside name/parent/balances
   (downstream `src/tools/reads.ts:623-668`) — and *not* address, bank
   account, IFSC, email or phone. The GSTIN map lives in gateway memory only.
   The `tally_get_ledger` ban is untouched: no per-ledger master-dump tool is
   exposed, and the extra scalars never leave the gateway except as aliases
   (mechanic 3).
2. **Returns-side GSTINs never transit the model in either direction.** The
   operator prepares a returns file (JSON, §4.3); the model passes only the
   *path* as a tool argument; the gateway reads and parses the file itself.
   Whatever the operator types into chat, the model sees — so inline returns
   arguments are rejected outright: a GSTIN-keyed GSTR-2B/3B payload is the
   most GSTIN-dense artifact in this milestone.
3. **The model correlates by alias, in both identities.** Party ledgers keep
   their M1 pseudonyms (`Creditor 3`). GSTINs are vaulted the same way:
   `vault.pseudonym(gstin, "tax_id")` → `TaxId 3`, stable for the session
   (R-P-4 pattern). De-masking stays exactly where M1 put it (R-P-5): the
   report writer's `demaskText` restores real party names *and* real GSTINs on
   the way to disk, so the accountant's report shows
   `Creditor 3 (27AAAAA0000A1Z5)` as `Acme Traders (27AAAAA0000A1Z5)` while
   the model only ever held aliases.
4. **Shape-based redaction is the backstop for free text.** Every outbound
   string now passes `redactTaxIds` before `scrubDigits`: GSTIN-shaped tokens
   (`\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}`, case-insensitive) and PAN-shaped
   tokens (`[A-Z]{5}\d{4}[A-Z]`) become `[tax-id]` — vaulted or not. A GSTIN
   the vault knows is first replaced by its alias through the existing
   `maskKnownNames` sweep, which is strictly better for correlation.
   Over-redaction (an innocent 10-char token shaped like a PAN) is the
   accepted failure direction — same philosophy as default-mask.

The join itself runs in code on unmasked data (R-E-1): the gateway matches
normalized real GSTINs from the returns file against the internal
ledger→GSTIN map. The model never types, sees, or compares an ID.

### 2.2 Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Truncated / last-N GSTIN shown to the model ("…1Z5") | Leaks ID fragments; tails collide (13th char is an entity counter, 14th is usually `Z`); creates a second identity scheme beside the vault. Matching would still have to happen in code, so the fragment buys nothing the alias doesn't. |
| Return rows as inline tool arguments | Puts raw GSTINs in model-authored text. Fatal for R-P-9. |
| Name-based matching (returns `partyName` ↔ ledger name) | Fragile (legal name vs trading name variants), and re-introduces names as join keys — the thing M1's id-keyed design removed. `partyName` is used only to label an alias for a returns-only party, never to join. |
| Proxy `tally_get_ledger` with a field filter | The ban is the point (R-MCP-3): a filtered proxy still puts a master-dump tool at the boundary, one config change away from full PII. Unnecessary, since `tally_get_ledgers(verbose:true)` carries the two scalars GST work needs. |
| No GSTINs at all; aggregate-only comparison | Dodges the design tension instead of solving it, yields a much weaker report (no party-level flags), and the canon explicitly asks M2 to build the masked tax-ID channel as the pattern for later tax-ID features. |

### 2.3 What later tax-ID features inherit

Any future feature touching tax IDs follows the same four mechanics: fetch
IDs internally from the narrowest downstream field set that carries them;
ingest ID-bearing operator data by file path, not by chat; correlate through
vault aliases with de-masking only in the report writer; and keep
`redactTaxIds` on every outbound string as the structural backstop.

## 3. Books-side computation

### 3.1 Data sources

- `tally_get_vouchers(fromDate, toDate, includeLines:true)` — Day Book with
  ledger entry lines. Parsed once at the boundary into typed rows (R-MCP-5):
  entry amounts normalized to **positive = debit** (raw Tally convention is
  negative = debit; same flip the trial-balance parser already does).
  Cancelled vouchers are skipped; a defensive date-range re-filter guards
  period correctness (a tax number that silently absorbs an out-of-period
  voucher is worse than a slow fetch). First call is heavy on large companies
  (downstream fetches and caches the Day Book for 5 minutes).
- `tally_get_ledgers(verbose:true)` — name, parent, balances, `gstin`,
  `state`, per ledger.
- `tally_get_groups` — the M1 classifier, rebuilt per call (M1 behaviour;
  canon §5.2 asks M2+ to decide caching deliberately: **decision — no new
  gateway-side cache**; the downstream 5-minute cache carries repeat calls,
  and per-call rebuild keeps multi-company sessions honest).

### 3.2 GST ledger identification and tax heads

A ledger entry is a GST entry when **both** hold (deterministic, no
configuration):

- its ledger's group ancestry includes `Duties & Taxes` (classifier walk, so
  sub-groups like `GST` count), and
- its ledger name contains a tax-head keyword.

Head normalization (first match wins, on the lowercased name): `cgst`→CGST,
`igst`→IGST, `sgst`/`utgst`→SGST/UTGST (merged, as GSTR-3B reports them),
`cess`→CESS, else `gst`→GST-OTHER. Non-GST `Duties & Taxes` ledgers (TDS,
VAT) are excluded by the keyword rule; a GST ledger parked outside the
ancestry is missed — stated limitation, made visible by listing every
recognized tax ledger in the summary output.

### 3.3 Sign convention

Per GST ledger entry (positive = debit): **credit = output tax booked,
debit = input tax credit booked.** Sign-based rather than voucher-type-based,
so debit/credit notes and adjustment journals net correctly without
interpreting user-defined voucher type names. `net = output − input` per head
is the period liability movement; period movement (not closing TB balances,
which carry prior-period residue) is what a return covers.

### 3.4 Party attribution (for the mismatch)

- Voucher **kind**: `outward` when any entry's group ancestry roots at the
  primary group `Sales Accounts`; `inward` at `Purchase Accounts`. Group
  ancestry is stable; voucher type names are user-defined — never trusted.
- **Taxable value** per kind: sum of the entries under those roots.
- **Party**: the voucher header's `partyLedgerName`; fallback to the entry
  whose ledger role (classifier) is debtor (outward) / creditor (inward).
  Multi-party vouchers attribute to the header party — stated limitation.
- GST entries on vouchers with no kind or no party are counted in the summary
  aggregates and reported as **unattributed** in the mismatch output; they
  never invent a party row.

## 4. Tool surface (grows 4 → 7)

R-MCP-1's "four tools, exactly" was M1's approved list; R-MCP-6 is the growth
rule: every new tool routes outbound payloads through the masker and the leak
test enumerates the live registry. The exactness assertions
(`test/server-tools.test.ts`, `test/leak.test.ts`) are updated to the new
approved list in the same commit — a *new* unapproved tool still fails the
build.

### 4.1 `tb_gst_summary(company?, fromDate, toDate)`

Returns: per-head `{head, output, input, net}` rows; totals
`{output, input, netLiability}`; `taxLedgers` rows (ledger name through the
choke point — `Duties & Taxes` is a clear root, so tax ledger names pass
scrubbed, and overrides still apply); `vouchersScanned`,
`cancelledSkipped`, `unattributedTax`. **No party names at all** — the
summary is aggregate by construction.

### 4.2 `tb_gst_mismatch(company?, fromDate, toDate, returnsPath)`

Returns: `counts` by severity, masked `findings` (M1 `Finding` shape), and an
`aggregate` block comparing books vs returns per kind per head (so the model
can narrate scale, not just exceptions). Findings for book parties register in
`realLedgerByFinding`, so the **existing `tb_ledger_activity` drills into them
by finding id** (R-MCP-4 pattern — the model never holds the real name).

Four checks, severities assigned by rule (R-E-2), ids `GST-<ordinal>-<n>` in
their own ordinal space (`GST_CHECK_ORDINAL`; M1's `CHECK_ORDINAL` is never
renumbered — R-E-3):

| Check | Fires when | Severity |
|---|---|---|
| `gst_amount_mismatch` | GSTIN joins; any head differs beyond tolerance | warning |
| `gst_return_not_in_books` | return tax (kind-matched) with no book activity for that GSTIN | warning |
| `gst_books_not_in_return` | book tax (kind-matched, GSTIN known) absent from returns | warning |
| `gst_party_without_gstin` | book GST activity on a ledger whose master has no GSTIN — unjoinable, fix the master | review |

Tolerance: `GST_TOLERANCE = 1.00` per head (portals round to whole rupees;
books carry paise). Rows whose tax total is within tolerance are skipped —
nothing to file, nothing to dispute. Join key is the normalized GSTIN
(uppercased, trimmed); same GSTIN+kind rows in the file merge by summation.
Returns-only parties get a vault alias from the file's `partyName` when
present (role by kind: outward→Debtor, inward→Creditor), else from the GSTIN
itself (`TaxId N`).

### 4.3 Returns file (JSON, operator-prepared)

```json
{
  "returns": [
    {
      "gstin": "27AAAAA0000A1Z5",
      "partyName": "Acme Traders",
      "kind": "inward",
      "taxableValue": 50000,
      "cgst": 4500,
      "sgst": 4500,
      "igst": 0,
      "cess": 0
    }
  ]
}
```

`kind` ∈ {`outward`, `inward`}; amounts accept numbers or strings (parsed at
the boundary, R-MCP-5); `gstin` must match the GSTIN shape. **Validation
errors cite the row index and never echo the offending value** — an error
message is an outbound string, and a malformed GSTIN is still a tax ID.
Malformed files are rejected wholesale (no partial processing). CSV/XLSX
import belongs to M4 (R-X-2).

### 4.4 `tb_write_gst_report(company, fromDate, toDate, markdown)`

Mirrors `tb_write_report`: the model composes the narrative in masked terms;
the writer de-masks on the way to disk (`demaskText`, restoring party names
and GSTINs) and writes `gst-review-<company>-<from>-<to>.md` plus
`gst-findings-<company>-<from>-<to>.csv` (the same `findingsCsv` columns;
`side`/`expected` stay empty for GST findings) into `TALLY_AGENT_REPORT_DIR`
— same writer module, same directory, same harness deny rules (R-R-3, and
R-R-4's "future artifacts follow the pattern"). Refuses unless
`tb_gst_mismatch` has run in the session. The vault dump remains gated behind
`TALLY_AGENT_DUMP_VAULT` (R-P-7) and now would include tax-ID aliases —
which is exactly why the gate exists.

Every new tool writes its session audit line (R-R-2): tool, args (the
returns *path*, never its contents), row count, masked count.

## 5. Masking boundary — unchanged

The M1 boundary is load-bearing and is not modified: default-mask classifier,
in-memory vault, single choke point, de-masking only downward (finding id →
real name inside `ledgerActivity`) and outward (alias → real inside the report
writer). M2 additions, all on the model-facing side of that boundary:

- `redactTaxIds` composes with `scrubDigits` at every point `scrubDigits`
  already ran (voucher rows, finding details, clear-path ledger names).
- `maskKnownNames` automatically substitutes vaulted GSTINs in free text once
  they are vaulted (the sweep is vault-driven; no new code path).
- The vault gains the label `TaxId` (role `tax_id`) — a label-only role; the
  classifier never returns it.
- State names/codes are deliberately **not** exposed: minimal surface, and the
  CGST+SGST vs IGST split already tells the model intra- vs inter-state.

## 6. Testing

No test requires a live Tally (fixtures only), per M1 §8.

1. **Red first, per canon §5.7.** Put GSTIN- and PAN-bearing rows into the
   fixture corpus the gateway actually consumes (verbose ledger row, voucher
   narration, voucher reference, the returns file) and their strings into
   `secrets.json`; watch the leak test fail; then fix the masker.
2. **Non-vacuity is now structural.** The leak test asserts every secret
   *appears in the fixture corpus* before asserting it is absent from tool
   outputs — a secret no fixture carries can never again make the test pass
   vacuously.
3. **Leak test covers the whole surface**: all seven tools exercised
   (including `tb_gst_mismatch` against a temp returns file and
   `tb_write_gst_report`), registry-exactness updated, `tally_get_ledger`
   still asserted absent.
4. **Unit tests**: `redactTaxIds` shapes (GSTIN, PAN, lowercase, embedded in
   text, over-redaction accepted); GST pure functions (head bucketing, sign
   convention, cancelled skip, unattributed bucket, kind detection, party
   fallback, tolerance near-misses at 0.99/1.01); returns-file validation
   (malformed shape errors that never echo values, merging); GST report writer
   (artifact names, de-masked GSTINs on disk, aliases absent); downstream
   parsing of the voucher/verbose-ledger contracts (fixture-pinned, R-E-6).
5. **Environmental note**: three `entrypoint.test.ts` cases hard-code Windows
   path semantics (committed green on the Windows host) and cannot pass under
   Linux POSIX path resolution. They are guarded with
   `skipIf(process.platform !== "win32")` — still executed where the bug they
   cover lives.

## 7. Risks

| Risk | Consequence | Handling |
|---|---|---|
| Day Book fetch is slow on large companies | Slow first GST call | Downstream caches 5 min; tool description says so; no gateway-side cache added (deliberate, canon §5.2) |
| GST ledger parked outside `Duties & Taxes` ancestry | Missed from summary | Stated limitation; `taxLedgers` rows make what *was* recognized visible; group rule is the same allowlist philosophy M1 verified live |
| Returns file transcribed wrongly by the operator | False mismatches | Findings are warnings needing a stated reason (M1 severity philosophy); the report shows both sides per head |
| Multi-party voucher | Tax attributed to header party | Stated limitation; rare in practice; aggregate totals unaffected |
| PAN-shaped innocent token in free text | Over-redaction | Accepted fail-safe direction; override file remains the escape hatch for identities, redaction is not configurable by design |

## 8. Milestone boundary

M2 is complete when `tb_gst_summary` and `tb_gst_mismatch` return masked data
through the existing choke point, `tb_write_gst_report` lands the de-masked
MD+CSV pair through the M1 writer and boundary, the leak test is green with a
non-vacuous GSTIN secret over all seven tools, and the full suite and
typecheck are green — with no new unmasked field reaching the model and the
`tally_get_ledger` ban intact.
