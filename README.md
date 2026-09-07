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

Local-only scaffold pending. Full design and implementation will be built
as tracked ship tasks once worker dispatch is available.
