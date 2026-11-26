// Minimal ZIP reader/writer, dependency-free.
//
// It exists for one specific, documented requirement. Azure App Service's
// ZipDeploy unpacks an archive straight into `/home/site/wwwroot`, and the
// docs are explicit:
//
//   "When you create the ZIP package for deployment, don't include the root
//    directory... If you download a GitHub repository as a ZIP file, you can't
//    deploy that file as-is to App Service. GitHub adds nested directories at
//    the top level, which doesn't work with App Service."
//
// A GitHub zipball wraps everything in `owner-repo-<sha>/`, so deploying it
// unchanged puts the app one directory deeper than App Service looks — the
// deploy reports success and the site serves nothing. `stripTopLevelDirectory`
// repacks it without that wrapper.
//
// Node ships no ZIP support (only raw DEFLATE via zlib), and adding a
// dependency for ~100 lines of well-specified format was not worth it. Scope
// is deliberately narrow: enough of the spec to re-pack an archive GitHub just
// produced, not a general-purpose library.
//
// Deliberately NOT handled, because a GitHub zipball never contains them:
// ZIP64 (>4GB or >65535 entries), encryption, multi-disk archives, and data
// descriptors with unknown sizes. Each is detected and reported rather than
// silently mis-parsed.
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

function fail(message) {
  const e = new Error(`ZIP: ${message}`);
  e.code = 'ZIP_MALFORMED';
  return e;
}

/**
 * Node 22 exposes `zlib.crc32`; older runtimes do not. The fallback is the
 * standard table-driven CRC-32, which ZIP requires for every entry — a wrong
 * checksum makes the archive unreadable rather than subtly broken, so this is
 * not a place to approximate.
 */
const CRC_TABLE = (() => {
  if (typeof crc32 === 'function') return null;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc(buf) {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** Finds the End Of Central Directory record, scanning back over any comment. */
function findEocd(buf) {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - maxComment - 22);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw fail('no End Of Central Directory record — not a ZIP archive');
}

/**
 * Reads every entry out of a ZIP buffer.
 *
 * Entries are read from the CENTRAL directory, not by walking local headers:
 * the central directory is authoritative about sizes, which is what makes this
 * safe against entries whose local header defers sizes to a data descriptor.
 */
export function readZipEntries(buf) {
  const eocd = findEocd(buf);

  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw fail('multi-disk archives are not supported');
  }

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw fail('ZIP64 archives are not supported');
  }
  // A ZIP64 locator immediately before the EOCD means the real values live
  // there; bail rather than read the 32-bit placeholders.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw fail('ZIP64 archives are not supported');
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw fail(`central directory entry ${i} is malformed`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crcStored = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (flags & 0x1) throw fail(`entry "${name}" is encrypted`);

    // Read the payload via the LOCAL header, whose variable-length fields can
    // differ in size from the central ones.
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw fail(`entry "${name}" has no local header`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      content = inflateRawSync(raw);
    } else {
      throw fail(`entry "${name}" uses unsupported compression method ${method}`);
    }

    if (content.length !== uncompressedSize) {
      throw fail(`entry "${name}" inflated to ${content.length} bytes, expected ${uncompressedSize}`);
    }
    if (crc(content) !== crcStored) {
      throw fail(`entry "${name}" failed its CRC check`);
    }

    entries.push({ name, content, isDirectory: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Builds a ZIP buffer from `{ name, content }` entries, DEFLATE-compressed. */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const content = entry.content ?? Buffer.alloc(0);
    const checksum = crc(content);

    // Store rather than deflate when compression does not help — which is the
    // case for already-compressed assets, and for empty directory entries.
    const deflated = content.length > 0 ? deflateRawSync(content) : Buffer.alloc(0);
    const useDeflate = deflated.length > 0 && deflated.length < content.length;
    const payload = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date — a fixed 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // External attrs: mark directories, and give files mode 0644 so the
    // unpacked tree is readable. Unix mode sits in the high 16 bits.
    central.writeUInt32LE(entry.isDirectory ? 0x41ed0010 : 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * Repacks an archive with its single top-level directory removed.
 *
 * This is the GitHub-zipball fix: `owner-repo-abc123/src/index.js` becomes
 * `src/index.js`, so App Service unpacks the app at the root of `wwwroot`
 * where it actually looks for it.
 *
 * Returns the buffer unchanged when the archive has no single common root, so
 * it is safe to call on an already-flat package.
 */
export function stripTopLevelDirectory(buf) {
  const entries = readZipEntries(buf);
  if (entries.length === 0) throw fail('archive is empty');

  const firstSegment = (name) => name.split('/')[0];
  const root = firstSegment(entries[0].name);
  const shared = root !== '' && entries.every((e) => firstSegment(e.name) === root);
  if (!shared) {
    return { buffer: buf, stripped: null, entryCount: entries.length };
  }

  const rebased = [];
  for (const e of entries) {
    const name = e.name.slice(root.length + 1);
    // Drops the wrapper's own directory entry, whose name is exactly the root.
    if (name === '') continue;
    rebased.push({ name, content: e.content, isDirectory: e.isDirectory });
  }
  if (rebased.length === 0) throw fail(`archive contains only the directory "${root}"`);

  return { buffer: writeZip(rebased), stripped: root, entryCount: rebased.length };
}
