'use strict';
/* ============================================================================
 * H10 — inbound file hardening tests.
 *
 * Golden thread: the ingestion boundary must never trust a file's name,
 * must never inflate what it has not capped, must never execute what a
 * spreadsheet could, and must never scan-later what it can refuse now.
 * Magic bytes identify content; zip-bomb caps bound the inflation; formula
 * stripping neutralizes the injection vector; XML is refused outright (XXE
 * is made structurally impossible, not mitigated); the AV hook fails
 * closed; and email-in rides the same gate as the dropzone — the source is
 * recorded, never consulted (audit gate 13, delivery spec A10 proofs
 * `ingest/magic-bytes`, `ingest/zip-bomb`, `ingest/formula-stripping`).
 * ==========================================================================*/
const assert = require('assert');
const H = require('../src/hardening');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/* ---- helpers: hand-built ZIP metadata (no real archives needed) --------- */
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

// Build minimal-but-structurally-valid ZIP bytes: local-header magic, a
// central directory carrying the declared metadata, and a truthful EOCD.
// entries: [{name, uncompressedSize, compressedSize}]
function makeZip(entries, opts = {}) {
  const cdParts = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    cdParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(e.compressedSize ?? 0), u32(e.uncompressedSize ?? 0),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0),
      name,
    ]));
  }
  const cd = Buffer.concat(cdParts);
  const prefix = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const cdOffset = opts.cdOffset ?? prefix.length;
  const declaredCount = opts.declaredEntries ?? entries.length;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(declaredCount), u16(declaredCount),
    u32(cd.length), u32(cdOffset), u16(0),
  ]);
  return Buffer.concat([prefix, cd, eocd]);
}

function makeXlsx(extraEntries) {
  return makeZip([
    { name: '[Content_Types].xml', uncompressedSize: 1500, compressedSize: 400 },
    { name: 'xl/workbook.xml', uncompressedSize: 9000, compressedSize: 1200 },
    ...(extraEntries || []),
  ]);
}

const CSV = Buffer.from('SKU,Qty\nR-001,12\n', 'utf8');
const cleanScan = async () => ({ clean: true, engine: 'fake-av 1.0' });

/* ---- sniffBytes ----------------------------------------------------------- */
console.log('\nMagic-byte sniffing');

test('refuses an empty payload', () => {
  assert.strictEqual(H.sniffBytes(Buffer.alloc(0)).reason, 'EMPTY_PAYLOAD');
});
test('throws on non-bytes (wiring error, not a data refusal)', () => {
  assert.throws(() => H.sniffBytes('SKU,Qty'), TypeError);
  assert.throws(() => H.sniffBytes(null), TypeError);
});
test('identifies a ZIP by its local-header magic', () => {
  const r = H.sniffBytes(makeZip([{ name: 'a.txt' }]));
  assert.ok(r.ok);
  assert.strictEqual(r.kind, 'zip');
});
test('identifies the degenerate EOCD-only archive', () => {
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), u16(0)]);
  const r = H.sniffBytes(eocd);
  assert.ok(r.ok);
  assert.strictEqual(r.kind, 'zip');
});
test('refuses OLE2 legacy binaries (legacy .xls)', () => {
  const b = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(32, 1)]);
  assert.strictEqual(H.sniffBytes(b).reason, 'UNKNOWN_BINARY');
});
test('refuses raw binaries carrying NUL bytes', () => {
  const b = Buffer.concat([Buffer.from('MZ......', 'utf8'), Buffer.alloc(8, 0)]);
  assert.strictEqual(H.sniffBytes(b).reason, 'UNKNOWN_BINARY');
});
test('refuses payloads that do not decode as UTF-8', () => {
  assert.strictEqual(H.sniffBytes(Buffer.from([0x53, 0x4b, 0xff, 0x0a])).reason, 'UNKNOWN_BINARY');
});
test('accepts plain UTF-8 text', () => {
  const r = H.sniffBytes(CSV);
  assert.ok(r.ok);
  assert.strictEqual(r.kind, 'text');
  assert.strictEqual(r.encoding, 'UTF-8');
});
test('accepts UTF-8-BOM and UTF-16LE text', () => {
  assert.strictEqual(H.sniffBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), CSV])).kind, 'text');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SKU,Qty\n', 'utf16le')]);
  const r = H.sniffBytes(le);
  assert.ok(r.ok);
  assert.strictEqual(r.kind, 'text');
});
test('identifies XML content by its declaration', () => {
  const r = H.sniffBytes(Buffer.from('<?xml version="1.0"?><root/>', 'utf8'));
  assert.ok(r.ok);
  assert.strictEqual(r.kind, 'xml');
});

