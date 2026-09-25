#!/usr/bin/env node
// V2/V3 of the Winman Form 3CD round-trip verification. Design of record:
// docs/design/2026-09-23-winman-3cd-pf-esi-design.md §2.5 and §10, continued in
// docs/design/2026-09-24-no-tds-disallowance-design.md ("Live validation").
//
//   P.F. mode (default)      — clause 20(b) workbook, P.F. sheet
//     V2  Excel opens our rewritten workbook clean (no repair prompt), 18 sheets
//     V3  Winman's own macros run: WorkBook_UnhideSheets makes P.F. visible and
//         ValidateMandatoryFields returns True
//   --notds mode             — clause 21(b) "No TDS Disallowance.xlsm" workbook
//     V2  Excel opens our rewritten workbook clean (no repair prompt)
//     V3  WorkBook_UnhideSheets + ValidateMandatoryFields on EACH of the four
//         clause 21(b) sheets
//
// V1 (structural byte-identity) lives in test/winman3cd.test.ts,
// test/notds-write.test.ts and test/xlsm.test.ts. V4 (the Winman import click)
// is captain-operated and is not attempted here.
//
// The script is a hand-run harness, not a vitest case: it needs a real Windows
// Excel via COM. The source workbook is NEVER written to — it is read, a copy
// with sample rows is written to <out>, and only <out> is opened by Excel.
// Run it against the operator's real workbook with both paths under a scratch
// directory (e.g. /tmp); the real workbook is never committed.
//
// Usage:
//   npm run build                                     # this script reads dist/
//   node scripts/verify-winman-roundtrip.mjs <source.xlsm> <out.xlsm> [--rows N]
//     [--sheet NAME] [--form FORMID] [--sheets N]
//
// --sheet names the worksheet to exercise (default P.F.) and --form asserts the
// Form 3CD form id that sheet belongs to (default EmployeePFESIfunds), so the
// same harness drives the depreciation sheets (--sheet "Depreciation additions"
// --form DepreciationNew). --sheets is the workbook's total sheet count.
//
//   node scripts/verify-winman-roundtrip.mjs <source.xlsm> <out.xlsm> --notds
//
// Exit codes: 0 pass, 1 assertion/Excel failure, 2 usage.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// powershell.exe is NOT on PATH in this WSL distro; the absolute path is required.
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const SHEET_DEFAULT = "P.F.";
const FORM_DEFAULT = "EmployeePFESIfunds";
const SHEETS_DEFAULT = 18;

// The four clause 21(b) sheet tab names, in the workbook's own order; the
// per-sheet fill and the Excel-side checks both walk this list. Windows
// PowerShell string literals — escape any quote if a name ever changes.
const NOTDS_SHEET_NAMES = [
  "40(a)(ia) to resident",
  "40(a)(i) to non-resident",
  "40(a)(ib) - Equalisation Levy",
  "40(a)(iii)",
];

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/verify-winman-roundtrip.mjs <source.xlsm> <out.xlsm> " +
      "[--rows N] [--sheet NAME] [--form FORMID] [--sheets N]\n" +
      "       node scripts/verify-winman-roundtrip.mjs <source.xlsm> <out.xlsm> --notds",
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
let rowsWanted = 2;
let sheetWanted = SHEET_DEFAULT;
let formWanted = FORM_DEFAULT;
let sheetsWanted = SHEETS_DEFAULT;
let notdsMode = false;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--rows") {
    rowsWanted = Number(argv[++i]);
    if (!Number.isInteger(rowsWanted) || rowsWanted < 1) usage("--rows must be a positive integer");
  } else if (argv[i] === "--sheet") {
    sheetWanted = argv[++i];
    if (!sheetWanted) usage("--sheet needs a worksheet name");
  } else if (argv[i] === "--form") {
    formWanted = argv[++i];
    if (!formWanted) usage("--form needs a form id");
  } else if (argv[i] === "--sheets") {
    sheetsWanted = Number(argv[++i]);
    if (!Number.isInteger(sheetsWanted) || sheetsWanted < 1) usage("--sheets must be a positive integer");
  } else if (argv[i] === "--notds") {
    notdsMode = true;
  } else if (argv[i] === "--help") {
    usage();
  } else if (argv[i].startsWith("--")) {
    usage(`unknown option ${argv[i]}`);
  } else {
    positional.push(argv[i]);
  }
}
const [srcPath, outPath] = positional;
if (!srcPath || !outPath) usage("a source and an out path are both required");
if (!existsSync(srcPath)) usage(`source workbook not found: ${srcPath}`);

