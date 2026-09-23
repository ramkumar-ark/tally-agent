import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A third, independent zip stack. `src/xlsx.ts` writes workbooks from strings
 * and `src/xlsx-read.ts` reads them into a grid; neither can carry the binary
 * parts of a macro-enabled package. This one exists to REWRITE one part of an
 * existing .xlsm while copying every other entry's stored bytes verbatim, so
 * xl/vbaProject.bin and its signature, the JPEGs and the printer settings all
 * survive untouched. Design of record:
 * docs/design/2026-09-23-winman-3cd-pf-esi-design.md
 */

export interface RawEntry {
  name: string; method: number; flags: number; crc: number;
  compSize: number; rawSize: number; modTime: number; modDate: number;
  versionMadeBy: number; versionNeeded: number;
  internalAttrs: number; externalAttrs: number;
  data: Buffer;
  localExtra: Buffer; centralExtra: Buffer; comment: Buffer;
}

export interface XlsmPackage { entries: RawEntry[] }

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LH_SIG = 0x04034b50;

export function readXlsm(buf: Buffer): XlsmPackage {
  // EOCD back-scan: the comment may be up to 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip package: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("this workbook uses the zip64 format, which this writer cannot copy safely — re-save it from Excel and try again");
  }

  const entries: RawEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error(`corrupt central directory at entry ${n + 1}`);
    const flags = buf.readUInt16LE(p + 8);
    if (flags & 0x0008) {
      throw new Error("this workbook stores sizes in a data descriptor, which this writer cannot copy safely — re-save it from Excel and try again");
    }
    const method = buf.readUInt16LE(p + 10);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method} in the workbook package`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== LH_SIG) throw new Error(`corrupt local header for ${name}`);
    const lFlags = buf.readUInt16LE(localOffset + 6);
    if (lFlags & 0x0008) throw new Error(`entry ${name} uses a data descriptor, which this writer cannot copy safely`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compSize = buf.readUInt32LE(p + 20);

    entries.push({
      name, method, flags,
      crc: buf.readUInt32LE(p + 16),
      compSize, rawSize: buf.readUInt32LE(p + 24),
      modTime: buf.readUInt16LE(p + 12), modDate: buf.readUInt16LE(p + 14),
      versionMadeBy: buf.readUInt16LE(p + 4), versionNeeded: buf.readUInt16LE(p + 6),
      internalAttrs: buf.readUInt16LE(p + 36), externalAttrs: buf.readUInt32LE(p + 38),
      data: buf.subarray(dataStart, dataStart + compSize),
      localExtra: buf.subarray(localOffset + 30 + lNameLen, dataStart),
      centralExtra: buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
      comment: buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

function find(pkg: XlsmPackage, name: string): RawEntry {
  const e = pkg.entries.find((x) => x.name === name);
  if (!e) throw new Error(`the workbook has no part named ${name}`);
  return e;
}

export function partText(pkg: XlsmPackage, name: string): string {
  const e = find(pkg, name);
  return (e.method === 8 ? inflateRawSync(e.data) : e.data).toString("utf8");
}

export function replacePart(pkg: XlsmPackage, name: string, text: string): XlsmPackage {
  const old = find(pkg, name);
  const raw = Buffer.from(text, "utf8");
  const data = deflateRawSync(raw, { level: 9 });
  const next: RawEntry = {
    ...old, method: 8, data,
    crc: crc32(raw) >>> 0, compSize: data.length, rawSize: raw.length,
  };
  return { entries: pkg.entries.map((e) => (e.name === name ? next : e)) };
}

export function writeXlsm(pkg: XlsmPackage): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = [];
  let offset = 0;
  for (const e of pkg.entries) {
    const nb = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LH_SIG, 0);
    lh.writeUInt16LE(e.versionNeeded, 4);
    lh.writeUInt16LE(e.flags & ~0x0008, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(e.modTime, 10); lh.writeUInt16LE(e.modDate, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.compSize, 18); lh.writeUInt32LE(e.rawSize, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(e.localExtra.length, 28);
    locals.push(lh, nb, e.localExtra, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CD_SIG, 0);
    ch.writeUInt16LE(e.versionMadeBy, 4); ch.writeUInt16LE(e.versionNeeded, 6);
    ch.writeUInt16LE(e.flags & ~0x0008, 8); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(e.modTime, 12); ch.writeUInt16LE(e.modDate, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.compSize, 20); ch.writeUInt32LE(e.rawSize, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(e.centralExtra.length, 30);
    ch.writeUInt16LE(e.comment.length, 32);
    ch.writeUInt16LE(e.internalAttrs, 36); ch.writeUInt32LE(e.externalAttrs, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nb, e.centralExtra, e.comment);

    offset += 30 + nb.length + e.localExtra.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(pkg.entries.length, 8); eocd.writeUInt16LE(pkg.entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
