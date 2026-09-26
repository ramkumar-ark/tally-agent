#!/usr/bin/env node
// V1/V2 verification of the Winman Form 3CD "TDS TCS summary" round trip.
// Design of record: docs/design/2026-09-24-tds-tcs-3cd-design.md (Task 10).
//
//   V1  the filled workbook re-reads through dist/ winman3cd: every data
//       sheet keeps formId 3cdTDS, the written row values equal the engine's
//       cached clause-34 slice, and every dropdown cell carries an exact list
//       member (emitted from src's constants, never retyped)
//   V2  Excel (COM via powershell.exe) opens the filled copy clean and runs
//       the workbook's own WorkBook_UnhideSheets + ValidateMandatoryFields
//   (b1) style-twin resolution (resolveStyleTwins) for s89 s90 s91 s98 s100
//       s101 is exercised and the taken path is logged
//
// V4 (the Winman import click) is captain-operated and is not attempted here.
//
// The source workbook is NEVER written into. The script reads it, seeds a
// stub-downstream session with synthetic bookings, fills a TEMP COPY and only
// ever opens that copy. Run with:
//
//   npm run build
//   node scripts/verify-3cd-tdstcs-roundtrip.mjs --source /tmp/opencode/tdstcs/source.xlsm
//
// The scratch copy of the operator workbook is machine state, not committed
// data: if `--source` (default the scratch path) is gone and `--original` (or
// TALLY_3CD_SOURCE_ORIGINAL) points at the original, it is re-copied to the
// scratch path. Neither the committed script nor its output stores anything
// but synthetic test values ("VERIFY CO", "VRFY12345A", ...).
//
// Exit codes: 0 pass, 1 assertion/Excel failure, 2 usage.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

const DEFAULT_SOURCE = "/tmp/opencode/tdstcs/source.xlsm";

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node scripts/verify-3cd-tdstcs-roundtrip.mjs --source <scratch.xlsm> [--original <original.xlsm>]");
  process.exit(2);
}

const argv = process.argv.slice(2);
let source = DEFAULT_SOURCE;
let original = process.env.TALLY_3CD_SOURCE_ORIGINAL;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--source") source = argv[++i];
  else if (argv[i] === "--original") original = argv[++i];
  else usage(`unknown argument ${argv[i]}`);
}
if (!existsSync(source)) {
  if (original && existsSync(original)) {
    mkdirSync(dirname(source), { recursive: true });
    copyFileSync(original, source);
    console.error(`scratch copy missing — re-copied the original from ${original} to ${source}`);
  } else {
    usage(
      `source workbook not found: ${source}` +
        (original ? "" : " (pass --original <path> or set TALLY_3CD_SOURCE_ORIGINAL to re-create the scratch copy)"),
    );
  }
}

// dist/ is gitignored build output; build it before running (see Usage).
let xlsm, winman, serial, review, downstream, classify, types, tdsDaybook, tdsLaw, tcsLaw;
try {
  const rel = (p) => new URL(`../dist/${p}`, import.meta.url);
  ({ serial } = await import(rel("xlsx.js")));
  xlsm = await import(rel("xlsm.js"));
  winman = await import(rel("winman3cd.js"));
  review = await import(rel("review.js"));
  downstream = await import(rel("downstream.js"));
  classify = await import(rel("classify.js"));
  types = await import(rel("types.js"));
  tdsDaybook = await import(rel("tds-daybook.js"));
  tdsLaw = await import(rel("tds-law.js"));
  tcsLaw = await import(rel("tcs-law.js"));
} catch (err) {
  console.error("error: could not load dist/ — run `npm run build` first");
  console.error(String(err && err.message ? err.message : err));
  process.exit(2);
}

// powershell.exe is NOT on PATH in this WSL distro; the absolute path is
// required (same as the PF/ESI twin script).
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

// ---- the engine's dropdown lists, emitted from src (never retyped) ----------

