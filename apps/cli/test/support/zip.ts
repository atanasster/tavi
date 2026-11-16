import { crc32, deflateRawSync } from "node:zlib";

/** A zip writer for tests of what reads zips (`.mcpb` bundles): entries as a bundle tool writes them, or damaged on purpose. */

export interface ZipEntry {
  readonly name: string;
  readonly data?: string | Buffer;
  /** A Unix mode (made by Unix); absent, made by DOS with no mode. */
  readonly mode?: number;
  readonly stored?: boolean;
  /** Overrides, to make a damaged entry. */
  readonly crc?: number;
  readonly flags?: number;
  /** Sizes and CRC after the data (flag bit 3), the local header's zero. */
  readonly descriptor?: boolean;
  /** A local extra field the central header does not carry. */
  readonly localExtra?: Buffer;
}

/** A zip of `entries`, as a bundle tool writes one: deflated unless stored, UTF-8 names; `comment` after its end record. */
export function zip(entries: readonly ZipEntry[], comment = ""): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const packed = entry.stored === true || entry.name.endsWith("/") ? data : deflateRawSync(data);
    const method = packed === data ? 0 : 8;
    const name = Buffer.from(entry.name, "utf8");
    const flags = 0x800 | (entry.flags ?? 0) | (entry.descriptor === true ? 0x8 : 0);
    const extra = entry.localExtra ?? Buffer.alloc(0);
    const crc = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (entry.descriptor !== true) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor === true ? 16 : 0);
    if (entry.descriptor === true) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, packed, descriptor);
    centrals.push(central, name);
    offset += local.length + name.length + extra.length + packed.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)]);
}
