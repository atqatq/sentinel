'use strict';
/* ============================================================================
 * Sentinel — ingestion boundary v1 core: inbound file hardening (H10).
 *
 * Contract sources:
 *   - build spec §15.2 P1 H10: "ingestion hardening (magic bytes, zip-bomb
 *     caps, formula stripping, XXE, AV; email-in through the same pipeline)"
 *   - build spec §14.8: column allow-list at the boundary (banking/tax fields
 *     never persisted) — already enforced at header binding (D-014); this
 *     module is the layer BELOW it, operating on raw bytes
 *   - delivery spec §2 stack table: "XLSX artifacts with the AV-scan +
 *     magic-bytes hook (H10)"
 *   - delivery spec §9 A10 / gate 13: named proofs `ingest/magic-bytes`,
 *     `ingest/zip-bomb`, `ingest/formula-stripping`
 *   - ingestion spec §4: a failing file is quarantined WHOLE, never
 *     half-applied — a refusal here is file-level, with a data-health task
 *     and a banner, mirroring the deliveriesGuard/window.js shape
 *
 * The gate is the single choke point for every inbound artifact. dropzone,
 * watched-folder and email-in attachments all arrive through gateInboundFile
 * — there is no second path, and the declared `source` never changes a
 * verdict (proven by test). It decides from the bytes themselves:
 *
 *   1. payload  — non-empty, within the raw-size cap
 *   2. magic    — content is identified by its leading bytes, not its name:
 *                 ZIP (PK), OLE2 (legacy .xls), UTF-16/UTF-8 text, XML,
 *                 or unknown binary
 *   3. declared — the file's extension must agree with its content class;
 *                 the XML family (xml/xsd/svg/html) is refused outright —
 *                 XXE is made structurally impossible, not merely mitigated
 *   4. container— a ZIP must be an XLSX workbook (central directory carries
 *                 [Content_Types].xml / xl/*); arbitrary archives refuse
 *   5. caps     — zip-bomb bounds: entry count, total uncompressed size,
 *                 per-entry compression ratio above a floor, nested archives
 *   6. AV       — the injected scanner hook; fail-closed in all three
 *                 failure modes (infected, errored, malformed verdict) and
 *                 when no scanner is configured while one is required
 *
 * Philosophy unchanged — refuse, don't guess. Every refusal carries a
 * stable machine reason (never rename; quarantine UIs and ledgers depend
 * on them) plus a DATA_HEALTH task and a banner. Formula stripping runs at
 * the cell level once text is decoded: cells beginning with =, +, @, TAB or
 * CR are neutralized with the OWASP apostrophe escape so they can never
 * execute in a spreadsheet; a leading '-' is left alone exactly when the
 * cell is a plain canonical number (data) and neutralized otherwise. A
 * neutralized cell then fails the strict parser if it claimed a numeric
 * column — hardening kills the execution vector, parse.js refuses the data.
 *
 * Purity: no-db, no-react, no-framework, no-io, no clock, no network. The
 * AV scanner is injected; determinism is preserved because identical bytes
 * + identical hook behavior produce identical receipts.
 * ==========================================================================*/

const DEFAULT_CAPS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,            // raw upload cap (workbook drops run 6–12 MB today)
  maxEntries: 16384,                     // central-directory entries
  maxTotalUncompressedBytes: 1024 * 1024 * 1024, // 1 GiB inflated total
  maxRatio: 200,                         // per-entry compressed/uncompressed ratio
  ratioFloorBytes: 10 * 1024 * 1024,     // entries below this uncompressed size are exempt from the ratio check
});

/* ---- byte helpers -------------------------------------------------------- */

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); // zero-copy view
}

function looksLikeXlsx(entries) {
  return entries.some((e) => e.name === '[Content_Types].xml' || e.name.startsWith('xl/'));
}

/* ---- magic bytes --------------------------------------------------------- */

