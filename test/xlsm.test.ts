import { describe, expect, it } from "vitest";
import { deflateRawSync, crc32 } from "node:zlib";
import { readXlsm, partText, replacePart, writeXlsm } from "../src/xlsm.js";

/** A deliberately independent minimal zip writer: one stored entry, one deflated. */
function makeZip(files: Array<[string, Buffer, 0 | 8]>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, raw, method] of files) {
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nb = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw) >>> 0, 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc32(raw) >>> 0, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

describe("xlsm package", () => {
  const src = makeZip([
    ["xl/worksheets/sheet1.xml", Buffer.from("<worksheet><sheetData/></worksheet>", "utf8"), 8],
    ["xl/media/image1.jpeg", JPEG, 0],
    ["xl/vbaProject.bin", Buffer.from("MACROBYTES\u0000\u0001\u0002", "binary"), 8],
  ]);

  it("round-trips every entry byte-for-byte when nothing is replaced", () => {
    const out = writeXlsm(readXlsm(src));
    const a = readXlsm(src).entries, b = readXlsm(out).entries;
    expect(b.map((e) => e.name)).toEqual(a.map((e) => e.name));
    for (let i = 0; i < a.length; i++) {
      expect(b[i].method).toBe(a[i].method);
      expect(b[i].crc).toBe(a[i].crc);
      expect(b[i].data.equals(a[i].data)).toBe(true);
    }
  });

  it("preserves a STORED entry's bytes and the macro part when one sheet is replaced", () => {
    const pkg = replacePart(readXlsm(src), "xl/worksheets/sheet1.xml", "<worksheet><sheetData><row r=\"7\"/></sheetData></worksheet>");
    const out = readXlsm(writeXlsm(pkg));
    const jpeg = out.entries.find((e) => e.name === "xl/media/image1.jpeg")!;
    expect(jpeg.method).toBe(0);
    expect(jpeg.data.equals(JPEG)).toBe(true);
    expect(partText(out, "xl/vbaProject.bin").length).toBeGreaterThan(0);
    expect(readXlsm(src).entries.find((e) => e.name === "xl/vbaProject.bin")!.data
      .equals(out.entries.find((e) => e.name === "xl/vbaProject.bin")!.data)).toBe(true);
    expect(partText(out, "xl/worksheets/sheet1.xml")).toContain('<row r="7"/>');
  });

  // Review Focus #1
  it("rejects zip64 rather than mis-copying it", () => {
    const z = makeZip([["a.xml", Buffer.from("<a/>"), 8]]);
    z.writeUInt32LE(0xffffffff, z.length - 22 + 16); // EOCD central-directory offset sentinel
    expect(() => readXlsm(z)).toThrow(/zip64/i);
  });

  it("rejects a data descriptor rather than mis-copying it", () => {
    const z = makeZip([["a.xml", Buffer.from("<a/>"), 8]]);
    z.writeUInt16LE(0x0008, 6); // local header general-purpose bit 3
    expect(() => readXlsm(z)).toThrow(/data descriptor/i);
  });
});
