import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TaviError, type BrowserLiveMessage, type BrowserLiveWatchAnswer } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import type { IpcClient } from "@tavi/runtime";

import type { BrowserLiveOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";

export interface BrowserLiveCliDependencies {
  readonly client: IpcClient;
  readonly stdout: (text: string) => void;
  /** Resolves when the operator asks to stop. */
  readonly stop: Promise<void>;
}

/**
 * `tavi browser live <task-id> --out <dir>`: a debug aid for the live view. It opens a `browser-live` watch on
 * the live owner, writes every frame it receives to `<dir>` as a JPEG
 * (`<session>-<n>.jpg`), acknowledges each once written — that is the
 * stream's pace — and prints one line for everything else. It ends after
 * `--frames` frames, once every session it watched has ended, or when
 * `stop` resolves (Ctrl-C), and unwatches on the way out.
 *
 * Throws the owner's refusal with its code (`NOT_FOUND` for an unknown task
 * or session), `UNAVAILABLE` when the owner goes away mid-watch, and a write
 * failure as it happened.
 */
export async function browserLiveCli(
  options: Omit<BrowserLiveOptions, "dataDirectory">,
  deps: BrowserLiveCliDependencies,
): Promise<{ readonly frames: number }> {
  await mkdir(options.out, { recursive: true, mode: 0o700 });
  const { client } = deps;
  let counter = 0;
  const request = (payload: Record<string, unknown>) => client.request("browser-live", payload, `browser-live-${(counter += 1)}`);
  const live = new Set<string>();
  let frames = 0;
  let subscriptionId: string | undefined;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let writing: Promise<void> = Promise.resolve();
  let failure: unknown;
  const perSession = new Map<string, number>();

  const handle = (seq: number, message: BrowserLiveMessage): void => {
    switch (message.kind) {
      case "session":
        if (message.state === "open") live.add(message.sessionId);
        else live.delete(message.sessionId);
        deps.stdout(
          `session ${message.sessionId} (task ${message.taskId}): ${message.state}${message.url === undefined ? "" : ` at ${terminalText(message.url)}`}\n`,
        );
        return;
      case "navigated":
        deps.stdout(
          `${message.sessionId}: ${terminalText(message.url)}${message.title === undefined ? "" : ` — ${terminalText(message.title)}`}\n`,
        );
        return;
      case "action":
        deps.stdout(
          `${message.sessionId}: ${message.action} ${message.phase}${message.status === undefined ? "" : ` (${message.status})`}\n`,
        );
        return;
      case "hidden":
        deps.stdout(`${message.sessionId}: hidden (${message.reason})\n`);
        return;
      case "ended":
        live.delete(message.sessionId);
        deps.stdout(`${message.sessionId}: ended (${terminalText(message.reason)})\n`);
        // A watch of one session is over with it; a watch of a task tree waits for the next.
        if (options.sessionId !== undefined || live.size === 0) finish();
        return;
      case "frame": {
        if (failure !== undefined || (options.frames !== undefined && frames >= options.frames)) return;
        frames += 1;
        const index = (perSession.get(message.sessionId) ?? 0) + 1;
        perSession.set(message.sessionId, index);
        const path = join(options.out, `${message.sessionId}-${String(index).padStart(5, "0")}.jpg`);
        const done = frames === options.frames;
        writing = writing.then(async () => {
          try {
            await writeFile(path, Buffer.from(message.data, "base64"), { mode: 0o600 });
          } catch (error) {
            // Unacknowledged, the stream would stall: stop and say why.
            failure ??= error;
            finish();
            return;
          }
          deps.stdout(`${message.sessionId}: ${message.source} frame ${message.width}×${message.height} → ${path}\n`);
          if (done) finish();
          else if (subscriptionId !== undefined) await request({ action: "ack", subscriptionId, seq });
        });
        return;
      }
    }
  };

  const stopListening = client.onLive((frame) => {
    if (frame.subscriptionId === subscriptionId) handle(frame.seq, frame.message);
  });
  try {
    const answer = await client.request(
      "browser-live",
      {
        action: "watch",
        workspaceId: options.workspaceId,
        taskId: options.taskId,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
      },
      "browser-live-watch",
      {
        // As the answer is read, before the messages that follow it in the same chunk.
        onResponse: (response) => {
          if (response.ok) subscriptionId = (response.result as BrowserLiveWatchAnswer).subscriptionId;
        },
      },
    );
    if (!answer.ok) {
      const code = answer.error?.code;
      throw new TaviError(
        code === "NOT_FOUND" || code === "INVALID_INPUT" ? code : "UNAVAILABLE",
        terminalText(answer.error?.message ?? "the owner refused the watch"),
      );
    }
    const watched = answer.result as BrowserLiveWatchAnswer;
    for (const session of watched.sessions) if (session.state !== "closed") live.add(session.sessionId);
    if (options.sessionId !== undefined && live.size === 0) {
      deps.stdout(`session ${options.sessionId} is closed: nothing streams from it\n`);
      return { frames };
    }
    if (live.size === 0) deps.stdout(`no open browser session in task ${options.taskId}; waiting for one\n`);
    let gone: () => void = () => undefined;
    const closed = new Promise<"closed">((resolve) => (gone = () => resolve("closed")));
    const stopClose = client.onClose(gone);
    const how = await Promise.race([finished, deps.stop, closed]);
    stopClose();
    await writing;
    if (failure !== undefined) throw failure;
    if (how === "closed") throw new TaviError("UNAVAILABLE", `the owner went away after ${plural(frames, "frame")}`);
    return { frames };
  } finally {
    stopListening();
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    if (subscriptionId !== undefined) await request({ action: "unwatch", subscriptionId }).catch(() => undefined);
  }
}