/* ---- readZipCentralDirectory --------------------------------------------- */
console.log('\nZIP central directory (metadata only)');

test('parses names and sizes from a two-entry archive', () => {
  const z = makeZip([
    { name: 'xl/workbook.xml', uncompressedSize: 500, compressedSize: 200 },
    { name: 'xl/sharedStrings.xml', uncompressedSize: 1000, compressedSize: 300 },
  ]);
  const r = H.readZipCentralDirectory(z);
  assert.ok(r.ok);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].name, 'xl/workbook.xml');
  assert.strictEqual(r.entries[0].uncompressedSize, 500);
  assert.strictEqual(r.entries[1].compressedSize, 300);
});
test('flags directory entries', () => {
  const r = H.readZipCentralDirectory(makeZip([{ name: 'xl/' }, { name: 'xl/workbook.xml' }]));
  assert.ok(r.ok);
  assert.strictEqual(r.entries[0].isDirectory, true);
  assert.strictEqual(r.entries[1].isDirectory, false);
});
test('EOCD_MISSING when the record is absent or truncated', () => {
  assert.strictEqual(H.readZipCentralDirectory(CSV).reason, 'EOCD_MISSING');
  const z = makeZip([{ name: 'a.txt' }]);
  assert.strictEqual(H.readZipCentralDirectory(z.subarray(0, z.length - 10)).reason, 'EOCD_MISSING');
});
test('ZIP64 size markers refuse up front', () => {
  const z = makeZip([{ name: 'xl/workbook.xml', uncompressedSize: 0xFFFFFFFF }]);
  assert.strictEqual(H.readZipCentralDirectory(z).reason, 'ZIP64_UNSUPPORTED');
});
test('a lying central-directory offset is caught', () => {
  const z = makeZip([{ name: 'xl/workbook.xml' }], { cdOffset: 1 << 30 });
  assert.strictEqual(H.readZipCentralDirectory(z).reason, 'CENTRAL_DIRECTORY_TRUNCATED');
});
test('a declared count larger than the walked span is caught', () => {
  const z = makeZip([{ name: 'xl/workbook.xml' }], { declaredEntries: 2 });
  assert.strictEqual(H.readZipCentralDirectory(z).reason, 'CENTRAL_DIRECTORY_TRUNCATED');
});
test('a declared count smaller than the walked span is caught', () => {
  const z = makeZip([{ name: 'xl/a.xml' }, { name: 'xl/b.xml' }], { declaredEntries: 1 });
  assert.strictEqual(H.readZipCentralDirectory(z).reason, 'ENTRY_COUNT_MISMATCH');
});

/* ---- checkZipCaps ---------------------------------------------------------- */
console.log('\nZip-bomb caps');

const benign = [
  { name: '[Content_Types].xml', uncompressedSize: 1500, compressedSize: 400 },
  { name: 'xl/workbook.xml', uncompressedSize: 9000, compressedSize: 1200 },
  { name: 'xl/worksheets/sheet1.xml', uncompressedSize: 500000, compressedSize: 50000 },
];
test('benign workbooks pass and report the inflated total', () => {
  const r = H.checkZipCaps(benign);
  assert.ok(r.ok);
  assert.strictEqual(r.totalUncompressedBytes, 510500);
});
test('entry count cap', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: 'xl/p' + i + '.xml', uncompressedSize: 10, compressedSize: 5 }));
  assert.strictEqual(H.checkZipCaps(entries, { maxEntries: 4 }).reason, 'ZIP_ENTRY_COUNT_EXCEEDED');
});
test('inflated total cap', () => {
  // Each entry stays under the ratio cap (400 MiB / 3 MiB ≈ 133:1 < 200:1);
  // the three of them together exceed the 1 GiB total cap.
  const big = { uncompressedSize: 400 * 1024 * 1024, compressedSize: 3 * 1024 * 1024 };
  const entries = [
    { name: 'xl/s1.xml', ...big },
    { name: 'xl/s2.xml', ...big },
    { name: 'xl/s3.xml', ...big },
  ];
  assert.strictEqual(H.checkZipCaps(entries, { maxTotalUncompressedBytes: 1024 * 1024 * 1024 }).reason, 'ZIP_TOTAL_SIZE_EXCEEDED');
});
test('compression-ratio cap above the floor', () => {
  const entries = [{ name: 'xl/bomb.xml', uncompressedSize: 64 * 1024 * 1024, compressedSize: 1024 }];
  assert.strictEqual(H.checkZipCaps(entries).reason, 'ZIP_RATIO_EXCEEDED');
});
test('small but dense entries pass — the floor protects real XLSX parts', () => {
  const entries = [{ name: 'xl/styles.xml', uncompressedSize: 20480, compressedSize: 100 }];
  assert.ok(H.checkZipCaps(entries).ok); // ratio ~205:1 but under the 10 MiB floor
});
test('nested archives refuse', () => {
  assert.strictEqual(H.checkZipCaps([{ name: 'payload.zip', uncompressedSize: 10, compressedSize: 5 }]).reason, 'ZIP_NESTED_ARCHIVE');
  assert.strictEqual(H.checkZipCaps([{ name: 'XLSX/wb.xlsx', uncompressedSize: 10, compressedSize: 5 }]).reason, 'ZIP_NESTED_ARCHIVE');
});
test('directories are inert', () => {
  const r = H.checkZipCaps([{ name: 'xl/', uncompressedSize: 0, compressedSize: 0 }, { name: 'xl/wb.xml', uncompressedSize: 10, compressedSize: 5 }]);
  assert.ok(r.ok);
});

