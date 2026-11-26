import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

/**
 * Random access to the parts of a zip held in memory: the container of an Excel
 * workbook (`.xlsx`), for the roster upload's conversion to CSV (`agency-xlsx.ts`, IM8).
 *
 * A LEAF over `node:zlib`: no I/O beyond the buffer it is given.
 *
 * ── Why the central directory and not a streaming unzip ─────────────────────
 * The upload is already one Buffer (the multipart body), so the zip's central
 * directory, at its end, lists every part with its offset. Reading it lets the
 * converter open exactly the parts it needs (the workbook, its relationships,
 * the styles, the shared strings, ONE sheet) in the order it needs them,
 * whatever order the writer stored them in. A streaming unzip meets the parts
 * in file order, and Excel stores the sheets BEFORE the shared strings they
 * index, so a streaming reader has to park every sheet somewhere (exceljs's
 * `WorkbookReader` writes each one to a temporary file on disk) until the
 * strings arrive.
 *
 * ── Bounded output ──────────────────────────────────────────────────────────
 * A deflated part can expand about a thousand times. {@link openZipEntry} feeds
 * the compressed bytes to the inflater a slice at a time, so the inflater
 * waits for its reader instead of expanding the whole part ahead of it, and
 * stops with {@link ZipEntryTooLargeError} once a part has produced more than
 * the caller's `maxBytes`.
 *
 * ── Bounded work ────────────────────────────────────────────────────────────
 * A directory of more than {@link MAX_ZIP_ENTRIES} parts is refused before it is walked;
 * a part listed twice, a zip64 field outside its extra field, and a local header that
 * names another part or method than the directory are refused as damage.
 */

/** A part of the zip, as its central directory describes it. */
export interface ZipEntry {
  /** The part's name as stored (`xl/worksheets/sheet1.xml`). */
  name: string;
  /** 0 (stored) or 8 (deflated); anything else cannot be read. */
  method: number;
  /** General-purpose flags; bit 0 means the part is encrypted. */
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where the part's local header starts. */
  localHeaderOffset: number;
}

/** The bytes are not a zip this reader can read: truncated, damaged, or a kind it does not support. */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

/** A part expanded past the `maxBytes` its reader allowed. */
export class ZipEntryTooLargeError extends Error {
  constructor(public readonly entryName: string, public readonly maxBytes: number) {
    super(`The part ${entryName} expands to more than ${maxBytes} bytes.`);
    this.name = 'ZipEntryTooLargeError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
/** Parts a zip may list. A workbook has a few dozen; a directory of millions is only work. */
const MAX_ZIP_ENTRIES = 10_000;
const MAX_COMMENT = 0xffff;
/** Compressed bytes handed to the inflater per write: the most one write can expand to is about 1,000 times this. */
const INFLATE_SLICE_BYTES = 8 * 1024;

function u64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('A zip64 field is out of range.');
  return Number(value);
}

function need(buf: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buf.length) {
    throw new ZipFormatError('The zip is truncated or damaged.');
  }
}

/**
 * Every part the central directory lists, keyed by name lower-cased (part names
 * in a workbook are compared without case, as Excel does). Throws
 * {@link ZipFormatError} when the directory cannot be found or read.
 */