/**
 * Identify content by its leading bytes — never by its name.
 *
 * @returns {{ok:true, kind:'zip'|'text'|'xml', encoding?:string, detail?:string}}
 *         |{{ok:false, reason:'EMPTY_PAYLOAD'|'UNKNOWN_BINARY', detail?:string}}
 *
 * ZIP detection covers both a normal local-header archive (PK\x03\x04) and
 * the degenerate EOCD-only archive (PK\x05\x06). Text is accepted only if
 * the whole payload decodes strictly as UTF-16 (BOM) or UTF-8 with no NUL
 * bytes; everything else is UNKNOWN_BINARY — refuse, don't guess.
 */
function sniffBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('sniffBytes: bytes must be a Uint8Array/Buffer');
  if (bytes.byteLength === 0) return { ok: false, reason: 'EMPTY_PAYLOAD' };
  const b = asBuffer(bytes);

  if (b[0] === 0x50 && b[1] === 0x4b) { // "PK"
    if (b[2] === 0x03 && b[3] === 0x04) return { ok: true, kind: 'zip', detail: 'local-header archive (PK\\x03\\x04)' };
    if (b[2] === 0x05 && b[3] === 0x06) return { ok: true, kind: 'zip', detail: 'empty archive (EOCD only)' };
    return { ok: false, reason: 'UNKNOWN_BINARY', detail: 'PK signature but not an archive start' };
  }
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    return { ok: false, reason: 'UNKNOWN_BINARY', detail: 'OLE2 compound file (legacy .xls) is not an accepted format' };
  }

  // UTF-16 with BOM: text that legitimately contains NUL bytes when raw.
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
    const enc = b[0] === 0xff ? 'utf-16le' : 'utf-16be';
    try {
      const t = new TextDecoder(enc, { fatal: true }).decode(b);
      return textOrXml(t, enc.toUpperCase());
    } catch {
      return { ok: false, reason: 'UNKNOWN_BINARY', detail: `claimed ${enc} but the payload does not decode` };
    }
  }

  if (b.indexOf(0) !== -1) {
    return { ok: false, reason: 'UNKNOWN_BINARY', detail: `NUL byte at offset ${b.indexOf(0)}` };
  }
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(b);
    return textOrXml(t, 'UTF-8');
  } catch {
    return { ok: false, reason: 'UNKNOWN_BINARY', detail: 'not decodable as text' };
  }
}

function textOrXml(t, encoding) {
  const s = t.replace(/^\uFEFF/, '').trimStart();
  if (s.startsWith('<?xml')) return { ok: true, kind: 'xml', encoding, detail: 'content is an XML document' };
  return { ok: true, kind: 'text', encoding };
}

/* ---- ZIP central directory (metadata only — nothing is extracted) -------- */

/**
 * Read the ZIP central directory: names + sizes, no inflation, no CRC.
 * The central directory is the authoritative inventory; checking it BEFORE
 * any extraction is what makes the zip-bomb caps cheap and safe.
 *
 * @returns {{ok:true, entries:Array<{name:string, compressedSize:number,
 *            uncompressedSize:number, isDirectory:boolean}>, declaredEntries:number}}
 *        |{{ok:false, reason:'EOCD_MISSING'|'ZIP64_UNSUPPORTED'|
 *            'CENTRAL_DIRECTORY_TRUNCATED'|'ENTRY_COUNT_MISMATCH', detail?:string}}
 */
