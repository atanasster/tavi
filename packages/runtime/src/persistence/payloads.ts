import { workerTempDirectory } from "./temporary-files.js";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { TaviError } from "@tavi/contracts";

export const PAYLOAD_OPERATIONS = [
  "repository.artifacts.putArtifact",
  "store.readArtifactBody",
  "repository.artifacts.readArtifactBody",
  "checkpoint.get",
  "checkpoint.put",
  "checkpoint.putWrites",
  "checkpoint.nextCursor",
  "routine.publication.stage",
] as const;
export type PayloadOperation = (typeof PAYLOAD_OPERATIONS)[number];
export type PayloadResult = { kind: "inline"; value: unknown } | { kind: "file"; id: string; size: number };
export type PayloadOperations = {
  "payload.begin": { input: { size: number }; output: string };
  "payload.append": { input: { id: string; offset: number; bytes: Uint8Array }; output: void };
  "payload.execute": { input: { operation: PayloadOperation; id: string }; output: PayloadResult };
  "payload.inline": { input: { operation: PayloadOperation; input: unknown }; output: PayloadResult };
  "payload.read": { input: { id: string; offset: number }; output: Uint8Array };
  "payload.close": { input: string; output: void };
};
const CHUNK = 512 * 1024;
interface PayloadFile {
  path: string;
  fd: number;
  size: number;
  written: number;
  timer: ReturnType<typeof setTimeout>;
}
/** Private, expiring spool files keep large values out of the retained RPC queue. */
export class WorkerPayloads {
  readonly #files = new Map<string, PayloadFile>();
  readonly #root = workerTempDirectory();
  constructor() {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }
  #touch(id: string, file: PayloadFile): void {
    clearTimeout(file.timer);
    file.timer = setTimeout(() => this.remove(id), 30_000);
    file.timer.unref();
  }
  #get(id: string): PayloadFile {
    const file = this.#files.get(id);
    if (file === undefined) throw new TaviError("NOT_FOUND", "Payload transfer expired or closed");
    this.#touch(id, file);
    return file;
  }
  begin(size: number): string {
    if (!Number.isSafeInteger(size) || size < 1) throw new TaviError("INVALID_INPUT", "Invalid payload size");
    if (this.#files.size >= 4) throw new TaviError("BUDGET_EXCEEDED", "Payload transfer capacity is full");
    const id = randomUUID(),
      path = join(this.#root, id),
      fd = openSync(path, "wx+", 0o600);
    const timer = setTimeout(() => this.remove(id), 30_000);
    timer.unref();
    this.#files.set(id, { path, fd, size, written: 0, timer });
    return id;
  }
  append(input: PayloadOperations["payload.append"]["input"]): void {
    const file = this.#get(input.id);
    if (
      input.offset !== file.written ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > CHUNK ||
      file.written + input.bytes.byteLength > file.size
    )
      throw new TaviError("INVALID_INPUT", "Invalid payload chunk");
    let offset = 0;
    while (offset < input.bytes.byteLength) {
      const written = writeSync(file.fd, input.bytes, offset, input.bytes.byteLength - offset, file.written);
      if (written === 0) throw new TaviError("UNAVAILABLE", "Payload write made no progress");
      offset += written;
      file.written += written;
    }
  }
  #result(value: unknown): PayloadResult {
    const bytes = serialize(value);
    if (bytes.byteLength <= CHUNK) return { kind: "inline", value };
    const id = this.begin(bytes.byteLength),
      file = this.#get(id);
    try {
      writeFileSync(file.fd, bytes);
      file.written = bytes.byteLength;
      return { kind: "file", id, size: bytes.byteLength };
    } catch (error) {
      this.remove(id);
      throw error;
    }
  }
  execute(operation: PayloadOperation, input: unknown, dispatch: (operation: string, input: unknown) => unknown): PayloadResult {
    if (!PAYLOAD_OPERATIONS.includes(operation)) throw new TaviError("INVALID_INPUT", "Operation does not support payload transfer");
    return this.#result(dispatch(operation, input));
  }
  invoke(operation: PayloadOperation, id: string, dispatch: (operation: string, input: unknown) => unknown): PayloadResult {
    const file = this.#get(id);
    if (file.written !== file.size || fstatSync(file.fd).size !== file.size)
      throw new TaviError("INVALID_INPUT", "Incomplete payload transfer");
    let input: unknown;
    try {
      input = deserialize(readFileSync(file.path));
    } finally {
      this.remove(id);
    }
    return this.execute(operation, input, dispatch);
  }
  read(id: string, offset: number): Uint8Array {
    const file = this.#get(id);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size || file.written !== file.size)
      throw new TaviError("INVALID_INPUT", "Invalid payload read");
    const bytes = Buffer.allocUnsafe(Math.min(CHUNK, file.size - offset));
    let read = 0;
    while (read < bytes.byteLength) {
      const count = readSync(file.fd, bytes, read, bytes.byteLength - read, offset + read);
      if (count === 0) throw new TaviError("UNAVAILABLE", "Incomplete payload file");
      read += count;
    }
    return bytes;
  }
  remove(id: string): void {
    const file = this.#files.get(id);
    if (file === undefined) return;
    this.#files.delete(id);
    clearTimeout(file.timer);
    try {
      closeSync(file.fd);
    } finally {
      rmSync(file.path, { force: true });
    }
  }
  close(): void {
    for (const id of this.#files.keys()) this.remove(id);
    rmSync(this.#root, { recursive: true, force: true });
  }
}
