import { readWorkbook } from "./xlsx-read.js";
import type { GridCell, GridSheet } from "./xlsx-read.js";
import {
  accessors,
  bindColumns,
  colLetter,
  dataRows,
  raw,
  textCell,
  type CellRef,
} from "./tds-file.js";
import { PAYABLE_DECISIONS, payableRunDigest, type PayableRunIdentity } from "./tds-payable-template.js";
import type { PayableDecision } from "./tds-payable.js";

/**
 * The TDS payable decisions workbook, parsed back (design of record:
 * docs/design/2026-10-01-tds-payable-statement-design.md).
 *
 * The error contract is `src/notds-file.ts`'s: every fault names the sheet,
 * the Excel row and the column letter with its header — never a cell value,
 * which a stray operator cell can make a PAN. Structural problems reject the
 * whole file: a half-read decision set would silently shrink a challan.
 *
 * The one check this channel adds that no operator template in the project
 * has: the **run identity** on the hidden `Run` sheet. A workbook generated
 * from another review is refused, because its finding ids mean nothing
 * against this run's rows — and a decision the operator made against a
 * different set of findings must not be read as a decision here.
 */

export interface TdsPayableOperatorFile {
  /** finding id → the operator's decision; absent means not decided. */
  decisions: Map<string, PayableDecision>;
  /** Ids present on the sheet with no Decision cell — the open ones. */
  undecided: string[];
}

/** What an absent or wholly blank decisions workbook parses to. */
export const EMPTY_PAYABLE_OPERATOR: TdsPayableOperatorFile = {
  decisions: new Map(),
  undecided: [],
};

const RUN_FIELDS = [
  "company",
  "fromDate",
  "toDate",
  "asOnDate",
  "criticalCount",
  "digest",
] as const;

const find = (sheets: GridSheet[], name: string): GridSheet | undefined =>
  sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());

/** `template <sheet> row <n>, column <L> (<Header>): …` — the house shape. */
const fault = (r: CellRef, msg: string): Error =>
  new Error(`template ${r.sheet.name} row ${r.row.row}, column ${colLetter(r.col)} (${r.header}): ${msg}`);

/** A cell's text, trimmed; blank is "". */
const cellText = (cell: GridCell | undefined): string => String(raw(cell).value ?? "").trim();

/**
 * The Decision cell: blank, or one of the two dropdown words (case-insensitively
 * matched and returned in the workbook's own case). Anything else rejects the
 * file — a typo must never read as "not decided", because that would look like
 * a reason to skip a real shortfall.
 */
function decision(r: CellRef, cell: GridCell | undefined): PayableDecision {
  const s = cellText(cell);
  if (s === "") return null;
  const hit = PAYABLE_DECISIONS.find((d) => d.toLowerCase() === s.toLowerCase());
  if (hit === undefined) {
    throw fault(r, `enter Accept or Reject, or leave blank while you are still deciding`);
  }
  return hit;
}

/**
 * Read the hidden `Run` sheet and refuse any field that does not match the
 * review being run. The digest is **never echoed**: a 12-hex run can hold six
 * digits `scrubDigits` would rewrite, and a digest teaches the operator
 * nothing anyway.
 */
