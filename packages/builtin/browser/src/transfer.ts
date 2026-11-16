import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type BrowserActionOutcome,
  type BrowserAction,
  TaviError,
  isModelVisibleArtifact,
  folderFileName,
  browserArtifactLabel,
  DEFAULT_BROWSER_DOWNLOAD_MAX_MIB,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import type { Locator, Page, BrowserContext, Download } from "playwright";

import { limitOf } from "./action-kit.js";
import {
  type UploadableArtifact,
  UPLOAD_IN_MEMORY_MAX_BYTES,
  mediaTypeOf,
  UPLOAD_MAX_BYTES,
  safeUploadName,
  readBoundedDownload,
  sniffDownloadMediaType,
} from "./download-media.js";
import { readPdfBytes } from "./navigation.js";
import type { SessionRecord, BrowserRuntime } from "./session-types.js";
import { DOWNLOAD_TIMEOUT_MS, abortedBy, stopDownload, ACTION_TIMEOUT_MS } from "./timing.js";

/**
 * Hand already-authorized bytes to the page's file input.
 *
 * Chromium reads a file input's file when its form is sent, not when it is
 * set, so the file must outlive this call: the bytes go in the call and the
 * page holds the file itself, or — past Playwright's in-memory bound, and only
 * for an unconfined Chromium that can read the owner's staging directory — a
 * staged copy stays until the session closes. (Removing that copy as soon as
 * `setInputFiles` returned sent the form with `ERR_FILE_NOT_FOUND`.)
 *
 * Everything that can refuse an upload happens in `requireUploadableArtifact`
 * *before* this function runs, so no authorization decision is ever wrapped by
 * `runWriteAction`'s "a write may have half-happened" softening — a refusal is
 * a confirmed failure, never an `uncertain` outcome.
 */