function readZipCentralDirectory(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readZipCentralDirectory: bytes must be a Uint8Array/Buffer');
  const b = asBuffer(bytes);
  if (b.length < 22) return { ok: false, reason: 'EOCD_MISSING' };

  // Locate the end-of-central-directory record: scan backwards over the
  // maximum possible comment (65535 bytes) + the fixed 22-byte record. A
  // candidate is accepted only if its comment length lands exactly at EOF,
  // which prevents false positives inside compressed data.
  const floor = Math.max(0, b.length - (65535 + 22));
  let eocd = -1;
  for (let i = b.length - 22; i >= floor; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      if (i + 22 + b.readUInt16LE(i + 20) === b.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) return { ok: false, reason: 'EOCD_MISSING' };

  const declaredEntries = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || declaredEntries === 0xFFFF) {
    return { ok: false, reason: 'ZIP64_UNSUPPORTED', detail: 'ZIP64 records are not accepted from the boundary' };
  }
  if (cdOffset + cdSize > eocd) {
    return { ok: false, reason: 'CENTRAL_DIRECTORY_TRUNCATED', detail: `declared central directory [${cdOffset}, ${cdOffset + cdSize}) overruns the file` };
  }

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < declaredEntries; n++) {
    if (p + 46 > b.length) return { ok: false, reason: 'CENTRAL_DIRECTORY_TRUNCATED', detail: `entry ${n} header extends past EOF` };
    if (b.readUInt32LE(p) !== 0x02014b50) return { ok: false, reason: 'CENTRAL_DIRECTORY_TRUNCATED', detail: `entry ${n} lacks the central-directory signature` };
    const compressedSize = b.readUInt32LE(p + 20);
    const uncompressedSize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF) {
      return { ok: false, reason: 'ZIP64_UNSUPPORTED', detail: `entry ${n} uses ZIP64 size markers` };
    }
    const nameStart = p + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen + commentLen > b.length) return { ok: false, reason: 'CENTRAL_DIRECTORY_TRUNCATED', detail: `entry ${n} name extends past EOF` };
    const name = b.toString('utf8', nameStart, nameEnd);
    entries.push({ name, compressedSize, uncompressedSize, isDirectory: name.endsWith('/') });
    p = nameEnd + extraLen + commentLen;
  }
  if (p !== cdOffset + cdSize) {
    return { ok: false, reason: 'ENTRY_COUNT_MISMATCH', detail: `walked central directory does not match the declared span (${p} vs ${cdOffset + cdSize})` };
  }
  return { ok: true, entries, declaredEntries };
}

/* ---- zip-bomb caps ------------------------------------------------------- */

const NESTED_ARCHIVE_SUFFIXES = ['.zip', '.xlsx', '.xlsm', '.xlsb', '.docx', '.jar', '.7z', '.rar', '.gz'];

/**
 * Apply the zip-bomb caps to a parsed central directory. First violation
 * wins (deterministic). Directories are inert and skipped.
 *
 * Reason codes:
 *   ZIP_NESTED_ARCHIVE        an entry is itself an archive — XLSX never does this
 *   ZIP_ENTRY_COUNT_EXCEEDED  more entries than caps.maxEntries
 *   ZIP_RATIO_EXCEEDED        one entry inflates beyond caps.maxRatio:1 while
 *                             exceeding caps.ratioFloorBytes (the floor keeps
 *                             small, legitimately dense XML parts from tripping)
 *   ZIP_TOTAL_SIZE_EXCEEDED   inflated total beyond caps.maxTotalUncompressedBytes
 */
function checkZipCaps(entries, caps) {
  const c = { ...DEFAULT_CAPS, ...(caps || {}) };
  if (entries.length > c.maxEntries) {
    return { ok: false, reason: 'ZIP_ENTRY_COUNT_EXCEEDED', detail: `${entries.length} entries exceed the cap of ${c.maxEntries}` };
  }
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const lname = e.name.toLowerCase();
    if (NESTED_ARCHIVE_SUFFIXES.some((sfx) => lname.endsWith(sfx))) {
      return { ok: false, reason: 'ZIP_NESTED_ARCHIVE', detail: e.name };
    }
    total += e.uncompressedSize;
    if (e.uncompressedSize > c.ratioFloorBytes && e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > c.maxRatio) {
      return { ok: false, reason: 'ZIP_RATIO_EXCEEDED', detail: `${e.name}: inflates ${e.uncompressedSize} from ${e.compressedSize} (ratio ${(e.uncompressedSize / e.compressedSize).toFixed(0)}:1 > ${c.maxRatio}:1)` };
    }
  }
  if (total > c.maxTotalUncompressedBytes) {
    return { ok: false, reason: 'ZIP_TOTAL_SIZE_EXCEEDED', detail: `inflated total ${total} exceeds the cap of ${c.maxTotalUncompressedBytes}` };
  }
  return { ok: true, totalUncompressedBytes: total };
}

/* ---- formula stripping (cell level, after decode) ------------------------ */