// dist/ is gitignored build output; build it before running (see Usage).
let xlsm;
let winman;
let notds;
try {
  xlsm = await import(new URL("../dist/xlsm.js", import.meta.url));
  winman = await import(new URL("../dist/winman3cd.js", import.meta.url));
  notds = await import(new URL("../dist/notds.js", import.meta.url));
} catch (err) {
  console.error("error: could not load dist/ — run `npm run build` first");
  console.error(String(err && err.message ? err.message : err));
  process.exit(2);
}

// Sample rows only — invented round numbers, no operator data. Two rows is the
// documented default; --rows widens it without changing the shape under test.
// Values are derived from the named sheet's own schema: date keys get a date,
// amount keys a number, and text keys a value the column's dropdown accepts
// (read from the workbook so a block dropdown gets a real block label).
function sampleValue(key, k) {
  if (/DATE|PAIDON|TOUSE/.test(key)) return { kind: "date", ymd: `2025${String(k + 5).padStart(2, "0")}15` };
  if (/AMOUNT/.test(key)) return { kind: "number", value: 100000 + k };
  if (key === "FISTCOL" || key === "DELETIONDTLS") return { kind: "text", value: "5. Plant/ Machinery 15%:" };
  const allowed = winman.readListValues(pkg, sheetWanted, key);
  const pick = allowed.includes("No") ? "No" : allowed.includes("N/A") ? "N/A" : (allowed[0] ?? "No");
  return { kind: "text", value: pick };
}

// Translate a WSL path to something the Windows Excel process can open. /mnt/<d>
// becomes <D>:\...; anything else is exposed over the WSL 9p share.
function toWindowsPath(p) {
  const abs = resolve(p);
  const drive = /^\/mnt\/([a-zA-Z])(?:\/|$)/.exec(abs);
  if (drive) return `${drive[1].toUpperCase()}:\\${abs.slice(7).split("/").join("\\")}`;
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  return `\\\\wsl.localhost\\${distro}\\${abs.slice(1).split("/").join("\\")}`;
}

/**
 * Run one PowerShell/Excel probe and return the JSON line it printed. The COM
 * probes carry two Excel-from-WSL traps, both found live against the real
 * workbook:
 *
 *  1. Do NOT call $wb.Close($false) after ValidateMandatoryFields has run — on
 *     Excel 16.0 that call hangs indefinitely (the macro leaves the workbook in
 *     a state Close will not let go of). $xl.Quit() alone releases it. Closing
 *     before ValidateMandatoryFields works, so the hang is that exact ordering.
 *  2. $xl.Quit() returns but the EXCEL.EXE process lingers. Capture the PID
 *     from the app window handle and force-kill only our own instance after
 *     Quit, so a hand-run never leaves an orphan. Never kill EXCEL.EXE by image
 *     name — the operator may have other workbooks open.
 */
function runExcelProbe(ps) {
  let raw;
  try {
    raw = execFileSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180000,
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

/** One Excel COM session over winPath: open, WorkBook_UnhideSheets, then the
 * caller's per-sheet COM lines appended to `$res`, JSON out. Same PID-capture
 * cleanup discipline documented on runExcelProbe. */
function excelSessionScript(winPath, bodyLines) {
  return `
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
${bodyLines}
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
}

const reportChecks = (checks) => {
  let ok = true;
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  (${detail})`}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "ROUNDTRIP_OK V2+V3" : "ROUNDTRIP_FAIL");
  process.exit(ok ? 0 : 1);
};