const TDS_DROPDOWN = [...tdsLaw.WINMAN_TDS_DROPDOWN];
const TCS_NATURES = [...tcsLaw.TCS_NATURES.map((n) => n.winman)];
if (TDS_DROPDOWN.length !== 44) throw new Error(`WINMAN_TDS_DROPDOWN has ${TDS_DROPDOWN.length} entries, expected 44`);
if (TCS_NATURES.length !== 13) throw new Error(`TCS_NATURES has ${TCS_NATURES.length} entries, expected 13`);

// Return details' 18-value FORMNO list and the 5-value Interest-on-TDS list,
// exactly as read from the workbook's hidden INTER sheet (C67:C84, C94:C98).
const RETURN_FORMS = ["24G", "24Q", "26A", "26B", "26Q", "26QAA", "26QB", "26QC", "26QD", "26QE", "26QF", "27A", "27B", "27BA", "27C", "27D", "27EQ", "27Q"];
const INTEREST_TDS_FORMS = ["24Q", "26A", "26Q", "26QB", "27Q"];

// ---- synthetic seed data ------------------------------------------------------
// Synthetic values ONLY. Raw Tally sign on every entry (negative = debit);
// the flip to positive = debit happens once in the reader, as at the gateway.
const COMPANY = "VERIFY CO";
const TAN = "VRFY12345A";

const MASTERS = [
  { name: "Contractors LLP A", parent: "Sundry Creditors", IncomeTaxNumber: "AAAA TEST", IsTDSApplicable: "Yes", TDSDeducteeType: "Company" },
  { name: "Fees Consultants B", parent: "Sundry Creditors", IncomeTaxNumber: "BBBB TEST", IsTDSApplicable: "Yes", TDSDeducteeType: "Company" },
  { name: "Work Charges", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "Professional Fees Chg", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: "TDS Prof Fees", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: "TCS Receivable", parent: "Duties & Taxes", IsTDSApplicable: "No" },
  { name: "Scrap Receipts", parent: "Sales Accounts" },
  { name: "Scrap Buyer", parent: "Sundry Debtors" },
  { name: "Bank", parent: "Bank Accounts" },
];

const voucher = (date, voucherNumber, voucherType, entries) => ({
  date, voucherType, voucherNumber, partyLedgerName: "",
  entries: entries.map(([LEDGERNAME, AMOUNT]) => ({ LEDGERNAME, AMOUNT })),
});

// 194C: 3,00,000 booked and deducted at 2% on the same day, deposited late on
// 15-Jul (due 07-Jun -> interest (ii) 270). Every ledger/party name in the
// seed is synthetic.
const VOUCHERS = [
  voucher("20250510", "PU/C", "Purchase", [["Work Charges", -300000], ["Contractors LLP A", 300000]]),
  voucher("20250510", "JV/C", "Journal", [["Contractors LLP A", -6000], ["TDS Contractors", 6000]]),
  voucher("20250715", "PY/C", "Journal", [["TDS Contractors", -6000], ["Bank", 6000]]),
  // 194J: 2,00,000 at the s.197 certificate rate (2% = 4,000), deposited
  // late on 10-Sep (due 07-Aug -> 3 months).
  voucher("20250715", "PU/J", "Purchase", [["Professional Fees Chg", -200000], ["Fees Consultants B", 200000]]),
  voucher("20250715", "JV/J", "Journal", [["Fees Consultants B", -4000], ["TDS Prof Fees", 4000]]),
  voucher("20250910", "PY/J", "Journal", [["TDS Prof Fees", -4000], ["Bank", 4000]]),
  // One scrap TCS pair: 1% of 3,00,000 collected 10-Oct, deposited 15-Nov
  // (2 months late against the 07-Nov due date) below the 07-Nov deposit
  // deadline of 07-Nov -> interest on the late deposit accrues from there.
  voucher("20251010", "S/T", "Sales", [["Scrap Receipts", -300000], ["TCS Receivable", 3000], ["Scrap Buyer", 303000]]),
  voucher("20251125", "PY/T", "Journal", [["TCS Receivable", -3000], ["Bank", 3000]]),
];

