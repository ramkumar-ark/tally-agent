import { inflateRawSync } from "node:zlib";

/**
 * The zero-dependency .xlsx reader, sister to the writer `src/xlsx.ts` and
 * deliberately sharing no code with it (design of record:
 * docs/design/2026-09-16-tds-spreadsheet-input-design.md §7). It is NOT a
 * general OOXML reader: it reads workbooks produced by Excel, Winman and the
 * project's own writer — flat, well-formed parts. `docProps` is never opened;
 * nothing from workbook metadata is surfaced.
 */

export interface GridCell {
  /** A shared/inline string, or a number. A date cell arrives as its Excel serial. */
  value: string | number | null;
  isDate: boolean;
}

export interface GridRow {
  /** The Excel row number (1-based), as displayed. */
  row: number;
  /** Key = 0-based column index. */
  cells: Map<number, GridCell>;
}

export interface GridSheet {
  name: string;
  /** "visible", "hidden" or "veryHidden" — hidden sheets are returned and flagged; callers decide what to skip. */
  state: string;
  rows: GridRow[];
}

// ---------------------------------------------------------------- zip layer

interface ZipEntry {
  name: string;
  offset: number;
  compSize: number;
  method: number;
}

/** EOCD → central-directory walk (robust to data descriptors), then per-entry inflate. */
function zipEntries(buf: Buffer): Map<string, Buffer> {
  // Find the EOCD signature scanning back: no zip64, no data descriptors in
  // anything this reader is fed.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && buf.length - i <= 65557; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("xlsx: not a readable zip archive (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  const centralStart = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let p = centralStart;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("xlsx: not a readable zip archive (central directory is truncated)");
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // Re-read the local header only for its own name/extra lengths, which the
    // central directory can disagree with.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`xlsx: not a readable zip archive (bad local header at ${name})`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      out.set(name, Buffer.from(comp));
    } else if (method === 8) {
      out.set(name, inflateRawSync(comp));
    } else {
      throw new Error(`xlsx: unsupported zip compression (method ${method}) for ${name}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- xml layer

type XmlToken =
  | { kind: "open"; name: string; attrs: Map<string, string> }
  | { kind: "close"; name: string }
  | { kind: "self"; name: string; attrs: Map<string, string> }
  | { kind: "text"; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "x23": "#", "x39": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (m, code: string) => {
    if (code === "amp" || code === "lt" || code === "gt" || code === "quot" || code === "apos") {
      void ENTITIES;
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[code];
    }
    const isHex = code[1] === "x" || code[1] === "X";
    const num = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    return Number.isFinite(num) ? String.fromCodePoint(num) : m;
  });
}

const NAME_RE = /[^\s=/>]+/;

/** A pull-tokenizer state machine — never regex-over-XML. */
function* tokenizeXml(xml: string): Generator<XmlToken> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (i < xml.length) yield { kind: "text", text: decodeEntities(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { kind: "text", text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith("<!", lt)) {
      // Comment or CDATA: skip to its end.
      const end = xml.startsWith("<!CDATA", lt) ? xml.indexOf("]]>", lt) : xml.indexOf("-->", lt);
      i = end < 0 ? xml.length : end + (xml.startsWith("<!CDATA", lt) ? 3 : 3);
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      i = xml.indexOf("?>", lt);
      i = i < 0 ? xml.length : i + 2;
      continue;
    }
    const m = NAME_RE.exec(xml.slice(lt + 1));
    if (!m || m[0].length === 0) throw new Error("xlsx: malformed XML");
    const name = m[0];
    if (xml[lt + 1] === "/") {
      const close = xml.indexOf(">", lt);
      if (close < 0) throw new Error("xlsx: malformed XML");
      yield { kind: "close", name: xml.slice(lt + 2, close).trim() };
      i = close + 1;
      continue;
    }
    let j = lt + 1 + name.length;
    const attrs = new Map<string, string>();
    for (;;) {
      while (j < xml.length && /\s/.test(xml[j])) j += 1;
      if (j >= xml.length) throw new Error("xlsx: malformed XML");
      if (xml[j] === ">") {
        yield { kind: "open", name, attrs };
        i = j + 1;
        break;
      }
      if (xml[j] === "/" && xml[j + 1] === ">") {
        yield { kind: "self", name, attrs };
        i = j + 2;
        break;
      }
      const eq = xml.indexOf("=", j);
      if (eq < 0) throw new Error("xlsx: malformed XML");
      void NAME_RE;
      const an = xml.slice(j, eq).trim();
      const quote = xml[eq + 1];
      const qEnd = xml.indexOf(quote, eq + 2);
      if (qEnd < 0) throw new Error("xlsx: malformed XML");
      attrs.set(an, decodeEntities(xml.slice(eq + 2, qEnd)));
      j = qEnd + 1;
    }
  }
}

interface Element {
  name: string;
  attrs: Map<string, string>;
  /** Text directly inside the element (concatenated). */
  text: string;
  children: Element[];
}

function parseElements(xml: string, part: string): Element {
  // A minimal stack build: self-closing = open + close.
  const root: Element = { name: "#root", attrs: new Map(), text: "", children: [] };
  const stack: Element[] = [root];
  for (const tok of tokenizeXml(xml)) {
    if (tok.kind === "text") {
      stack[stack.length - 1].text += tok.text;
      continue;
    }
    if (tok.kind === "self") {
      stack[stack.length - 1].children.push({
        name: tok.name,
        attrs: tok.attrs,
        text: "",
        children: [],
      });
      continue;
    }
    if (tok.kind === "open") {
      stack.push({ name: tok.name, attrs: tok.attrs, text: "", children: [] });
      continue;
    }
    // close
    if (stack.length < 2) throw new Error(`xlsx: malformed XML in ${part} (unmatched </${tok.name}>)`);
    const el = stack.pop()!;
    if (el.name !== tok.name) {
      throw new Error(`xlsx: malformed XML in ${part} (</${tok.name}> closes <${el.name}>)`);
    }
    stack[stack.length - 1].children.push(el);
  }
  if (stack.length !== 1) {
    throw new Error(`xlsx: malformed XML in ${part} (unmatched <${stack[stack.length - 1].name}>)`);
  }
  if (root.children.length !== 1) {
    throw new Error(`xlsx: malformed XML in ${part} (expected a single document element)`);
  }
  return root.children[0];
}

// ------------------------------------------------------------ parts to grid

function directChildren(el: Element, name: string): Element[] {
  return el.children.filter((c) => c.name === name);
}

/** Builtin date-bearing number formats (OOXML §18.6.2 subset). */
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * True when a custom format code is date-bearing: it names d/m/y OUTSIDE any
 * bracketed colour/condition section (a `#,##,##0.00` accounting format or a
 * `0.0%` never is; `dd\-mmm\-yy` always is).
 */
function customFormatIsDate(code: string): boolean {
  const stripped = code.replace(/\[[^\]]*\]/g, "");
  return /[dmy]/.test(stripped.replace(/\\./g, "").replace(/"[^"]*"/g, ""));
}

function styleDateTable(stylesXml: string | undefined): boolean[] {
  if (!stylesXml) return [];
  const root = parseElements(stylesXml, "xl/styles.xml");
  const custom = new Map<string, boolean>();
  for (const fmts of directChildren(root, "numFmts")) {
    for (const fmt of directChildren(fmts, "numFmt")) {
      const id = fmt.attrs.get("numFmtId") ?? "";
      const code = fmt.attrs.get("formatCode") ?? "";
      custom.set(id, customFormatIsDate(code));
    }
  }
  const table: boolean[] = [];
  const xfs = directChildren(root, "cellXfs")[0];
  if (xfs) {
    for (const xf of directChildren(xfs, "xf")) {
      const id = xf.attrs.get("numFmtId") ?? "0";
      table.push(Number(id) >= 164 && custom.has(id) ? custom.get(id)! : BUILTIN_DATE_IDS.has(Number(id)));
    }
  }
  return table;
}

function sharedStrings(xml: string): string[] {
  const root = parseElements(xml, "xl/sharedStrings.xml");
  const out: string[] = [];
  for (const si of directChildren(root, "si")) {
    // A plain <si> has one <t>; a rich-text <si> carries <r><t> runs —
    // concatenate them.
    let text = "";
    for (const t of directChildren(si, "t")) text += t.text;
    for (const r of directChildren(si, "r")) {
      for (const t of directChildren(r, "t")) text += t.text;
    }
    out.push(decodeEntities(text));
  }
  return out;
}

function sheetMeta(workbookXml: string, relsXml: string): Array<{ name: string; state: string; target: string }> {
  const wb = parseElements(workbookXml, "xl/workbook.xml");
  const rels = parseElements(relsXml, "xl/_rels/workbook.xml.rels");
  const byId = new Map<string, string>();
  for (const rel of rels.children) {
    const id = rel.attrs.get("Id");
    const target = rel.attrs.get("Target");
    if (id && target) {
      // Winman writes "/xl/…" absolute targets; writers write relative ones
      // ("worksheets/sheet1.xml") — both resolve against the package root.
      const t = target.startsWith("/") ? target.slice(1) : target;
      byId.set(id, t.startsWith("xl/") ? t : `xl/${t}`);
    }
  }
  const out: Array<{ name: string; state: string; target: string }> = [];
  for (const sheets of directChildren(wb, "sheets")) {
    for (const s of directChildren(sheets, "sheet")) {
      const name = decodeEntities(s.attrs.get("name") ?? "");
      const target = byId.get(s.attrs.get("r:id") ?? "");
      if (!target) continue; // a sheet with no rel is not readable
      out.push({ name, state: s.attrs.get("state") ?? "visible", target });
    }
  }
  return out;
}

function readSheet(
  xml: string,
  part: string,
  strings: string[],
  dateOfStyle: (n: number) => boolean,
): Array<GridRow> {
  const root = parseElements(xml, part);
  const rows: GridRow[] = [];
  let seq = 0;
  const dataRoot = directChildren(root, "sheetData")[0] ?? root;
  for (const rEl of directChildren(dataRoot, "row")) {
    const rAttr = Number(rEl.attrs.get("r") ?? "");
    const rowNum = Number.isFinite(rAttr) && rAttr > 0 ? rAttr : (rows.length ? rows[rows.length - 1].row + 1 : 1);
    const cells: Map<number, GridCell> = new Map();
    let col = 0;
    for (const c of rEl.children) {
      if (c.name !== "c") continue;
      const ref = c.attrs.get("r");
      if (ref) {
        let k = 0;
        for (const ch of ref.slice(0, ref.search(/\d/))) {
          k = k * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
        }
        col = k - 1;
      }
      // Cells without r continue from the previous column (defensive; neither
      // Excel nor Winman nor the writer emits them today).
      const style = Number(c.attrs.get("s") ?? "0") || 0;
      const t = c.attrs.get("t") ?? "n";
      let value: string | number | null = null;
      let isDate = false;
      const vEl = c.children.find((x) => x.name === "v");
      const isEl = c.children.find((x) => x.name === "is");
      if (t === "s") {
        const idx = Number(vEl?.text ?? NaN);
        value = Number.isFinite(idx) && strings[idx] !== undefined ? strings[idx] : null;
      } else if (t === "inlineStr") {
        let text = "";
        const isNode = c.children.find((x) => x.name === "is");
        if (isNode) {
          for (const tt of directChildren(isNode, "t")) text += tt.text;
          for (const r of directChildren(isNode, "r")) {
            for (const tt of directChildren(r, "t")) text += tt.text;
          }
        }
        value = decodeEntities(text);
      } else if (t === "str") {
        value = decodeEntities(vEl?.text ?? "");
      } else {
        const raw = vEl?.text ?? "";
        value = raw === "" ? null : Number(raw);
        if (value !== null && !Number.isFinite(value)) value = null;
        isDate = dateOfStyle(style);
      }
      cells.set(col, { value, isDate });
      col += 1;
    }
    rows.push({ row: rowNum, cells });
  }
  return rows;
}

/**
 * Read a workbook buffer into named sheets. Hidden and veryHidden sheets are
 * returned with their `state` — skipping them is the caller's policy (the TDS
 * layer never reads a hidden sheet by design).
 */
export function readWorkbook(buf: Buffer): GridSheet[] {
  const parts = zipEntries(buf);
  const workbookXml = parts.get("xl/workbook.xml")?.toString("utf8");
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbookXml || !rels) {
    throw new Error("xlsx: no xl/workbook.xml part — this file is not an Excel workbook");
  }
  const stringsXml = parts.get("xl/sharedStrings.xml")?.toString("utf8");
  const strings = stringsXml ? sharedStrings(stringsXml) : [];
  const stylesXml = parts.get("xl/styles.xml")?.toString("utf8");
  const dateStyles = styleDateTable(stylesXml);
  const dateOfStyle = (n: number): boolean => dateStyles[n] === true;
  const meta = sheetMeta(workbookXml, rels);
  const sheets: GridSheet[] = [];
  for (const m of meta) {
    const xml = parts.get(m.target)?.toString("utf8");
    if (!xml) continue;
    try {
      sheets.push({ name: m.name, state: m.state, rows: readSheet(xml, m.target, strings, dateOfStyle) });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("xlsx:")) {
        throw new Error(`xlsx: ${m.target}: ${e.message.replace(/^xlsx:\s*/, "")}`);
      }
      throw new Error(`xlsx: cannot read the part ${m.target}`);
    }
  }
  return sheets;
}