export function readZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length < EOCD_MIN) throw new ZipFormatError('The file is too short to be a zip.');

  let eocd = -1;
  const lowest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipFormatError('The zip has no central directory.');

  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    need(buf, locator, 20);
    if (buf.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipFormatError('The zip64 end record is missing.');
    }
    const zip64Eocd = u64(buf, locator + 8);
    need(buf, zip64Eocd, 56);
    if (buf.readUInt32LE(zip64Eocd) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipFormatError('The zip64 end record is damaged.');
    }
    total = u64(buf, zip64Eocd + 32);
    cdSize = u64(buf, zip64Eocd + 40);
    cdOffset = u64(buf, zip64Eocd + 48);
  }
  if (total > MAX_ZIP_ENTRIES) throw new ZipFormatError(`The zip lists ${total} parts; a workbook has far fewer.`);
  if (cdSize < total * 46) throw new ZipFormatError('The zip directory is shorter than its entries.');
  need(buf, cdOffset, cdSize);

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < total; n += 1) {
    need(buf, p, 46);
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new ZipFormatError('The zip directory is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    need(buf, p + 46, nameLength + extraLength + commentLength);
    // Bit 11: the name is UTF-8. Otherwise it is CP437, of which the parts of a
    // workbook use only the ASCII half.
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength);

    // Zip64: the sizes and offset that did not fit are in the extra field 0x0001, in this order.
    // Every read stays inside the extra field as the directory sized it (and the buffer).
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e);
      const size = buf.readUInt16LE(e + 2);
      const end = Math.min(e + 4 + size, extraEnd);
      if (id === 0x0001) {
        let q = e + 4;
        const field = (): number => {
          if (q + 8 > end) throw new ZipFormatError('A zip64 field is cut short.');
          need(buf, q, 8);
          const value = u64(buf, q);
          q += 8;
          return value;
        };
        if (uncompressedSize === 0xffffffff) uncompressedSize = field();
        if (compressedSize === 0xffffffff) compressedSize = field();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = field();
      }
      e += 4 + size;
    }

    const key = name.toLowerCase();
    if (entries.has(key)) throw new ZipFormatError(`The zip lists the part ${name} twice.`);
    entries.set(key, { name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    p = extraEnd + commentLength;
  }
  return entries;
}

/**
 * Where a part's compressed bytes start: past its local header, whose extra length may
 * differ from the directory's. The local header must name the same part with the same
 * method, so the bytes read are the ones the directory describes.
 */
function dataOffset(buf: Buffer, entry: ZipEntry): number {
  const at = entry.localHeaderOffset;
  need(buf, at, 30);
  if (buf.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new ZipFormatError(`The part ${entry.name} is damaged.`);
  const nameLength = buf.readUInt16LE(at + 26);
  need(buf, at + 30, nameLength);
  const flags = buf.readUInt16LE(at + 6);
  const localName = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 30, at + 30 + nameLength);
  if (localName !== entry.name || buf.readUInt16LE(at + 8) !== entry.method) {
    throw new ZipFormatError(`The part ${entry.name} does not match its directory entry.`);
  }
  const start = at + 30 + nameLength + buf.readUInt16LE(at + 28);
  need(buf, start, entry.compressedSize);
  return start;
}

/**
 * A part's uncompressed bytes as a stream, ending with {@link ZipEntryTooLargeError}
 * once more than `maxBytes` have come out, or {@link ZipFormatError} for a part
 * that is encrypted, compressed some other way, or damaged.
 */
export function openZipEntry(buf: Buffer, entry: ZipEntry, maxBytes: number): Readable {
  if (entry.flags & 0x1) throw new ZipFormatError(`The part ${entry.name} is encrypted.`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipFormatError(`The part ${entry.name} is compressed in a way that cannot be read.`);
  }
  const start = dataOffset(buf, entry);
  const data = buf.subarray(start, start + entry.compressedSize);

  function* slices(): Generator<Buffer> {
    for (let i = 0; i < data.length; i += INFLATE_SLICE_BYTES) yield data.subarray(i, i + INFLATE_SLICE_BYTES);
  }
  const compressed = Readable.from(slices(), { objectMode: false });
  const raw: Readable = entry.method === 8 ? compressed.pipe(createInflateRaw()) : compressed;
  if (entry.method === 8) compressed.on('error', (err) => raw.destroy(err));

  let produced = 0;
  async function* bounded(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of raw as AsyncIterable<Buffer>) {
        produced += chunk.length;
        if (produced > maxBytes) throw new ZipEntryTooLargeError(entry.name, maxBytes);
        yield chunk;
      }
    } catch (err) {
      if (err instanceof ZipEntryTooLargeError) throw err;
      throw new ZipFormatError(`The part ${entry.name} could not be decompressed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      compressed.destroy();
      raw.destroy();
    }
  }
  return Readable.from(bounded(), { objectMode: false });
}