// Same canonical-number literal family as parse.js: a plain negative number
// is data. Anything else starting with '-' is treated as an injection attempt.
const CANONICAL_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Neutralize spreadsheet formula injection (OWASP CSV-injection stance).
 * A cell whose first character is =, +, @, TAB or CR is prefixed with an
 * apostrophe — the standard escape that makes it inert in any spreadsheet —
 * and disclosed. A leading '-' is neutralized only when the cell is NOT a
 * plain canonical number. Non-string cells pass through untouched.
 *
 * This function never decides quarantine by itself: a neutralized cell that
 * claimed a numeric column will fail parseStrictNumber downstream. Hardening
 * kills the execution vector; the strict parser refuses the data.
 *
 * @returns {{ok:true, rows:any[][], stripped:Array<{row:number, col:number, prefix:string}>, count:number}}
 */
function stripFormulas(rows) {
  const stripped = [];
  const out = rows.map((row, ri) => row.map((cell, ci) => {
    if (typeof cell !== 'string' || cell.length === 0) return cell;
    const first = cell[0];
    let dangerous = first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r';
    if (!dangerous && first === '-' && !CANONICAL_NUMBER.test(cell.trim())) dangerous = true;
    if (!dangerous) return cell;
    stripped.push({ row: ri, col: ci, prefix: first });
    return "'" + cell; // OWASP apostrophe escape — inert as a formula, kept as text
  }));
  return { ok: true, rows: out, stripped, count: stripped.length };
}

/* ---- the gate ------------------------------------------------------------ */

const TEXT_EXTS = new Set(['csv', 'tsv', 'txt']);
const ARCHIVE_EXTS = new Set(['xlsx', 'xlsm', 'xlsb', 'zip']);
const XML_EXTS = new Set(['xml', 'xsd', 'svg', 'html', 'htm']);

function extensionOf(declaredName) {
  const s = String(declaredName || '').toLowerCase();
  const dot = s.lastIndexOf('.');
  return dot === -1 ? '' : s.slice(dot + 1);
}

function refuseReceipt(checks, reason, detail, sniffed, source, byteLength) {
  return {
    verdict: 'REFUSE',
    reason,
    detail: detail || '',
    source,
    sniffed: sniffed || null,
    bytes: byteLength,
    checks,
    task: {
      type: 'DATA_HEALTH', field: 'ingest',
      detail: `Inbound file refused (${reason})${detail ? ' — ' + detail : ''}. File quarantined whole; nothing was applied.`,
    },
    banner: { text: `Upload refused (${reason}). The file is quarantined whole — nothing was applied.` },
  };
}

/**
 * The single choke point for every inbound artifact. Order is fixed and
 * every step is recorded, so receipts are deterministic and auditable:
 * identical bytes + identical hook behavior ⇒ identical receipt, regardless
 * of whether the file arrived from the dropzone, the watched folder or an
 * email attachment ("email-in through the same pipeline" is enforced by
 * construction — the source is recorded, never consulted).
 *
 * AV hook contract: `avScan(bytes)` resolves to
 *   { clean: boolean, engine: string, signature?: string }
 * Fail-closed in every failure mode: infected ⇒ AV_INFECTED; throw or
 * malformed verdict ⇒ AV_SCAN_ERROR; no hook while avRequired (the default)
 * ⇒ AV_UNAVAILABLE. Production configures the scanner; until then the
 * boundary refuses rather than waves files through.
 */