const OPERATOR = {
  sections: [
    { ledger: "Work Charges", section: "194C" },
    { ledger: "Professional Fees Chg", section: "194J" },
    { ledger: "TDS Contractors", section: "194C" },
    { ledger: "TDS Prof Fees", section: "194J" },
  ],
  parties: [
    { ledger: "Contractors LLP A", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: "Fees Consultants B", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
  certificates: [{ ledger: "Fees Consultants B", section: "194J", rate: 2, from: "20250401", to: "20260331", limit: 0 }],
  statements: [
    { form: "24Q", quarter: "Q1", filedDate: "20250731", tdsAmount: 6000 },
    { form: "26QE", quarter: "Q2", filedDate: "20251015", tdsAmount: 4000 },
  ],
  tan: TAN,
  tcsSections: [
    { ledger: "TCS Receivable", nature: "Scrap" },
    { ledger: "Scrap Receipts", nature: "Scrap" },
  ],
  interestPaid: [{ form: "24Q", quarter: "Q1", amount: 100, paidOn: "20250801" }],
};

// The stub-downstream session: every live tool rejects (the offline day book
// substitutes for groups/leaders by design), except the masters export. The
// session degrades by design — the documented stub pattern.
function stubDownstream() {
  const caller = async (tool) => {
    if (tool === "tally_get_ledgers") return JSON.stringify(MASTERS);
    throw new Error(`stub downstream has no fixture for ${tool}`);
  };
  return downstream.makeDownstream(caller, async () => {});
}

// ---- run the review and fill the copy ---------------------------------------

const FY = { fromDate: "20250401", toDate: "20260331" };
const workDir = await mkdtemp(join(tmpdir(), "tdstcs-"));
const scratch = join(workDir, basename(source));
copyFileSync(source, scratch);

const session = review.createSession(
  stubDownstream(),
  classify.EMPTY_OVERRIDES,
  types.EMPTY_WRONG_GROUP,
  { tdsRound100: false },
);
const dayBook = tdsDaybook.readDayBook(
  JSON.stringify({
    tallyAgentExport: 1,
    ...FY,
    groups: [
      { name: "Purchase Accounts", parent: " Primary" },
      { name: "Sales Accounts", parent: " Primary" },
      { name: "Sundry Creditors", parent: "Current Liabilities" },
      { name: "Current Liabilities", parent: " Primary" },
      { name: "Sundry Debtors", parent: "Current Assets" },
      { name: "Current Assets", parent: " Primary" },
      { name: "Duties & Taxes", parent: " Primary" },
      { name: "Bank Accounts", parent: "Current Assets" },
    ],
    ledgers: MASTERS.map((m) => ({ name: m.name, parent: m.parent })),
    vouchers: VOUCHERS,
  }),
  FY,
);
await session.tdsReview(COMPANY, FY.fromDate, FY.toDate, FY.toDate, OPERATOR, "json", undefined, dayBook);
const slice = session.tds3cdResult();
if (!slice) throw new Error("tdsReview did not cache a clause-34 slice");
if (slice.tds.length !== 2 || slice.tcs.length !== 1 || slice.returns.length !== 2) {
  throw new Error(`unexpected slice shape: tds=${slice.tds.length} tcs=${slice.tcs.length} returns=${slice.returns.length}`);
}
if (slice.skippedInterestQuarters.join() !== "Q2:26QE") {
  throw new Error(`expected the Q2:26QE skip, got ${JSON.stringify(slice.skippedInterestQuarters)}`);
}
console.error(`engine slice: ${slice.tds.length} TDS row(s) [${slice.tds.map((r) => r.section).join(", ")}], ` +
  `${slice.tcs.length} TCS row(s), ${slice.returns.length} return(s), ` +
  `interestTds=${slice.interestTds.length} interestTcs=${slice.interestTcs.length}, ` +
  `skipped [${slice.skippedInterestQuarters.join(", ")}]`);

const target = await session.write3cdTdsTcs({ sourcePath: scratch, outPath: workDir });
console.error(`filled copy written to ${target}`);

// ---- V1: re-read the schema and row values ----------------------------------

const written = xlsm.readXlsm(await readFileSync(target, null));
const check = (name, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  (${detail})`}`);
  return pass;
};

const SHEETS5 = ["TDS", "TCS", "Return details", "Interest on TDS", "Interest on TCS"];
const SCHEMA = {};
const ROWS = {};
for (const sheet of SHEETS5) {
  const schema = winman.readSchema(written, sheet);
  if (schema.formId !== "3cdTDS") throw new Error(`${sheet}: formId is "${schema.formId}", expected 3cdTDS`);
  SCHEMA[sheet] = schema;
  ROWS[sheet] = readWrittenRows(xlsm.partText(written, schema.partName))
    .filter((r) => r.r >= schema.firstDataRow)
    .sort((a, b) => a.r - b.r);
}

let ok = true;
for (const sheet of SHEETS5) {
  const count = sheet === "TDS" ? slice.tds.length
    : sheet === "TCS" ? slice.tcs.length
    : sheet === "Return details" ? slice.returns.length
    : sheet === "Interest on TDS" ? slice.interestTds.length
    : slice.interestTcs.length;
  ok = check(`V1 ${sheet}: formId 3cdTDS, ${count} data row(s) written at ${SCHEMA[sheet].firstDataRow}+`,
    ROWS[sheet].length === count, `found ${ROWS[sheet].length}`) && ok;
}

/** Pull the written data rows out of a rebuilt worksheet: inlineStr text or
 *  numeric `<v>` (dates are numeric serials; compare via xlsx serial). */
function readWrittenRows(xml) {
  const out = [];
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = Number(m[1]);
    const cells = new Map();
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"([^/>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1];
      const body = c[3] ?? "";
      const v = /<v>([^<]*)<\/v>/.exec(body);
      const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
      if (t) cells.set(col, decodeEntities(t[1]));
      else if (v) cells.set(col, v[1]);
    }
    out.push({ r, cells });
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function cellOf(row, col) { return row.cells.get(col); }
// zero-based column index -> spreadsheet letter
function colName(n) {
  let s = "";
  for (let i = n + 1; i > 0; ) { const rem = (i - 1) % 26; s = String.fromCharCode(65 + rem) + s; i = (i - rem - 1) / 26; }
  return s;
}
const Q = { Q1: "1", Q2: "2", Q3: "3", Q4: "4" };
const dserial = (ymd) => String(serial(ymd));

// --- dropdown membership (f) --------------------------------------------------
// TDS sheet C ∈ the 44-value section list; TCS sheet D ∈ the 13 natures;
// Return details C ∈ the 18 forms, D quarter = numeric 1-4, H ∈ Yes/No;
// Interest on TDS C ∈ the 5 forms; Interest on TCS C is exactly 27EQ.
const listChecks = [];
const colFor = (sheet, key) => {
  const col = SCHEMA[sheet].keys.get(key);
  if (col === undefined) throw new Error(`${sheet}: row-2 key ${key} missing`);
  return colName(col);
};
{
  const rs = ROWS["TDS"];
  const col = colFor("TDS", "TDS");
  const colNature = colFor("TDS", "NATUREOFPAYMENT");
  listChecks.push([`TDS col ${col} values in the 44-value section list`,
    rs.every((row) => TDS_DROPDOWN.includes(cellOf(row, col) ?? ""))]);
  listChecks.push([`TDS col ${colNature} nature text present`,
    rs.every((row) => (cellOf(row, colNature) ?? "").length > 0)]);
}
{
  const rs = ROWS["TCS"];
  const col = colFor("TCS", "NATUREOFRECEIPT");
  listChecks.push([`TCS col ${col} values in the 13-nature list`,
    rs.every((row) => TCS_NATURES.includes(cellOf(row, col) ?? ""))]);
  listChecks.push(["TCS has no keyed C column (unkeyed by row 2)", !SCHEMA["TCS"].keys.has("C")]);
}
{
  const rs = ROWS["Return details"];
  const colF = colFor("Return details", "FORMNO");
  const colQ = colFor("Return details", "QUARTER");
  const colAcc = colFor("Return details", "RETURNACCURATE");
  listChecks.push([`Return details col ${colF} values in the 18-form list`,
    rs.every((row) => RETURN_FORMS.includes(cellOf(row, colF) ?? ""))]);
  listChecks.push([`Return details col ${colQ} quarter cells are numeric literals 1-4`,
    rs.every((row) => ["1", "2", "3", "4"].includes(cellOf(row, colQ) ?? ""))]);
  listChecks.push([`Return details col ${colAcc} Return Accurate values in the Yes/No list`,
    rs.every((row) => ["Yes", "No"].includes(cellOf(row, colAcc) ?? ""))]);
}
{
  const rs = ROWS["Interest on TDS"];
  const colF = colFor("Interest on TDS", "FORMNO");
  listChecks.push([`Interest on TDS col ${colF} values in the 5-form list`,
    rs.every((row) => INTEREST_TDS_FORMS.includes(cellOf(row, colF) ?? ""))]);
}
{
  const rs = ROWS["Interest on TCS"];
  const colF = colFor("Interest on TCS", "FORMNO");
  listChecks.push([`Interest on TCS col ${colF} values are exactly 27EQ`,
    rs.every((row) => cellOf(row, colF) === "27EQ")]);
}
let dropPass = true;
for (const [label, pass] of listChecks) dropPass = check(label, pass, "value outside the dropdown") && dropPass;
ok = dropPass && ok;

// --- V1 row values equal the engine's cached clause-34 slice -------------------

const expected = {
  TDS: slice.tds.map((r) => ({
    A: r.deductor, B: slice.tan ?? "", C: r.section, D: r.nature,
    E: String(r.totalPayments), F: String(r.sumLiable), G: String(r.atRateLiable),
    H: String(r.atRateTds), I: String(r.lowerRateLiable), J: String(r.lowerRateTds),
    K: String(r.notDeposited),
  })),
  TCS: slice.tcs.map((r) => ({
    A: r.collector, B: slice.tan ?? "", D: r.nature, E: String(r.totalReceipt),
    F: String(r.sumLiable), G: String(r.atRateLiable), H: String(r.atRateTcs),
    I: String(r.lowerRateLiable), J: String(r.lowerRateTcs), K: String(r.notDeposited),
  })),
  "Return details": slice.returns.map((r) => ({
    A: r.deductor, B: slice.tan ?? "", C: r.form, D: Q[r.quarter],
    E: dserial(r.dueDate), F: dserial(r.filedOn), H: r.accurate,
  })),
  "Interest on TDS": slice.interestTds.map((r) => ({
    A: slice.company, B: slice.tan ?? "", C: r.form, D: Q[r.quarter],
    E: String(r.payable),
    F: r.paid === undefined ? undefined : String(r.paid),
    G: r.paidOn === undefined ? undefined : dserial(r.paidOn),
  })),
  "Interest on TCS": slice.interestTcs.map((r) => ({
    A: slice.company, B: slice.tan ?? "", C: "27EQ", D: Q[r.quarter],
    E: String(r.payable),
    F: r.paid === undefined ? undefined : String(r.paid),
    G: r.paidOn === undefined ? undefined : dserial(r.paidOn),
  })),
};

let rowsMatch = true;
for (const [sheet, want] of Object.entries(expected)) {
  const schema = SCHEMA[sheet];
  const got = ROWS[sheet];
  if (got.length !== want.length) { rowsMatch = false; continue; }
  for (let i = 0; i < want.length; i += 1) {
    const row = got[i];
    for (const [key, col] of schema.keys.entries()) {
      const letter = colName(col);
      const wantVal = want[i][letter];
      const gotVal = cellOf(row, letter);
      if (gotVal !== wantVal) {
        console.log(`      ${sheet} row ${row.r} ${letter}: got ${JSON.stringify(gotVal)}, expected ${JSON.stringify(wantVal)}`);
        rowsMatch = false;
      }
    }
  }
}
{
  const row = ROWS["TCS"][0];
  rowsMatch = check("TCS written row skips the unkeyed C column", cellOf(row, "C") === undefined,
    `C=${JSON.stringify(cellOf(row, "C"))}`) && rowsMatch;
}
ok = check("V1 written rows equal the engine's cached clause-34 slice", rowsMatch, "see mismatches above") && ok;

// ---- (b1) style-twin resolution for s89 s90 s91 s98 s100 s101 -----------------
// resolveStyleTwins finds each prototype xf its quotePrefix-stripped twin, or
// appends a stripped copy. PF/ESI workbooks carry the twins already; whether
// this workbook does decides the write's behaviour, so log which path was
// taken per target id from that TODO.

const sourceStyles2 = (() => {
  const pkg = xlsm.readXlsm(readFileSync(scratch));
  const e = pkg.entries.find((x) => x.name === "xl/styles.xml");
  return e ? xlsm.partText(pkg, e.name) : "";
})();

const protoIds = [];
for (const schema of Object.values(SCHEMA)) {
  for (const id of schema.prototypeStyles.values()) if (!protoIds.includes(id)) protoIds.push(id);
}
const stylesXml = sourceStyles2;
const countAttr = /<cellXfs\b[^>]*\bcount="(\d+)"/.exec(stylesXml);
const nXfs = countAttr ? Number(countAttr[1]) : 0;
let twins = new Map();
try {
  const r = winman.resolveStyleTwins(stylesXml, protoIds);
  twins = r.twins;
} catch (e) {
  ok = check("style-twin resolution completes", false, String(e)) && ok;
}
console.log("style-twin resolution (targets s89 s90 s91 s98 s100 s101):");
for (const target of ([89, 90, 91, 98, 100, 101])) {
  if (!protoIds.includes(target)) {
    console.log(`  s${target}: not a prototype style of the five sheets`);
    continue;
  }
  const twin = twins.get(target);
  let path;
  if (twin === target) path = "identity (prototype carries no quotePrefix)";
  else if (twin >= nXfs) path = `appended stripped copy -> s${twin}`;
  else path = `existing twin found: maps to s${twin}`;
  console.log(`  s${target}: ${path}`);
}
{
  const writtenStyles = (() => {
    const e = written.entries.find((x) => x.name === "xl/styles.xml");
    return e ? xlsm.partText(written, e.name) : "";
  })();
  const wc = /<cellXfs\b[^>]*\bcount="(\d+)"/.exec(writtenStyles);
  const shouldAppend = [...protoIds].some((id) => twins.get(id) >= nXfs && twins.get(id) !== id);
  ok = check("written cellXfs count bumped iff a stripped copy was appended",
    shouldAppend ? Number(wc?.[1] ?? 0) === nXfs + [...protoIds].filter((id) => twins.get(id) >= nXfs && twins.get(id) !== id).length
                : Number(wc?.[1] ?? 0) === nXfs,
    `source count ${nXfs}, written count ${wc?.[1]}`) && ok;
}

// ---- V2: Excel COM ----------------------------------------------------------

if (ok) {
  const res = runExcel(target);
  if (res.error) {
    ok = check("V2 Excel COM run", false, res.error) && false;
  } else {
    const EXPECTED_SHEETS = 18;
    ok = check(`V2 sheets == ${EXPECTED_SHEETS}`, res.sheets === EXPECTED_SHEETS, `got ${res.sheets}`) && ok;
    ok = check("V2 TDS visible after WorkBook_UnhideSheets", res.tdsVisible === true, `got ${res.tdsVisible}`) && ok;
    for (const [sheet, key] of [["TDS", "validTds"], ["TCS", "validTcs"], ["Return details", "validRet"],
      ["Interest on TDS", "validIntTds"], ["Interest on TCS", "validIntTcs"]]) {
      ok = check(`V2 ValidateMandatoryFields(${sheet})`, res[key] === true, `got ${res[key]}`) && ok;
    }
  }
} else {
  console.log("V2 skipped: V1 failed");
}

if (ok) console.log("ROUNDTRIP_OK V1+V2");
else console.log("ROUNDTRIP_FAIL");
process.exit(ok ? 0 : 1);

// Two Excel-from-WSL traps, both found live on the PF/ESI twin script and
// reused verbatim here:
//  1. Do NOT call $wb.Close after ValidateMandatoryFields has run — on Excel
//     16.0 that call hangs indefinitely; $xl.Quit() alone releases it.
//  2. $xl.Quit() returns but the EXCEL.EXE process lingers — capture the PID
//     from the window handle and force-kill only our own instance (never by
//     image name; the operator may have other workbooks open).
function runExcel(path) {
  const winPath = toWindowsPath(path);
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
"@
$xl = $null; $xlPid = 0
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false; $xl.DisplayAlerts = $false
  $xl.AutomationSecurity = 1     # msoAutomationSecurityLow: let the project load
  [W32]::GetWindowThreadProcessId([IntPtr]$xl.Hwnd, [ref]$xlPid) | Out-Null
  $wb = $xl.Workbooks.Open('${winPath}')
  $res = @{ sheets = $wb.Sheets.Count }
  $wb.Application.Run('WorkBook_UnhideSheets')
  $res.tdsVisible = ($wb.Sheets('TDS').Visible -eq -1)
  $res.validTds    = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('TDS'))
  $res.validTcs    = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('TCS'))
  $res.validRet    = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('Return details'))
  $res.validIntTds = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('Interest on TDS'))
  $res.validIntTcs = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('Interest on TCS'))
  $res.lastRow = $wb.Sheets('TDS').UsedRange.Rows.Count + $wb.Sheets('TDS').UsedRange.Row - 1
  $res | ConvertTo-Json -Compress
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 3
} finally {
  if ($xl) { $xl.Quit() }
  if ($xlPid -gt 0) {
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $xlPid -ErrorAction SilentlyContinue) { Stop-Process -Id $xlPid -Force -ErrorAction SilentlyContinue }
  }
  [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
}
`;
  let raw;
  try {
    raw = execFileSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000,
    });
  } catch (err) {
    if (err && err.status === 3 && err.stdout) raw = err.stdout;
    else {
      console.error("error: PowerShell/Excel invocation failed");
      if (err && err.stdout) console.error(String(err.stdout));
      if (err && err.stderr) console.error(String(err.stderr));
      process.exit(1);
    }
  }
  const line = String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    console.error("error: could not parse Excel result:");
    console.error(raw);
    process.exit(1);
  }
}

// Translate a WSL path to something the Windows Excel process can open.
// /mnt/<d> becomes <D>:\...; anything else rides the WSL 9p share.
function toWindowsPath(p) {
  const abs = resolve(p);
  const drive = /^\/mnt\/([a-zA-Z])(?:\/|$)/.exec(abs);
  if (drive) return `${drive[1].toUpperCase()}:\\${abs.slice(7).split("/").join("\\")}`;
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  return `\\\\wsl.localhost\\${distro}\\${abs.slice(1).split("/").join("\\")}`;
}
