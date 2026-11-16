import { z } from "zod";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { WorkerChannel } from "./worker-channel.js";
import { persistenceWorkerUrl } from "./worker-url.js";
import type { AcquireOwnershipOptions } from "./ownership.js";

const ownerInfoSchema = z.strictObject({ dataDirectory: z.string(), lockPath: z.string(), sessionId: z.string(), acquiredAt: z.string() });

export class AsyncDataDirectoryOwner {
  readonly dataDirectory: string;
  readonly lockPath: string;
  readonly sessionId: string;
  readonly acquiredAt: string;
  readonly failed: Promise<Error>;
  readonly #channel: WorkerChannel;
  #released = false;

  private constructor(channel: WorkerChannel, info: z.infer<typeof ownerInfoSchema>) {
    this.#channel = channel;
    this.dataDirectory = info.dataDirectory;
    this.lockPath = info.lockPath;
    this.sessionId = info.sessionId;
    this.acquiredAt = info.acquiredAt;
    this.failed = channel.failed.then((error) => {
      this.#released = true;
      return error;
    });
  }

  static async acquire(options: AcquireOwnershipOptions): Promise<AsyncDataDirectoryOwner> {
    const { now, ...input } = options;
    const channel = new WorkerChannel(persistenceWorkerUrl("ownership-worker"), {
      execArgv: [],
      workerData: { ...input, acquiredAt: (now ?? nowTimestamp)() },
    });
    try {
      await channel.ready;
      return new AsyncDataDirectoryOwner(channel, ownerInfoSchema.parse(await channel.request("info", undefined)));
    } catch (error) {
      await channel.abort();
      throw error;
    }
  }

  get released(): boolean {
    return this.#released || !this.#channel.available;
  }

  async release(): Promise<{ readonly released: boolean; readonly error?: string }> {
    this.#released = true;
    try {
      await this.#channel.close();
      return { released: true };
    } catch (error) {
      return { released: false, error: errorMessage(error) };
    }
  }

  /** Abort retains the process record so a live predecessor cannot be replaced. */
  async abort(): Promise<void> {
    this.#released = true;
    await this.#channel.abort();
  }
}

export const acquireDataDirectoryOwnership = (options: AcquireOwnershipOptions): Promise<AsyncDataDirectoryOwner> =>
  AsyncDataDirectoryOwner.acquire(options);