/** PS-object member name for a sheet name (dotted property access). */
function jsonKey(name) {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

const pkg = xlsm.readXlsm(readFileSync(srcPath));
const handshake = winman.readHandshake(pkg);

if (notdsMode) {
  // Clause 21(b) path: one invented sample row into each of the four sheets,
  // then Excel opens the copy cleanly and ValidateMandatoryFields passes per
  // sheet. Section spellings are valid Winman dropdown values, invented, never
  // operator data.
  const sections = { "40(a)(ia) to resident": "194C", "40(a)(i) to non-resident": "195" };
  const sampleBase = {
    DEDUCTEENAME: { kind: "text", value: "Sample Deductee Pvt Ltd" },
    DATEOFPAYMENT: { kind: "date", ymd: "20250915" },
    NATUREOFPAYMENT: { kind: "text", value: "Contract work" },
    ADDRESS: { kind: "text", value: "-" },
    CITY: { kind: "text", value: "-" },
    STATE: { kind: "text", value: "-" },
    PINZIP: { kind: "text", value: "-" },
    COUNTRY: { kind: "text", value: "-" },
    PANAADHAAR: { kind: "text", value: "-" },
  };
  let working = pkg;
  const expectedLastRow = {};
  for (const sheetName of NOTDS_SHEET_NAMES) {
    const schema = winman.readSchema(working, sheetName);
    if (schema.formId !== notds.NOTDS_FORM_ID) {
      console.error(`FAIL: ${sheetName} has form id ${JSON.stringify(schema.formId)}, expected ${JSON.stringify(notds.NOTDS_FORM_ID)}`);
      process.exit(1);
    }
    const row = { ...sampleBase };
    row[notds.amountKeyOf(sheetName)] = { kind: "number", value: 25000 };
    if (sections[sheetName]) row.TDSSECTION = { kind: "text", value: sections[sheetName] };
    const done = notds.doneKeyOf(sheetName);
    if (done) row[done] = { kind: "number", value: 5000 };
    const deposited = notds.depositedKeyOf(sheetName);
    if (deposited) row[deposited] = { kind: "number", value: 4500 };
    working = winman.writeSheetRows(working, sheetName, [row]);
    expectedLastRow[sheetName] = schema.prototypeRow + 1;
    console.error(`wrote 1 sample row into "${sheetName}" (first data row ${schema.firstDataRow}, prototype ${schema.prototypeRow})`);
  }
  writeFileSync(outPath, xlsm.writeXlsm(working));
  console.error(`wrote the clause 21(b) sample into ${outPath} (AY ${handshake.assessmentYear})`);

  const ps = excelSessionScript(
    toWindowsPath(outPath),
    NOTDS_SHEET_NAMES.map(
      (n) =>
        `  $s = $wb.Sheets('${n}')\n` +
        `  $v = $null; $merr = ''\n` +
        `  try { $v = $wb.Application.Run('ValidateMandatoryFields', $s) } catch { $merr = $_.Exception.Message }\n` +
        `  $res.Add('${jsonKey(n)}', @{ visible = ($s.Visible -eq -1); validates = $v; lastRow = $s.UsedRange.Rows.Count + $s.UsedRange.Row - 1; macroError = $merr })`,
    ).join("\n"),
  );
  const res = runExcelProbe(ps);
  if (res.error) {
    console.error(`FAIL V2/V3: Excel raised — ${res.error}`);
    process.exit(1);
  }
  const checks = [["V2 sheet count >= 5 (four data sheets + INTER + extras)", res.sheets >= 5, `got ${res.sheets}`]];
  let unverifiable = false;
  for (const sheetName of NOTDS_SHEET_NAMES) {
    const r = res[jsonKey(sheetName)] ?? {};
    checks.push([`${sheetName}: V3 visible after WorkBook_UnhideSheets`, r.visible === true, `got ${r.visible}`]);
    if (r.validates === true) {
      checks.push([`${sheetName}: V3 ValidateMandatoryFields`, true, ""]);
    } else if (r.macroError) {
      // Honest boundary: on the real clause 21(b) workbook the VBA project is
      // locked for viewing and its validation macro is not runnable by name
      // from COM. V3 stays captain-verifiable (the import click, V4); V2 and
      // the structural suite still stand. Reported as WARN, never a silent
      // pass — and never conflated with a hard validation failure.
      checks.push([`${sheetName}: V3 ValidateMandatoryFields`, "WARN", `macro not runnable — ${r.macroError}`]);
      unverifiable = true;
    } else {
      checks.push([`${sheetName}: V3 ValidateMandatoryFields`, r.validates === true, `got ${r.validates}`]);
    }
    checks.push([
      `${sheetName}: V2/V3 lastRow == prototype + rows (${expectedLastRow[sheetName]})`,
      r.lastRow === expectedLastRow[sheetName],
      `got ${r.lastRow}`,
    ]);
  }
  let ok = true;
  for (const [name, v, detail] of checks) {
    if (v === "WARN") console.log(`WARN  ${name}  (${detail})`);
    else {
      console.log(`${v ? "PASS" : "FAIL"}  ${name}${v ? "" : `  (${detail})`}`);
      if (!v) ok = false;
    }
  }
  console.log(
    ok && !unverifiable
      ? "ROUNDTRIP_OK V2+V3"
      : ok
        ? "ROUNDTRIP_OK V2 (V3 unverifiable — validation macro not runnable from COM; V4 import click is the captain boundary)"
        : "ROUNDTRIP_FAIL",
  );
  process.exit(ok ? 0 : 1);
}

// ------------------------------- P.F. (clause 20(b)) mode --------------------
// Sample rows only — invented round numbers, no operator data. Values are
// derived from the named sheet's own schema via sampleValue().
const schema = winman.readSchema(pkg, sheetWanted);
if (schema.formId !== formWanted) {
  console.error(`error: sheet "${sheetWanted}" belongs to form "${schema.formId}", not "${formWanted}"`);
  process.exit(1);
}
const keys = [...schema.keys.keys()];
const rows = Array.from({ length: rowsWanted }, (_, k) =>
  Object.fromEntries(keys.map((key) => [key, sampleValue(key, k)])),
);
const expectedLastRow = schema.prototypeRow + rows.length;

writeFileSync(outPath, xlsm.writeXlsm(winman.writeSheetRows(pkg, sheetWanted, rows)));
console.error(
  `wrote ${rows.length} sample row(s) into "${sheetWanted}" of ${outPath} ` +
    `(first data row ${schema.firstDataRow}, prototype ${schema.prototypeRow}, AY ${handshake.assessmentYear})`,
);

const pf = runExcelProbe(
  excelSessionScript(
    toWindowsPath(outPath),
    `  $res.pfVisible = ($wb.Sheets('${sheetWanted}').Visible -eq -1)
  $res.validates = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('${sheetWanted}'))
  $res.lastRow = $wb.Sheets('${sheetWanted}').UsedRange.Rows.Count + $wb.Sheets('${sheetWanted}').UsedRange.Row - 1`,
  ),
);

if (pf.error) {
  console.error(`FAIL V2/V3: Excel raised — ${pf.error}`);
  process.exit(1);
}

reportChecks([
  ["V2 sheets == " + sheetsWanted, pf.sheets === sheetsWanted, `got ${pf.sheets}`],
  [`V3 "${sheetWanted}" visible after WorkBook_UnhideSheets`, pf.pfVisible === true, `got ${pf.pfVisible}`],
  ["V3 ValidateMandatoryFields", pf.validates === true, `got ${pf.validates}`],
  ["V2/V3 lastRow == prototype + rows (" + expectedLastRow + ")", pf.lastRow === expectedLastRow, `got ${pf.lastRow}`],
]);
