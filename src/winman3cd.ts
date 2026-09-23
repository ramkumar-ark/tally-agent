import { partText, type XlsmPackage } from "./xlsm.js";

/**
 * Reader half of the Winman Form 3CD round trip. Every Winman 3CD sheet is
 * self-describing: row 1 carries the form id, the sheet key, the first data
 * row and Winman's internal field path; row 2 carries the machine column keys
 * that are the real contract (never the human header); row `C1`-1 is a hidden
 * all-'-' prototype row whose styles a data row must use. A hidden `INTER`
 * sheet carries the protocol handshake. Nothing here is documented by Winman —
 * design of record: docs/design/2026-09-23-winman-3cd-pf-esi-design.md §2.
 *
 * This module deliberately does not reuse src/xlsx-read.ts: the two read
 * different, independent things and a shared bug would be invisible.
 */

export interface WinmanSchema {
  sheetName: string;
  partName: string;
  formId: string;
  sheetKey: string;
  firstDataRow: number;
  fieldPath: string;
  /** row-2 machine key -> zero-based column index. */
  keys: Map<string, number>;
  /** zero-based column index -> the prototype row's style id. */
  prototypeStyles: Map<number, number>;
  prototypeRow: number;
}

export interface WinmanHandshake {
  marker: string;
  version: string;
  build: string;
  assessmentYear: string;
  validationOn: boolean;
}

const MARKER = "$WiNsArAlXlImPoRt2$";

const NOT_WINMAN = "not a Winman 3CD workbook";

// ------------------------------------------------------------- pull tokenizer

type Token =
  | { kind: "open" | "self"; name: string; attrs: Map<string, string> }
  | { kind: "close"; name: string }
  | { kind: "text"; value: string };

const NAME_STOP = /[\s/>]/;

function decodeXml(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole: string, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: return whole;
    }
  });
}

/** A char-scanning pull tokenizer. Never a regex over the document structure. */
function* tokenize(xml: string): Generator<Token> {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      yield { kind: "text", value: decodeXml(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { kind: "text", value: decodeXml(xml.slice(i, lt)) };

    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith("<?", lt)) { const e = xml.indexOf("?>", lt); i = e < 0 ? n : e + 2; continue; }
    if (xml.startsWith("<!", lt)) { const e = xml.indexOf(">", lt); i = e < 0 ? n : e + 1; continue; }

    const closing = xml[lt + 1] === "/";
    let j = lt + (closing ? 2 : 1);
    let end = j;
    while (end < n && !NAME_STOP.test(xml[end])) end += 1;
    const name = xml.slice(j, end);

    if (closing) {
      const e = xml.indexOf(">", end);
      yield { kind: "close", name };
      i = e < 0 ? n : e + 1;
      continue;
    }

    const attrs = new Map<string, string>();
    j = end;
    for (;;) {
      while (j < n && /\s/.test(xml[j])) j += 1;
      if (j >= n) { i = n; break; }
      if (xml[j] === ">") { yield { kind: "open", name, attrs }; i = j + 1; break; }
      if (xml[j] === "/" && xml[j + 1] === ">") { yield { kind: "self", name, attrs }; i = j + 2; break; }
      const eq = xml.indexOf("=", j);
      if (eq < 0) { i = n; break; }
      const key = xml.slice(j, eq).trim();
      const quote = xml[eq + 1];
      const qe = xml.indexOf(quote, eq + 2);
      if (qe < 0) { i = n; break; }
      attrs.set(key, decodeXml(xml.slice(eq + 2, qe)));
      j = qe + 1;
    }
  }
}

// ------------------------------------------------------------- shared strings

function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let si = "";
  let sink = false;
  let t = "";
  for (const tok of tokenize(xml)) {
    if (tok.kind === "text") { if (sink) t += tok.value; continue; }
    if (tok.kind === "open" && tok.name === "si") { si = ""; continue; }
    if (tok.kind === "open" && tok.name === "t") { sink = true; t = ""; continue; }
    if (tok.kind === "close" && tok.name === "t") { si += t; sink = false; continue; }
    if (tok.kind === "close" && tok.name === "si") out.push(si);
  }
  return out;
}

// ----------------------------------------------------------------- sheet rows

interface Cell { style: number; value: string }

function columnOf(ref: string): number {
  let k = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i) & ~0x20; // uppercase A-Z
    if (c < 65 || c > 90) break;
    k = k * 26 + (c - 64);
  }
  return k - 1;
}

function resolveValue(type: string, v: string, inline: string, strings: string[]): string {
  if (type === "s") {
    const idx = Number(v);
    return Number.isInteger(idx) && idx >= 0 && idx < strings.length ? strings[idx] : "";
  }
  if (type === "inlineStr") return inline;
  return v;
}

