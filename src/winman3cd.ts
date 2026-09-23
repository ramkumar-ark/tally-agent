import { partText, replacePart, type XlsmPackage } from "./xlsm.js";
import { serial } from "./xlsx.js";

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

// -------------------------------------------------------------- style twins

export type WinmanValue =
  | { kind: "date"; ymd: string }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | null;

/** One record keyed by the row-2 machine column key. */
export type WinmanRow = Record<string, WinmanValue>;

interface Xf { raw: string; attrs: Map<string, string> }

function splitXfs(inner: string): Xf[] {
  const out: Xf[] = [];
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf("<xf", i);
    if (lt < 0) break;
    const after = inner[lt + 3];
    if (!(after === ">" || after === "/" || /\s/.test(after))) { i = lt + 3; continue; }
    const gt = inner.indexOf(">", lt);
    if (gt < 0) break;
    const selfClose = inner[gt - 1] === "/";
    let end = gt + 1;
    if (!selfClose) {
      const close = inner.indexOf("</xf>", gt);
      if (close >= 0) end = close + 5;
    }
    const raw = inner.slice(lt, end);
    out.push({ raw, attrs: xfAttrs(raw) });
    i = end;
  }
  return out;
}

function xfAttrs(raw: string): Map<string, string> {
  for (const tok of tokenize(raw)) {
    if ((tok.kind === "open" || tok.kind === "self") && tok.name === "xf") return tok.attrs;
  }
  return new Map();
}

/** Equal in every attribute except `quotePrefix`, which the candidate must lack. */
function attrsTwin(proto: Map<string, string>, cand: Map<string, string>): boolean {
  if (cand.has("quotePrefix")) return false;
  const keys = new Set<string>([...proto.keys(), ...cand.keys()]);
  for (const k of keys) {
    if (k === "quotePrefix") continue;
    if ((proto.get(k) ?? null) !== (cand.get(k) ?? null)) return false;
  }
  return true;
}

function stripQuotePrefix(raw: string): string {
  return raw.replace(/\s+quotePrefix\s*=\s*("[^"]*"|'[^']*')/, "");
}

interface CellXfsBlock {
  openStart: number; innerStart: number; closeStart: number;
  open: string; inner: string; xfs: Xf[];
}

function parseCellXfs(stylesXml: string): CellXfsBlock | null {
  const m = /<cellXfs\b[^>]*>/.exec(stylesXml);
  if (!m) return null;
  const openStart = m.index;
  const innerStart = openStart + m[0].length;
  const closeStart = stylesXml.indexOf("</cellXfs>", innerStart);
  if (closeStart < 0) return null;
  const inner = stylesXml.slice(innerStart, closeStart);
  return { openStart, innerStart, closeStart, open: m[0], inner, xfs: splitXfs(inner) };
}

/**
 * Winman writes a data cell with the prototype cell's style minus its
 * `quotePrefix`, identical in every other attribute (design §2.3). This finds
 * that twin xf, or appends a stripped copy (bumping `count`) when the workbook
 * has none; PF/ESI already carries both twins, so it appends nothing.
 */
export function resolveStyleTwins(
  stylesXml: string,
  protoIds: number[],
): { twins: Map<number, number>; stylesXml: string } {
  const twins = new Map<number, number>();
  const parsed = parseCellXfs(stylesXml);
  if (!parsed) {
    for (const id of protoIds) twins.set(id, id);
    return { twins, stylesXml };
  }
  const { xfs } = parsed;
  const appended: string[] = [];
  for (const id of protoIds) {
    if (twins.has(id)) continue;
    const proto = xfs[id];
    if (!proto || !proto.attrs.has("quotePrefix")) { twins.set(id, id); continue; }
    let found = -1;
    for (let i = 0; i < xfs.length; i += 1) {
      if (i !== id && attrsTwin(proto.attrs, xfs[i].attrs)) { found = i; break; }
    }
    if (found >= 0) { twins.set(id, found); continue; }
    appended.push(stripQuotePrefix(proto.raw));
    twins.set(id, xfs.length + appended.length - 1);
  }
  if (appended.length === 0) return { twins, stylesXml };
  const count = xfs.length + appended.length;
  let open = parsed.open;
  if (/\bcount="\d+"/.test(open)) open = open.replace(/\bcount="\d+"/, `count="${count}"`);
  else open = open.replace(/>$/, ` count="${count}">`);
  const next = stylesXml.slice(0, parsed.openStart) + open + parsed.inner + appended.join("") + stylesXml.slice(parsed.closeStart);
  return { twins, stylesXml: next };
}

// ------------------------------------------------------------ the row writer

function columnName(n: number): string {
  let s = "";
  let i = n + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = (i - r - 1) / 26;
  }
  return s;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface RowSpan { raw: string; r: number }

function findRows(inner: string): RowSpan[] {
  const out: RowSpan[] = [];
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf("<row", i);
    if (lt < 0) break;
    const after = inner[lt + 4];
    if (!(after === ">" || after === "/" || /\s/.test(after))) { i = lt + 4; continue; }
    const gt = inner.indexOf(">", lt);
    if (gt < 0) break;
    const selfClose = inner[gt - 1] === "/";
    let end = gt + 1;
    if (!selfClose) {
      const close = inner.indexOf("</row>", gt);
      if (close >= 0) end = close + 6;
    }
    const raw = inner.slice(lt, end);
    const m = /\br="(\d+)"/.exec(raw);
    out.push({ raw, r: m ? Number(m[1]) : Number.NaN });
    i = end;
  }
  return out;
}

