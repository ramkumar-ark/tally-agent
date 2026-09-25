#!/usr/bin/env node
// Export a Tally day book plus the group/ledger trees as a tally-agent
// bundle, for tb_tds_review's dayBookPath. Uses a raw newline-delimited
// JSON-RPC client over stdio rather than the MCP SDK's StdioClientTransport,
// which drops whole-FY responses part-way through (the upstream child exits 0
// mid-write). Zero dependencies, like everything else here.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [upstream, company, fromDate, toDate, outPath] = process.argv.slice(2);
if (!upstream || !company || !fromDate || !toDate || !outPath) {
  console.error("usage: node scripts/export-daybook.mjs <upstream-dist-index.js> <company> <YYYYMMDD> <YYYYMMDD> <out.json>");
  process.exit(2);
}

const child = spawn("node", [upstream], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const call = async (name, args) => {
  const res = await send("tools/call", { name, arguments: { company, ...args } });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return JSON.parse(res.result.content.map((c) => c.text).join(""));
};

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "export-daybook", version: "1" },
});
notify("notifications/initialized", {});

const started = Date.now();
const [groups, ledgers, vouchers] = [
  await call("tally_get_groups", {}),
  // verbose:true is what carries PartYGSTIN (gstin) per ledger; the PAN
  // (IncomeTaxNumber) rides l.pan once the upstream fetches it — absent
  // today, so it exports as null and the bundle is still valid.
  await call("tally_get_ledgers", { verbose: true }),
  await call("tally_get_vouchers", { fromDate, toDate, includeLines: true }),
];

const norm = (v) => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "" ? null : s;
};
const keepCase = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

const bundle = {
  tallyAgentExport: 1,
  company,
  fromDate,
  toDate,
  exportedAt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
  groups: groups.map((g) => ({ name: g.name, parent: g.parent ?? "" })),
  ledgers: ledgers.map((l) => ({
    name: l.name,
    parent: l.parent ?? "",
    pan: norm(l.pan ?? l.IncomeTaxNumber),
    gstin: norm(l.gstin),
    address: keepCase(l.address),
    // Addendum 4a (2026-09-26): raw upstream value; the reader + gateway
    // apply the single sign-flip boundary convention.
    openingBalance: typeof l.openingBalance === "number" && Number.isFinite(l.openingBalance)
      ? l.openingBalance
      : null,
  })),
  vouchers,
};
await writeFile(outPath, JSON.stringify(bundle), "utf8");
console.error(`wrote ${vouchers.length} vouchers in ${Math.round((Date.now() - started) / 1000)}s`);
child.kill();
process.exit(0);