/* ---- stripFormulas --------------------------------------------------------- */
console.log('\nFormula stripping (cell level)');

test('= + @ are neutralized with the apostrophe escape', () => {
  const r = H.stripFormulas([['=SUM(A1)', '+1+1', '@SUM(1,2)']]);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.rows[0][0], "'=SUM(A1)");
  assert.strictEqual(r.rows[0][1], "'+1+1");
  assert.strictEqual(r.rows[0][2], "'@SUM(1,2)");
});
test('TAB- and CR-prefixed cells are neutralized', () => {
  const r = H.stripFormulas([['\tEXP', '\rDATA']]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.rows[0][0], "'\tEXP");
  assert.strictEqual(r.rows[0][1], "'\rDATA");
});
test('plain negative numbers are data — untouched; other dash-leads are not', () => {
  const r = H.stripFormulas([['-5', '-12.5', '- surplus']]);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.rows[0][0], '-5');
  assert.strictEqual(r.rows[0][1], '-12.5');
  assert.strictEqual(r.rows[0][2], "'- surplus");
});
test('non-string cells pass through untouched', () => {
  const r = H.stripFormulas([[12, true, null, '']]);
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.rows[0], [12, true, null, '']);
});
test('disclosures carry the exact row, column and prefix', () => {
  const r = H.stripFormulas([['ok', '=bad'], ['+also bad', 'ok']]);
  assert.deepStrictEqual(r.stripped, [
    { row: 0, col: 1, prefix: '=' },
    { row: 1, col: 0, prefix: '+' },
  ]);
});

/* ---- gateInboundFile ------------------------------------------------------- */
console.log('\nThe gate — single choke point');