function checkRun(sheets: GridSheet[], expected: PayableRunIdentity): void {
  const run = find(sheets, "Run");
  if (!run) {
    throw new Error(
      "template sheet missing: the workbook must carry a Run sheet naming the review it was generated " +
        `from — this file has: ${sheets.map((s) => s.name).join(", ")}`,
    );
  }
  const cols = accessors(
    bindColumns(run, [{ header: "Field" }, { header: "Value" }]),
  );
  const fieldCol = cols.get("Field")!;
  const valueCol = cols.get("Value")!;
  const seen = new Map<string, string>();
  for (const row of dataRows(run)) {
    const field = cellText(row.cells.get(fieldCol));
    if (field === "") {
      throw fault({ sheet: run, row, col: fieldCol, header: "Field" }, "required cell is blank");
    }
    if (seen.has(field)) {
      throw fault(
        { sheet: run, row, col: fieldCol, header: "Field" },
        `this field already appears in row ${seen.get(field)}`,
      );
    }
    seen.set(field, String(row.row));
  }
  const read = (name: string): string | undefined => {
    for (const row of dataRows(run)) {
      if (cellText(row.cells.get(fieldCol)) !== name) continue;
      return cellText(row.cells.get(valueCol));
    }
    return undefined;
  };
  const problems: string[] = [];
  for (const f of RUN_FIELDS) {
    if (!seen.has(f)) problems.push(`${f} is missing`);
  }
  if (problems.length === 0) {
    if (read("company") !== expected.company) problems.push("a different company");
    if (read("fromDate") !== expected.fromDate) problems.push("a different review period");
    if (read("toDate") !== expected.toDate) problems.push("a different review period");
    if (read("asOnDate") !== expected.asOnDate) problems.push("a different as-on date");
    if (read("criticalCount") !== String(expected.criticalCount)) {
      problems.push("a different number of critical findings");
    }
    // The digest is compared, never printed.
    if (read("digest") !== payableRunDigest(expected)) problems.push("different findings");
  }
  if (problems.length > 0) {
    throw new Error(
      `template Run sheet: this workbook was generated from another review (${problems.join("; ")}) — ` +
        "regenerate it from this run with tb_write_tds_payable_decisions",
    );
  }
}

/**
 * Parse the decisions workbook for `expected`'s run. `expectedFindingIds` is
 * the run's own critical-finding list: a row naming an id this run never
 * raised rejects the file, because it is either a stale row or a mistyped id,
 * and either way it is not a decision about this run.
 */
export function parsePayableDecisions(
  buf: Buffer,
  expected: PayableRunIdentity,
  expectedFindingIds: readonly string[],
): TdsPayableOperatorFile {
  const sheets = readWorkbook(buf);
  checkRun(sheets, expected);
  const known = new Set(expectedFindingIds);
  const findings = find(sheets, "Findings");
  if (!findings) {
    // A run with no critical findings has nothing to decide on; the workbook
    // still carries its Run sheet and is accepted as an empty decision set.
    if (expectedFindingIds.length === 0) return EMPTY_PAYABLE_OPERATOR;
    throw new Error(
      "template sheet missing: the workbook must carry a Findings sheet — this file has: " +
        sheets.map((s) => s.name).join(", "),
    );
  }
  const cols = accessors(
    bindColumns(findings, [{ header: "Finding ID" }, { header: "Decision" }]),
  );
  const idCol = cols.get("Finding ID")!;
  const decCol = cols.get("Decision")!;
  const decisions = new Map<string, PayableDecision>();
  const undecided: string[] = [];
  const firstRow = new Map<string, number>();
  for (const row of dataRows(findings)) {
    const idCell: CellRef = { sheet: findings, row, col: idCol, header: "Finding ID" };
    const id = textCell(idCell, row.cells.get(idCol));
    if (id === undefined) {
      throw fault(idCell, "required cell is blank");
    }
    if (!known.has(id)) {
      throw fault(
        idCell,
        `not a critical finding of this review — the ids are assigned per run, so a row from another ` +
          "run means nothing here; regenerate the workbook",
      );
    }
    if (firstRow.has(id)) {
      throw fault(idCell, `this finding id already appears in row ${firstRow.get(id)}`);
    }
    firstRow.set(id, row.row);
    const d = decision({ sheet: findings, row, col: decCol, header: "Decision" }, row.cells.get(decCol));
    decisions.set(id, d);
    if (d === null) undecided.push(id);
  }
  // A row the operator deleted is not a decision: report it open rather than
  // silently shrinking the statement.
  for (const id of expectedFindingIds) {
    if (!firstRow.has(id)) undecided.push(id);
  }
  return { decisions, undecided };
}