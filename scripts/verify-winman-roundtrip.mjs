#!/usr/bin/env node
// V2/V3 of the Winman Form 3CD round-trip verification. Design of record:
// docs/design/2026-09-23-winman-3cd-pf-esi-design.md §2.5 and §10.
//
//   V2  Excel opens our rewritten workbook clean (no repair prompt), 18 sheets
//   V3  Winman's own macros run: WorkBook_UnhideSheets makes P.F. visible and
//       ValidateMandatoryFields returns True
//
// V1 (structural byte-identity) lives in test/winman3cd.test.ts and
// test/xlsm.test.ts. V4 (the Winman import click) is captain-operated and is
// not attempted here.
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
//
// Exit codes: 0 pass, 1 assertion/Excel failure, 2 usage.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// powershell.exe is NOT on PATH in this WSL distro; the absolute path is required.
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const SHEET = "P.F.";
const EXPECTED_SHEETS = 18;

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node scripts/verify-winman-roundtrip.mjs <source.xlsm> <out.xlsm> [--rows N]");
  process.exit(2);
}

const argv = process.argv.slice(2);
let rowsWanted = 2;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--rows") {
    rowsWanted = Number(argv[++i]);
    if (!Number.isInteger(rowsWanted) || rowsWanted < 1) usage("--rows must be a positive integer");
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
try {
  xlsm = await import(new URL("../dist/xlsm.js", import.meta.url));
  winman = await import(new URL("../dist/winman3cd.js", import.meta.url));
} catch (err) {
  console.error("error: could not load dist/ — run `npm run build` first");
  console.error(String(err && err.message ? err.message : err));
  process.exit(2);
}

// Sample rows only — invented round numbers, no operator data. Two rows is the
// documented default; --rows widens it without changing the shape under test.
const sample = (due, paid, amount) => ({
  DUEDATE: { kind: "date", ymd: due },
  PAIDON: { kind: "date", ymd: paid },
  AMOUNTPAID: { kind: "number", value: amount },
  AMOUNTCOLLECTED: { kind: "number", value: amount },
});
const rows = Array.from({ length: rowsWanted }, (_, k) =>
  sample(`2025${String(k + 5).padStart(2, "0")}15`, `2025${String(k + 5).padStart(2, "0")}14`, 100000 + k),
);

const pkg = xlsm.readXlsm(readFileSync(srcPath));
const schema = winman.readSchema(pkg, SHEET);
const handshake = winman.readHandshake(pkg);
const expectedLastRow = schema.prototypeRow + rows.length;

writeFileSync(outPath, xlsm.writeXlsm(winman.writeSheetRows(pkg, SHEET, rows)));
console.error(
  `wrote ${rows.length} sample row(s) into "${SHEET}" of ${outPath} ` +
    `(first data row ${schema.firstDataRow}, prototype ${schema.prototypeRow}, AY ${handshake.assessmentYear})`,
);

// Translate a WSL path to something the Windows Excel process can open. /mnt/<d>
// becomes <D>:\...; anything else is exposed over the WSL 9p share.
function toWindowsPath(p) {
  const abs = resolve(p);
  const drive = /^\/mnt\/([a-zA-Z])(?:\/|$)/.exec(abs);
  if (drive) return `${drive[1].toUpperCase()}:\\${abs.slice(7).split("/").join("\\")}`;
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  return `\\\\wsl.localhost\\${distro}\\${abs.slice(1).split("/").join("\\")}`;
}

const winPath = toWindowsPath(outPath);
// Two Excel-from-WSL traps, both found live against the real workbook:
//
//  1. Do NOT call $wb.Close($false) after ValidateMandatoryFields has run — on
//     Excel 16.0 that call hangs indefinitely (the macro leaves the workbook in
//     a state Close will not let go of). $xl.Quit() alone releases it. Closing
//     before ValidateMandatoryFields works, so the hang is that exact ordering.
//  2. $xl.Quit() returns but the EXCEL.EXE process lingers. Capture the PID
//     from the app window handle and force-kill only our own instance after
//     Quit, so a hand-run never leaves an orphan. Never kill EXCEL.EXE by image
//     name — the operator may have other workbooks open.
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
  $res.pfVisible = ($wb.Sheets('${SHEET}').Visible -eq -1)
  $res.validates = $wb.Application.Run('ValidateMandatoryFields', $wb.Sheets('${SHEET}'))
  $res.lastRow = $wb.Sheets('${SHEET}').UsedRange.Rows.Count + $wb.Sheets('${SHEET}').UsedRange.Row - 1
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
let res;
try {
  res = JSON.parse(line);
} catch {
  console.error("error: could not parse Excel result:");
  console.error(raw);
  process.exit(1);
}

if (res.error) {
  console.error(`FAIL V2/V3: Excel raised — ${res.error}`);
  process.exit(1);
}

const checks = [
  ["V2 sheets == " + EXPECTED_SHEETS, res.sheets === EXPECTED_SHEETS, `got ${res.sheets}`],
  ["V3 P.F. visible after WorkBook_UnhideSheets", res.pfVisible === true, `got ${res.pfVisible}`],
  ["V3 ValidateMandatoryFields", res.validates === true, `got ${res.validates}`],
  ["V2/V3 lastRow == prototype + rows (" + expectedLastRow + ")", res.lastRow === expectedLastRow, `got ${res.lastRow}`],
];

let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  (${detail})`}`);
  if (!pass) ok = false;
}
console.log(ok ? "ROUNDTRIP_OK V2+V3" : "ROUNDTRIP_FAIL");
process.exit(ok ? 0 : 1);