test('accepts a text CSV with a clean scan', async () => {
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'consumption.csv', source: 'dropzone', avScan: cleanScan });
  assert.strictEqual(r.verdict, 'ACCEPT');
  assert.strictEqual(r.sniffed, 'text');
  assert.strictEqual(r.checks.find((c) => c.check === 'av').outcome, 'PASS');
});
test('accepts an XLSX workbook end to end — every check records PASS', async () => {
  const r = await H.gateInboundFile({ bytes: makeXlsx(), declaredName: 'inventory.xlsx', source: 'dropzone', avScan: cleanScan });
  assert.strictEqual(r.verdict, 'ACCEPT', r.detail);
  for (const k of ['payload', 'magic', 'declared', 'container', 'caps', 'av']) {
    assert.strictEqual(r.checks.find((c) => c.check === k).outcome, 'PASS', k);
  }
});
test('refuses unknown binaries', async () => {
  const b = Buffer.concat([Buffer.from('MZ', 'utf8'), Buffer.alloc(16, 0)]);
  const r = await H.gateInboundFile({ bytes: b, declaredName: 'x.csv', avScan: cleanScan });
  assert.strictEqual(r.verdict, 'REFUSE');
  assert.strictEqual(r.reason, 'UNKNOWN_BINARY');
});
test('refuses XML content — XXE made structurally impossible', async () => {
  const xxe = Buffer.from('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a SYSTEM "file:///etc/passwd">]><r>&a;</r>');
  const r = await H.gateInboundFile({ bytes: xxe, declaredName: 'report.xml', avScan: cleanScan });
  assert.strictEqual(r.verdict, 'REFUSE');
  assert.strictEqual(r.reason, 'XML_REJECTED');
});
test('refuses the declared XML family even when the content is plain text', async () => {
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'invoice.xml', avScan: cleanScan });
  assert.strictEqual(r.verdict, 'REFUSE');
  assert.strictEqual(r.reason, 'XML_REJECTED');
});
test('refuses archives that are not XLSX workbooks', async () => {
  const z = makeZip([{ name: 'readme.txt', uncompressedSize: 10, compressedSize: 5 }]);
  const r = await H.gateInboundFile({ bytes: z, declaredName: 'bundle.zip', avScan: cleanScan });
  assert.strictEqual(r.reason, 'UNSUPPORTED_ARCHIVE');
});
test('refuses zip bombs inside otherwise-valid workbooks', async () => {
  const z = makeXlsx([{ name: 'xl/bomb.xml', uncompressedSize: 64 * 1024 * 1024, compressedSize: 1024 }]);
  const r = await H.gateInboundFile({ bytes: z, declaredName: 'consumption.xlsx', avScan: cleanScan });
  assert.strictEqual(r.verdict, 'REFUSE');
  assert.strictEqual(r.reason, 'ZIP_RATIO_EXCEEDED');
});
test('refuses oversized payloads', async () => {
  const r = await H.gateInboundFile({ bytes: Buffer.alloc(1000, 0x41), declaredName: 'big.csv', caps: { maxBytes: 999 }, avScan: cleanScan });
  assert.strictEqual(r.verdict, 'REFUSE');
  assert.strictEqual(r.reason, 'FILE_TOO_LARGE');
});
test('declared identity must agree with content', async () => {
  const a = await H.gateInboundFile({ bytes: makeXlsx(), declaredName: 'report.csv', avScan: cleanScan });
  assert.strictEqual(a.reason, 'DECLARED_MISMATCH');
  const b = await H.gateInboundFile({ bytes: CSV, declaredName: 'report.xlsx', avScan: cleanScan });
  assert.strictEqual(b.reason, 'DECLARED_MISMATCH');
});
test('AV: infected files refuse with the engine named', async () => {
  const scan = async () => ({ clean: false, engine: 'fake-av 1.0', signature: 'EICAR.Test' });
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'a.csv', avScan: scan });
  assert.strictEqual(r.reason, 'AV_INFECTED');
  assert.ok(r.detail.includes('fake-av 1.0') && r.detail.includes('EICAR.Test'));
});
test('AV: a throwing scanner is a scan error — fail closed', async () => {
  const scan = async () => { throw new Error('engine crashed'); };
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'a.csv', avScan: scan });
  assert.strictEqual(r.reason, 'AV_SCAN_ERROR');
  assert.ok(r.detail.includes('engine crashed'));
});
test('AV: a malformed verdict is a scan error — fail closed', async () => {
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'a.csv', avScan: async () => ({}) });
  assert.strictEqual(r.reason, 'AV_SCAN_ERROR');
});
test('AV: required by default — no scanner refuses', async () => {
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'a.csv' });
  assert.strictEqual(r.verdict, 'REFUSE');
  assert.strictEqual(r.reason, 'AV_UNAVAILABLE');
});
test('AV: explicitly optional skips cleanly for pure-stage pipelines', async () => {
  const r = await H.gateInboundFile({ bytes: CSV, declaredName: 'a.csv', avRequired: false });
  assert.strictEqual(r.verdict, 'ACCEPT');
  assert.strictEqual(r.checks.find((c) => c.check === 'av').outcome, 'SKIP');
});
test('email-in rides the same gate — the source never changes the verdict', async () => {
  const z = makeXlsx();
  const a = await H.gateInboundFile({ bytes: z, declaredName: 'att.xlsx', source: 'email', avScan: cleanScan });
  const b = await H.gateInboundFile({ bytes: z, declaredName: 'att.xlsx', source: 'dropzone', avScan: cleanScan });
  assert.strictEqual(a.verdict, b.verdict);
  assert.deepStrictEqual(a.checks, b.checks);
  assert.strictEqual(a.source, 'email');
  const c = await H.gateInboundFile({ bytes: z, declaredName: 'att.xlsx', source: 'email', avScan: async () => ({ clean: false, engine: 'fake-av' }) });
  assert.strictEqual(c.reason, 'AV_INFECTED');
});
test('receipts are deterministic for identical inputs', async () => {
  const input = { bytes: CSV, declaredName: 'a.csv', avScan: cleanScan };
  const a = await H.gateInboundFile(input);
  const b = await H.gateInboundFile(input);
  assert.deepStrictEqual(a, b);
});
test('refusals carry a data-health task and a banner — quarantined whole', async () => {
  const r = await H.gateInboundFile({ bytes: Buffer.alloc(0) });
  assert.strictEqual(r.task.type, 'DATA_HEALTH');
  assert.ok(r.banner.text.includes('quarantined whole'));
});

/* ---- summary ---------------------------------------------------------------- */
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
