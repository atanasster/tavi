import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { TaviError } from "@tavi/contracts";
import { acquireDataDirectoryOwnership } from "./ownership.js";
import { wireError } from "./protocol.js";
import { serveWorker } from "./worker-server.js";

const optionsSchema = z.strictObject({
  dataDirectory: z.string(),
  sessionId: z.string().min(1),
  acquiredAt: z.string(),
  lockTimeoutMs: z.number().nonnegative().optional(),
  allowPublicDirectory: z.boolean().optional(),
});

if (parentPort === null) throw new Error("The ownership entry must run in a worker");
try {
  const { acquiredAt, ...options } = optionsSchema.parse(workerData);
  const owner = acquireDataDirectoryOwnership({
    dataDirectory: options.dataDirectory,
    sessionId: options.sessionId,
    now: () => acquiredAt,
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    ...(options.allowPublicDirectory === undefined ? {} : { allowPublicDirectory: options.allowPublicDirectory }),
  });
  serveWorker(
    parentPort,
    (operation) => {
      if (operation !== "info") throw new TaviError("INVALID_INPUT", "Unknown ownership operation");
      return { dataDirectory: owner.dataDirectory, lockPath: owner.lockPath, sessionId: owner.sessionId, acquiredAt: owner.acquiredAt };
    },
    () => {
      const result = owner.release();
      if (!result.released) throw new TaviError("UNAVAILABLE", result.error ?? "Ownership release failed");
    },
  );
} catch (error) {
  parentPort.postMessage({ type: "startup-error", error: wireError(error, "not-dispatched") });
  parentPort.close();
}