function dataCell(ref: string, style: number | undefined, value: WinmanValue): string {
  if (value === null || value === undefined) return "";
  const s = style === undefined ? "" : ` s="${style}"`;
  if (value.kind === "date") return `<c r="${ref}"${s}><v>${serial(value.ymd)}</v></c>`;
  if (value.kind === "number") return `<c r="${ref}"${s}><v>${value.value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value.value)}</t></is></c>`;
}

function replaceDimension(xml: string, ref: string): string {
  const self = /<dimension\b[^>]*\/>/.exec(xml);
  if (self) return xml.slice(0, self.index) + `<dimension ref="${ref}"/>` + xml.slice(self.index + self[0].length);
  const paired = /<dimension\b[^>]*>[\s\S]*?<\/dimension>/.exec(xml);
  if (paired) return xml.slice(0, paired.index) + `<dimension ref="${ref}"/>` + xml.slice(paired.index + paired[0].length);
  const w = /<worksheet\b[^>]*>/.exec(xml);
  if (w) { const at = w.index + w[0].length; return xml.slice(0, at) + `<dimension ref="${ref}"/>` + xml.slice(at); }
  return xml;
}

function rebuildSheet(xml: string, schema: WinmanSchema, rows: WinmanRow[], twins: Map<number, number>): string {
  const sdStart = xml.indexOf("<sheetData");
  if (sdStart < 0) throw new Error(`${NOT_WINMAN}: ${schema.sheetName} has no sheetData`);
  const sdOpenEnd = xml.indexOf(">", sdStart);
  const selfClose = xml[sdOpenEnd - 1] === "/";
  const innerStart = sdOpenEnd + 1;
  const innerEnd = selfClose ? innerStart : xml.indexOf("</sheetData>", innerStart);
  const inner = selfClose ? "" : xml.slice(innerStart, innerEnd);
  const sdEnd = selfClose ? sdOpenEnd + 1 : innerEnd + "</sheetData>".length;

  const kept = findRows(inner)
    .filter((row) => !Number.isFinite(row.r) || row.r < schema.firstDataRow)
    .map((row) => row.raw);

  const dataRows: string[] = [];
  for (let k = 0; k < rows.length; k += 1) {
    const rowNum = schema.firstDataRow + k;
    const cells: string[] = [];
    for (const [key, col] of schema.keys) {
      const proto = schema.prototypeStyles.get(col);
      const style = proto === undefined ? undefined : twins.get(proto) ?? proto;
      cells.push(dataCell(`${columnName(col)}${rowNum}`, style, rows[k][key] ?? null));
    }
    dataRows.push(`<row r="${rowNum}">${cells.join("")}</row>`);
  }

  let sdOpen = xml.slice(sdStart, sdOpenEnd + 1);
  if (sdOpen.endsWith("/>")) sdOpen = sdOpen.slice(0, -2) + ">";
  const next = xml.slice(0, sdStart) + sdOpen + kept.join("") + dataRows.join("") + "</sheetData>" + xml.slice(sdEnd);

  let maxCol = 0;
  for (const col of schema.keys.values()) if (col > maxCol) maxCol = col;
  const lastRow = rows.length > 0 ? schema.firstDataRow + rows.length - 1 : schema.prototypeRow;
  return replaceDimension(next, `A1:${columnName(maxCol)}${lastRow}`);
}

/**
 * Write data rows into a Winman data sheet, rewriting only that worksheet part
 * (and `xl/styles.xml` if a twin xf had to be appended). Rows before the first
 * data row are copied byte-identical; any pre-existing row at or after it is
 * dropped, so a re-run overwrites rather than appends. Every other package
 * entry — macros, signature, media — is left untouched.
 */
export function writeSheetRows(pkg: XlsmPackage, sheetName: string, rows: WinmanRow[]): XlsmPackage {
  const schema = readSchema(pkg, sheetName);
  const stylesPart = pkg.entries.some((e) => e.name === "xl/styles.xml") ? "xl/styles.xml" : null;
  const stylesXml = stylesPart ? partText(pkg, stylesPart) : "";

  const protoIds: number[] = [];
  for (const col of schema.keys.values()) {
    const proto = schema.prototypeStyles.get(col);
    if (proto !== undefined && !protoIds.includes(proto)) protoIds.push(proto);
  }
  const { twins, stylesXml: nextStyles } = resolveStyleTwins(stylesXml, protoIds);

  let out = replacePart(pkg, schema.partName, rebuildSheet(partText(pkg, schema.partName), schema, rows, twins));
  if (stylesPart && nextStyles !== stylesXml) out = replacePart(out, stylesPart, nextStyles);
  return out;
}