export async function uploadTo(
  ctx: BrowserRuntime,
  session: SessionRecord,
  locator: Locator,
  upload: UploadableArtifact,
): Promise<BrowserActionOutcome> {
  if (ctx.confined !== undefined || upload.body.byteLength <= UPLOAD_IN_MEMORY_MAX_BYTES) {
    await locator.setInputFiles({ name: upload.fileName, mimeType: mediaTypeOf(upload.fileName), buffer: Buffer.from(upload.body) });
    return { status: "accepted" };
  }
  const directory = await mkdtemp(join(ctx.options.stagingDirectory, "tavi-browser-upload-"));
  try {
    const path = join(directory, upload.fileName);
    await writeFile(path, upload.body);
    await locator.setInputFiles(path);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  (session.uploadDirectories ??= []).push(directory);
  return { status: "accepted" };
}

/**
 * Hand an artifact's bytes to the page.
 *
 * Ownership and review state are checked **before** the body is read, because
 * this is an egress point to an attacker-reachable destination: `navigate`
 * takes a model-authored URL with no host allowlist, so a `pending` artifact
 * (exactly the content the review gate exists to withhold) or one owned by a
 * different workspace must never become readable by the page. The Telegram
 * delivery path enforces the same two conditions in
 * `apps/cli/src/runtime/composition.ts`.
 *
 * Two deliberate differences from that path, so a later reader does not
 * "unify" them in the wrong direction: the refusal is a typed
 * `NOT_AUTHORIZED` with a reason (the model can act on the difference between
 * "no such artifact" and "not yours"), and that reason never echoes the
 * artifact's review state, which the Telegram path withholds entirely.
 *
 * The ownership comparison is only sound because `session.workspaceId` is the
 * *invoking* task's workspace: `browser.create_session` binds it to
 * `InvocationContext.workspaceId` and refuses a model-supplied mismatch. If a
 * caller could ever open a session in a workspace of its own choosing, this
 * check would compare two caller-controlled values and enforce nothing.
 */
export async function requireUploadableArtifact(
  ctx: BrowserRuntime,
  session: SessionRecord,
  action: BrowserAction,
): Promise<UploadableArtifact> {
  if (action.artifactId === undefined) {
    throw new TaviError("INVALID_INPUT", "upload requires an artifactId — never a raw local path");
  }
  if (ctx.options.artifacts === undefined) {
    throw new TaviError("NOT_CONFIGURED", "No artifact store is configured for this adapter; pass { artifacts } to upload files");
  }
  const record = await ctx.options.artifacts.getArtifact(action.artifactId);
  // An internal artifact (a session thumbnail) is not the model's to hand
  // anywhere: refused exactly as a missing one.
  if (record === undefined || !isModelVisibleArtifact(record)) {
    throw new TaviError("NOT_FOUND", `No artifact ${action.artifactId}`);
  }
  if (record.workspaceId !== session.workspaceId) {
    throw new TaviError("NOT_AUTHORIZED", `Artifact ${action.artifactId} belongs to another workspace and cannot be uploaded`, {
      details: { artifactId: action.artifactId },
    });
  }
  if (record.reviewState !== "approved") {
    throw new TaviError("NOT_AUTHORIZED", `Artifact ${action.artifactId} is not approved for release`, {
      details: { artifactId: action.artifactId },
    });
  }
  // Bounded before the read, exactly as the Telegram path does: comparing after
  // it would allocate an unbounded buffer only to reject it, and here the
  // destination is an attacker-chosen page.
  if (record.byteSize > UPLOAD_MAX_BYTES) {
    throw new TaviError("INVALID_INPUT", `Artifact ${action.artifactId} is too large to upload (${record.byteSize} bytes)`, {
      details: { artifactId: action.artifactId, byteSize: record.byteSize },
    });
  }
  // A confined Chromium reads no staged file, and Playwright hands a page no more than this from memory.
  if (ctx.confined !== undefined && record.byteSize > UPLOAD_IN_MEMORY_MAX_BYTES) {
    throw new TaviError(
      "INVALID_INPUT",
      `Artifact ${action.artifactId} is too large to upload from a confined browser (${record.byteSize} bytes)`,
      {
        details: { artifactId: action.artifactId, byteSize: record.byteSize },
      },
    );
  }
  const body = await ctx.options.artifacts.readArtifactBody(action.artifactId);
  if (body === undefined) {
    throw new TaviError("NOT_FOUND", `No artifact ${action.artifactId}`);
  }
  // The record the authorization decision was made against must describe the
  // bytes being released: a store whose record and body disagree would
  // otherwise hand the page a different artifact than the one approved.
  if (body.byteLength !== record.byteSize) {
    throw new TaviError("INTERNAL", `Artifact ${action.artifactId} is unreadable: its stored size does not match its record`);
  }
  return { body, fileName: safeUploadName(record) };
}

interface DownloadMonitor {
  readonly maxMiB: number;
  readonly maxBytes: number;
  readonly responseLengths: Map<string, number>;
  readonly getLastDeclaredLength: () => number | undefined;
  readonly setLastDeclaredLength: (value: number) => void;
  readonly rejectOverCap: (error: TaviError) => void;
  readonly overCapPromise: Promise<never>;
  readonly attachCdp: (session: SessionRecord) => Promise<void>;
  /** Names the download that fired, for a `"download"`-scoped monitor: only that URL's response counts against the cap. */
  readonly watchDownload: (url: string | undefined) => void;
  readonly cleanup: () => Promise<void>;
}

/**
 * Watches a page for a download over `maxMiB`. Scoped `"any"` (a click that
 * downloads), any over-cap response rejects `overCapPromise`; scoped
 * `"download"` (a navigation, which loads a page's subresources too, a large
 * video among them), a response counts only once `watchDownload` names the
 * download's URL. The browser's own download progress counts either way.
 */
export function startDownloadMonitor(page: Page, maxMiB: number, scope: "any" | "download" = "any"): DownloadMonitor {
  const maxBytes = Math.floor(maxMiB * 1024 * 1024);
  const responseLengths = new Map<string, number>();
  let watchedUrl: string | undefined;
  let lastDeclaredLength: number | undefined;
  let rejectOverCapFn: ((error: TaviError) => void) | undefined;
  const overCapPromise = new Promise<never>((_resolve, reject) => {
    rejectOverCapFn = reject;
  });
  void overCapPromise.catch(() => undefined);

  const onResponse = (response: { url?: () => string; headers?: () => Record<string, string> }): void => {
    const raw = response.headers?.()["content-length"];
    if (raw === undefined) return;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const responseUrl = response.url?.();
    if (typeof responseUrl === "string" && responseUrl.length > 0) {
      responseLengths.set(responseUrl, parsed);
    }
    if (scope === "download" && (watchedUrl === undefined || responseUrl !== watchedUrl)) return;
    lastDeclaredLength = parsed;
    if (parsed > maxBytes) {
      rejectOverCapFn?.(
        new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit (Content-Length is ${parsed} bytes)`),
      );
    }
  };
  const pageEmitter = page as unknown as {
    on?: (event: string, listener: (response: { url?: () => string; headers?: () => Record<string, string> }) => void) => void;
    off?: (event: string, listener: (response: { url?: () => string; headers?: () => Record<string, string> }) => void) => void;
    removeListener?: (event: string, listener: (response: { url?: () => string; headers?: () => Record<string, string> }) => void) => void;
  };
  pageEmitter.on?.("response", onResponse);

  let cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
  return {
    maxMiB,
    maxBytes,
    responseLengths,
    getLastDeclaredLength: () => lastDeclaredLength,
    setLastDeclaredLength: (value) => {
      lastDeclaredLength = value;
    },
    rejectOverCap: (error) => rejectOverCapFn?.(error),
    overCapPromise,
    watchDownload: (url) => {
      if (url === undefined || url === "") return;
      watchedUrl = url;
      const declared = responseLengths.get(url);
      if (declared === undefined) return;
      lastDeclaredLength = declared;
      if (declared > maxBytes) {
        rejectOverCapFn?.(
          new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit (Content-Length is ${declared} bytes)`),
        );
      }
    },
    attachCdp: async (session: SessionRecord) => {
      if (cdp !== undefined || typeof session.context?.newCDPSession !== "function") return;
      cdp = await session.context.newCDPSession(page).catch(() => undefined);
      if (cdp !== undefined) {
        cdp.on("Page.downloadProgress", (payload: { totalBytes?: number; receivedBytes?: number }) => {
          if (typeof payload.totalBytes === "number" && payload.totalBytes > 0) {
            lastDeclaredLength = payload.totalBytes;
            if (payload.totalBytes > maxBytes) {
              rejectOverCapFn?.(
                new TaviError(
                  "INVALID_INPUT",
                  `Download exceeds the ${maxMiB} MiB size limit (Content-Length is ${payload.totalBytes} bytes)`,
                ),
              );
              return;
            }
          }
          if (typeof payload.receivedBytes === "number" && payload.receivedBytes > maxBytes) {
            rejectOverCapFn?.(new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit`));
          }
        });
        await cdp.send("Page.enable").catch(() => undefined);
      }
    },
    cleanup: async () => {
      if (typeof pageEmitter.off === "function") pageEmitter.off("response", onResponse);
      else pageEmitter.removeListener?.("response", onResponse);
      await cdp?.detach().catch(() => undefined);
      cdp = undefined;
    },
  };
}

/**
 * The finished file of a download a navigation started, waited for no longer
 * than the download deadline, the cap, or the call: past any of them the
 * download is cancelled and refused. A download the browser itself failed
 * answers `failed`, the navigation's own error.
 */
export async function finishedDownload(
  download: Download,
  monitor: DownloadMonitor,
  signal: AbortSignal,
  failed: unknown,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TaviError("UNAVAILABLE", `Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} s`));
      }, DOWNLOAD_TIMEOUT_MS);
    });
    return await Promise.race([download.path(), timeout, monitor.overCapPromise, abortedBy(signal)]);
  } catch (error) {
    if (error instanceof TaviError) {
      await stopDownload(download, true);
      throw error;
    }
    throw failed;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function saveCapturedDownload(
  ctx: BrowserRuntime,
  session: SessionRecord,
  download: Download,
  contextLabel: BrowserAction["contextLabel"],
  monitor: DownloadMonitor,
): Promise<BrowserActionOutcome> {
  if (ctx.options.artifacts === undefined) {
    throw new TaviError("NOT_CONFIGURED", "No artifact store is configured for this adapter; pass { artifacts } to download files");
  }
  const { maxMiB, maxBytes, responseLengths, overCapPromise } = monitor;
  await monitor.attachCdp(session);

  const cancelDownload = (target: Download): Promise<void> => stopDownload(target, true);

  const declaredLengthOf = (): number | undefined => {
    const explicit = (download as { readonly contentLength?: number }).contentLength;
    if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
    const downloadUrl = typeof download.url === "function" ? download.url() : undefined;
    return (downloadUrl !== undefined ? responseLengths.get(downloadUrl) : undefined) ?? monitor.getLastDeclaredLength();
  };

  const initialDeclared = declaredLengthOf();
  if (initialDeclared !== undefined && initialDeclared > maxBytes) {
    await cancelDownload(download);
    throw new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit (Content-Length is ${initialDeclared} bytes)`);
  }

  let path: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Real Playwright's `Download.path()` is typed `Promise<string>`
    // and throws for a failed/canceled download — it never resolves
    // `null` (confirmed against the installed `playwright-core`
    // types). The failure case is caught here, not branched on a
    // return value the real API never produces.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TaviError("UNAVAILABLE", `Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} s`));
      }, DOWNLOAD_TIMEOUT_MS);
    });
    path = await Promise.race([download.path(), timeoutPromise, overCapPromise]);
  } catch (error) {
    const postDeclared = declaredLengthOf();
    if (postDeclared !== undefined && postDeclared > maxBytes) {
      await cancelDownload(download);
      throw new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit (Content-Length is ${postDeclared} bytes)`);
    }
    if (error instanceof TaviError) {
      await cancelDownload(download);
      throw error;
    }
    // No reason read: the download is reported failed without one.
    const reason = typeof download.failure === "function" ? await download.failure().catch(() => null) : null;
    return { status: "rejected", detail: reason ?? errorMessage(error, "the download failed or was canceled") };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const finalDeclared = declaredLengthOf();
  if (finalDeclared !== undefined && finalDeclared > maxBytes) {
    await cancelDownload(download);
    throw new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit (Content-Length is ${finalDeclared} bytes)`);
  }

  const streamed = await readBoundedDownload(path, maxBytes);
  if (streamed.overCap) {
    await cancelDownload(download);
    throw new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit`);
  }

  // The page's suggested name, made safe (no path, no leading dot, no bidi
  // or control characters, bounded): the name the file gets in the chat's
  // `downloads/` once approved.
  const fileName = folderFileName(download.suggestedFilename(), "download");
  const contentType = sniffDownloadMediaType(streamed.body, fileName);
  if (contentType === "application/pdf") {
    const pdfText = await readPdfBytes(ctx, streamed.body);
    if (pdfText !== "") {
      const downloadUrl = typeof download.url === "function" ? download.url() : undefined;
      session.pdfPage = { url: downloadUrl || session.page.url(), hostPageUrl: session.page.url(), text: pdfText, title: fileName };
    }
  }
  const artifactId = prefixedId("art");
  const artifact = await ctx.options.artifacts.putArtifact({
    artifactId,
    // The page's, from `downloads/`, with the calling conversation's.
    label: browserArtifactLabel({ contextLabel, source: "download", pageUrl: session.page.url(), ref: artifactId, at: ctx.now() }),
    workspaceId: session.workspaceId,
    ...(session.taskId === undefined ? {} : { runId: session.taskId }),
    contentType,
    body: streamed.body,
    extension: fileName.includes(".") ? (fileName.split(".").pop() ?? "bin") : "bin",
    // A downloaded file is genuinely untrusted external content, same
    // reasoning as `capture()` above. Pending, it is never
    // copied into the chat's folder.
    reviewState: "pending",
    fileName,
    folderCopy: "downloads",
  });
  return { status: "accepted", detail: `saved as artifact ${artifact.artifactId}`, artifactId: artifact.artifactId };
}

export async function downloadFrom(
  ctx: BrowserRuntime,
  session: SessionRecord,
  locator: Locator,
  contextLabel: BrowserAction["contextLabel"],
): Promise<BrowserActionOutcome> {
  if (ctx.options.artifacts === undefined) {
    throw new TaviError("NOT_CONFIGURED", "No artifact store is configured for this adapter; pass { artifacts } to download files");
  }
  const monitor = startDownloadMonitor(
    session.page,
    await limitOf(ctx.options.downloadMaxMiB, session.workspaceId, DEFAULT_BROWSER_DOWNLOAD_MAX_MIB),
  );
  await monitor.attachCdp(session);
  try {
    const [download] = await Promise.all([
      session.page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
      locator.click({ timeout: ACTION_TIMEOUT_MS }),
    ]);
    return await saveCapturedDownload(ctx, session, download, contextLabel, monitor);
  } finally {
    await monitor.cleanup();
  }
}