async function gateInboundFile(input) {
  const { bytes, declaredName = '', source = 'dropzone', caps, avScan = null, avRequired = true } = input || {};
  if (!(bytes instanceof Uint8Array)) throw new TypeError('gateInboundFile: bytes must be a Uint8Array/Buffer');
  if (typeof declaredName !== 'string') throw new TypeError('gateInboundFile: declaredName must be a string');
  if (avScan !== null && typeof avScan !== 'function') throw new TypeError('gateInboundFile: avScan must be a function or null');

  const c = { ...DEFAULT_CAPS, ...(caps || {}) };
  const checks = [];
  const skip = (check, detail) => checks.push({ check, outcome: 'SKIP', detail });
  const pass = (check, detail) => checks.push({ check, outcome: 'PASS', detail });
  const refuse = (reason, detail, sniffed) => refuseReceipt(checks, reason, detail, sniffed, source, bytes.byteLength);

  // 1 — payload
  if (bytes.byteLength === 0) return refuse('EMPTY_PAYLOAD', 'empty upload');
  if (bytes.byteLength > c.maxBytes) return refuse('FILE_TOO_LARGE', `${bytes.byteLength} bytes exceed the cap of ${c.maxBytes}`);
  pass('payload', `${bytes.byteLength} bytes`);

  // 2 — magic bytes
  const s = sniffBytes(bytes);
  if (!s.ok) return refuse(s.reason, s.detail);
  const sniffed = s.kind;
  pass('magic', `${sniffed} (${s.encoding || s.detail})`);

  // 3 — declared identity must agree with content
  const ext = extensionOf(declaredName);
  if (sniffed === 'xml') return refuse('XML_REJECTED', 'content is an XML document — the XML family is not an ingestion format (XXE stance: refused, not mitigated)', sniffed);
  if (ext !== '') {
    if (XML_EXTS.has(ext)) return refuse('XML_REJECTED', `declared ".${ext}" — the XML family is not an ingestion format (XXE stance: refused, not mitigated)`, sniffed);
    if (sniffed === 'text' && ARCHIVE_EXTS.has(ext)) return refuse('DECLARED_MISMATCH', `content is text but the name says ".${ext}"`, sniffed);
    if (sniffed === 'zip' && TEXT_EXTS.has(ext)) return refuse('DECLARED_MISMATCH', `content is an archive but the name says ".${ext}"`, sniffed);
    pass('declared', `.${ext}`);
  } else {
    skip('declared', 'no extension declared');
  }

  // 4 — container: a ZIP must be an XLSX workbook
  let entries = null;
  if (sniffed === 'zip') {
    const cd = readZipCentralDirectory(bytes);
    if (!cd.ok) return refuse(cd.reason, cd.detail, sniffed);
    if (!looksLikeXlsx(cd.entries)) return refuse('UNSUPPORTED_ARCHIVE', 'archive lacks XLSX markers ([Content_Types].xml / xl/*) — arbitrary archives are not an ingestion format', sniffed);
    entries = cd.entries;
    pass('container', `XLSX workbook, ${entries.length} entries`);
  } else {
    skip('container', 'not an archive');
  }

  // 5 — zip-bomb caps
  if (entries) {
    const capres = checkZipCaps(entries, c);
    if (!capres.ok) return refuse(capres.reason, capres.detail, sniffed);
    pass('caps', `inflated total ${capres.totalUncompressedBytes} bytes within caps`);
  } else {
    skip('caps', 'not an archive');
  }

  // 6 — AV scan, fail-closed
  if (typeof avScan !== 'function') {
    if (avRequired) return refuse('AV_UNAVAILABLE', 'no scanner is configured and one is required — the boundary refuses rather than scans later', sniffed);
    skip('av', 'no scanner configured, not required');
  } else {
    let verdict;
    try {
      verdict = await avScan(bytes);
    } catch (e) {
      return refuse('AV_SCAN_ERROR', 'scanner threw: ' + String((e && e.message) || e), sniffed);
    }
    if (!verdict || typeof verdict !== 'object' || typeof verdict.clean !== 'boolean' || typeof verdict.engine !== 'string' || verdict.engine === '') {
      return refuse('AV_SCAN_ERROR', 'scanner returned a malformed verdict', sniffed);
    }
    if (!verdict.clean) {
      return refuse('AV_INFECTED', verdict.engine + (verdict.signature ? ' / ' + verdict.signature : ''), sniffed);
    }
    pass('av', `clean per ${verdict.engine}`);
  }

  return { verdict: 'ACCEPT', reason: null, detail: '', source, sniffed, bytes: bytes.byteLength, checks, task: null, banner: null };
}

module.exports = { DEFAULT_CAPS, sniffBytes, readZipCentralDirectory, checkZipCaps, stripFormulas, gateInboundFile };