/** One streaming pass over the sheet, materialising only the wanted rows. */
function readRows(xml: string, wanted: Set<number>, strings: string[]): Map<number, Map<number, Cell>> {
  const out = new Map<number, Map<number, Cell>>();
  const max = Math.max(...wanted);
  let row = -1;
  let cells: Map<number, Cell> | null = null;
  let col = -1;
  let style = 0;
  let type = "n";
  let sink: "v" | "t" | null = null;
  let v = "";
  let t = "";
  let inline = "";
  let insideIs = false;

  for (const tok of tokenize(xml)) {
    if (tok.kind === "text") {
      if (sink === "v") v += tok.value;
      else if (sink === "t") t += tok.value;
      continue;
    }
    if (tok.kind === "open" || tok.kind === "self") {
      const self = tok.kind === "self";
      switch (tok.name) {
        case "row":
          row = Number(tok.attrs.get("r") ?? "");
          cells = wanted.has(row) ? new Map() : null;
          if (cells) out.set(row, cells);
          col = -1;
          break;
        case "c":
          if (!cells) break;
          col = tok.attrs.has("r") ? columnOf(tok.attrs.get("r")!) : col + 1;
          style = Number(tok.attrs.get("s") ?? "0") || 0;
          type = tok.attrs.get("t") ?? "n";
          v = ""; t = ""; inline = ""; insideIs = false;
          if (self) cells.set(col, { style, value: "" });
          break;
        case "v": sink = "v"; v = ""; break;
        case "t": sink = "t"; t = ""; break;
        case "is": insideIs = true; break;
        default: break;
      }
      if (self) {
        if (tok.name === "v") sink = null;
        else if (tok.name === "t") { if (insideIs) inline += t; sink = null; }
        else if (tok.name === "is") insideIs = false;
      }
      continue;
    }
    switch (tok.name) {
      case "v": sink = null; break;
      case "t": if (insideIs) inline += t; sink = null; break;
      case "is": insideIs = false; break;
      case "c": if (cells) cells.set(col, { style, value: resolveValue(type, v, inline, strings) }); break;
      case "row":
        if (row >= max) return out;
        cells = null;
        break;
      default: break;
    }
  }
  return out;
}

function valueAt(cells: Map<number, Cell> | undefined, col: number): string {
  return cells?.get(col)?.value ?? "";
}

// ----------------------------------------------------------- package plumbing

function normalizeTarget(target: string): string {
  const t = target.startsWith("/") ? target.slice(1) : target;
  return t.startsWith("xl/") ? t : `xl/${t}`;
}

/** Resolve a sheet name to its part through workbook.xml + the workbook rels. */
function resolveSheetPart(pkg: XlsmPackage, sheetName: string): string {
  const workbook = partText(pkg, "xl/workbook.xml");
  const rels = partText(pkg, "xl/_rels/workbook.xml.rels");
  const byId = new Map<string, string>();
  for (const tok of tokenize(rels)) {
    if ((tok.kind === "self" || tok.kind === "open") && tok.name === "Relationship") {
      const id = tok.attrs.get("Id");
      const target = tok.attrs.get("Target");
      if (id && target) byId.set(id, target);
    }
  }
  for (const tok of tokenize(workbook)) {
    if ((tok.kind === "self" || tok.kind === "open") && tok.name === "sheet" && tok.attrs.get("name") === sheetName) {
      const target = byId.get(tok.attrs.get("r:id") ?? "");
      if (!target) throw new Error(`${NOT_WINMAN}: sheet "${sheetName}" has no worksheet part`);
      return normalizeTarget(target);
    }
  }
  throw new Error(`${NOT_WINMAN}: no sheet named "${sheetName}"`);
}

function sharedStringsOf(pkg: XlsmPackage): string[] {
  const e = pkg.entries.find((x) => x.name === "xl/sharedStrings.xml");
  return e ? readSharedStrings(partText(pkg, e.name)) : [];
}

// ------------------------------------------------------------------- the API

/**
 * Read the self-describing import schema from one Winman data sheet. The sheet
 * name is looked up through the workbook rels, never assumed from its ordinal.
 */
export function readSchema(pkg: XlsmPackage, sheetName: string): WinmanSchema {
  const partName = resolveSheetPart(pkg, sheetName);
  const xml = partText(pkg, partName);
  const strings = sharedStringsOf(pkg);

  const row1 = readRows(xml, new Set([1]), strings).get(1);
  const formId = valueAt(row1, 0);
  const sheetKey = valueAt(row1, 1);
  const firstRaw = valueAt(row1, 2).trim();
  const firstDataRow = Number(firstRaw);
  if (!/^\d+$/.test(firstRaw) || !Number.isInteger(firstDataRow) || firstDataRow < 1) {
    throw new Error(`${NOT_WINMAN}: ${sheetName} C1 is not the first data row (got ${JSON.stringify(firstRaw)})`);
  }
  const fieldPath = valueAt(row1, 3);
  const prototypeRow = firstDataRow - 1;

  const rest = readRows(xml, new Set([2, prototypeRow]), strings);
  const keys = new Map<string, number>();
  for (const [col, cell] of rest.get(2) ?? []) {
    const key = cell.value.trim();
    if (key) keys.set(key, col);
  }
  if (keys.size === 0) throw new Error(`${NOT_WINMAN}: ${sheetName} row 2 has no column keys`);

  const prototypeStyles = new Map<number, number>();
  for (const [col, cell] of rest.get(prototypeRow) ?? []) prototypeStyles.set(col, cell.style);

  return { sheetName, partName, formId, sheetKey, firstDataRow, fieldPath, keys, prototypeStyles, prototypeRow };
}

/**
 * Read the hidden `INTER` handshake. Any missing/broken INTER sheet is reported
 * as "not a Winman 3CD workbook", because the marker is the only reliable
 * discriminator between a Winman export and any other macro workbook.
 */
export function readHandshake(pkg: XlsmPackage): WinmanHandshake {
  let row1: Map<number, Cell> | undefined;
  try {
    const partName = resolveSheetPart(pkg, "INTER");
    row1 = readRows(partText(pkg, partName), new Set([1]), sharedStringsOf(pkg)).get(1);
  } catch {
    throw new Error(`${NOT_WINMAN}: the INTER handshake is missing`);
  }
  const marker = valueAt(row1, 0);
  if (marker !== MARKER) throw new Error(`${NOT_WINMAN}: the INTER handshake is missing`);
  return {
    marker,
    version: valueAt(row1, 1),
    build: valueAt(row1, 2),
    assessmentYear: valueAt(row1, 3),
    validationOn: Number(valueAt(row1, 6)) >= 1,
  };
}
