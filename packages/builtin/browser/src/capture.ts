import {
  type BrowserCaptureOptions,
  TaviError,
  type BrowserCaptureMark,
  type ArtifactRepositoryPort,
  type BrowserCaptureResult,
  type BrowserCaptureScale,
  browserArtifactLabel,
} from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import type { Page } from "playwright";

import { isolatedSecretValue } from "./secrets.js";
import { sensitivityOf } from "./sensitivity.js";
import { playwrightThumbnailPage } from "./thumbnail.js";
import { blockedHostsOf } from "./observation.js";
import { SIGNALS_TIMEOUT_MS } from "./page-status.js";
import type { SessionRecord, BrowserRuntime } from "./session-types.js";
import { storedElementOf, asAgent } from "./sessions.js";
import { within, LIVE_BOX_TIMEOUT_MS, MODEL_CAPTURE_QUALITY } from "./timing.js";

export async function resolveCaptureClip(
  sessionId: string,
  session: SessionRecord,
  captureOptions?: BrowserCaptureOptions,
): Promise<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined> {
  if (captureOptions?.region !== undefined) {
    const { x, y, width, height } = captureOptions.region;
    if (width <= 0 || height <= 0) {
      throw new TaviError("INVALID_INPUT", "capture region width and height must be positive");
    }
    return {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }
  if (captureOptions?.ref !== undefined) {
    const epoch = captureOptions.epoch ?? session.epoch;
    const stored = storedElementOf(session, sessionId, captureOptions.ref, epoch);
    const box = await within(stored.locator.boundingBox(), LIVE_BOX_TIMEOUT_MS);
    if (box === null || box === undefined || box.width <= 0 || box.height <= 0) {
      throw new TaviError("INVALID_INPUT", `${captureOptions.ref} has no visible bounding box to capture`);
    }
    return {
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y)),
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
    };
  }
  return undefined;
}

export async function collectRefMarks(session: SessionRecord): Promise<BrowserCaptureMark[]> {
  const entries = [...session.elements.entries()].slice(0, 60);
  if (entries.length === 0) return [];
  const resolved = await Promise.all(
    entries.map(async ([ref, stored]) => {
      const box = await within(stored.locator.boundingBox(), LIVE_BOX_TIMEOUT_MS);
      if (box === null || box === undefined || box.width <= 0 || box.height <= 0) return undefined;
      return {
        ref,
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }),
  );
  return resolved.filter((m): m is BrowserCaptureMark => m !== undefined);
}

export function readImageDimensions(
  bytes: Uint8Array,
  fallbackWidth: number,
  fallbackHeight: number,
): { readonly width: number; readonly height: number } {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2 || offset + 2 + segLen > bytes.length) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + segLen;
    }
  }
  return { width: fallbackWidth, height: fallbackHeight };
}

export async function drawMarksOnScreenshot(
  page: Page,
  bytes: Buffer,
  marks: readonly BrowserCaptureMark[],
  mimeType: "image/jpeg" | "image/png" = "image/jpeg",
): Promise<Buffer> {
  const context = typeof page.context === "function" ? page.context() : undefined;
  // Drawn in an isolated world, whose canvas and encoders page script cannot replace: never in the page's own.
  if (marks.length === 0 || context === undefined || typeof context.newCDPSession !== "function") return bytes;
  const base64 = bytes.toString("base64");
  const draw = async (input: {
    readonly b64: string;
    readonly items: readonly BrowserCaptureMark[];
    readonly quality: number;
    readonly mimeType: "image/jpeg" | "image/png";
  }) => {
    const g = globalThis as unknown as {
      readonly OffscreenCanvas?: new (
        w: number,
        h: number,
      ) => {
        getContext(kind: "2d"): {
          drawImage(img: unknown, x: number, y: number): void;
          strokeStyle: string;
          fillStyle: string;
          lineWidth: number;
          font: string;
          strokeRect(x: number, y: number, w: number, h: number): void;
          fillRect(x: number, y: number, w: number, h: number): void;
          fillText(text: string, x: number, y: number): void;
          measureText(text: string): { readonly width: number };
        } | null;
        convertToBlob(opts: { readonly type: string; readonly quality?: number }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
      };
      readonly createImageBitmap?: (blob: unknown) => Promise<{ readonly width: number; readonly height: number; close?(): void }>;
      readonly Blob?: new (parts: unknown[], opts: { readonly type: string }) => unknown;
      readonly atob?: (s: string) => string;
      readonly btoa?: (s: string) => string;
    };
    if (
      typeof g.OffscreenCanvas !== "function" ||
      typeof g.createImageBitmap !== "function" ||
      typeof g.Blob !== "function" ||
      typeof g.atob !== "function" ||
      typeof g.btoa !== "function"
    ) {
      return null;
    }
    const bin = g.atob(input.b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    const bmp = await g.createImageBitmap(new g.Blob([arr], { type: input.mimeType }));
    const canvas = new g.OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      bmp.close?.();
      return null;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    ctx.lineWidth = 2;
    ctx.font = "bold 11px sans-serif";
    for (const item of input.items) {
      ctx.strokeStyle = "#dc2626";
      ctx.strokeRect(item.x, item.y, item.width, item.height);
      const tagW = Math.ceil(ctx.measureText(item.ref).width) + 6;
      const tagH = 14;
      const tagX = Math.max(0, item.x);
      const tagY = Math.max(0, item.y - tagH);
      ctx.fillStyle = "#dc2626";
      ctx.fillRect(tagX, tagY, tagW, tagH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(item.ref, tagX + 3, tagY + 11);
    }
    const outBlob = await canvas.convertToBlob(
      input.mimeType === "image/png" ? { type: "image/png" } : { type: "image/jpeg", quality: input.quality / 100 },
    );
    const outBuf = new Uint8Array(await outBlob.arrayBuffer());
    let outBin = "";
    for (let i = 0; i < outBuf.length; i += 1) outBin += String.fromCharCode(outBuf[i]!);
    return g.btoa(outBin);
  };
  const input = { b64: base64, items: marks, quality: MODEL_CAPTURE_QUALITY, mimeType };
  const annotated = await within(
    (async () => {
      const cdp = await context.newCDPSession(page);
      try {
        const tree = await cdp.send("Page.getFrameTree");
        const world = await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "tavi-marks" });
        const answer = await cdp.send("Runtime.evaluate", {
          expression: `(${draw.toString()})(${JSON.stringify(input)})`,
          contextId: world.executionContextId,
          awaitPromise: true,
          returnByValue: true,
        });
        return answer.result.value as unknown;
      } finally {
        // Best effort: the session is done with; nothing waits on its detach.
        await cdp.detach().catch(() => undefined);
      }
    })().catch(() => undefined),
    SIGNALS_TIMEOUT_MS,
  );
  return typeof annotated === "string" && annotated !== "" ? Buffer.from(annotated, "base64") : bytes;
}

/**
 * A screenshot the agent's own model looks at: the viewport, as a
 * JPEG, approved — the model sees its own browser, as the live view shows a
 * person. A page the live view would hide (`sensitivityOf`: a password,
 * payment or one-time-code field, a no-thumbnail host) is never pictured.
 */
export async function captureForModel(
  ctx: BrowserRuntime,
  sessionId: string,
  session: SessionRecord,
  artifacts: ArtifactRepositoryPort,
  captureOptions?: BrowserCaptureOptions,
): Promise<BrowserCaptureResult> {
  const contextLabel = captureOptions?.contextLabel;
  const blockedHosts = await blockedHostsOf(ctx, session.workspaceId);
  const refusal = async (): Promise<string | undefined> => {
    const sensitive = await sensitivityOf((ctx.options.thumbnailPage ?? playwrightThumbnailPage)(session.page), blockedHosts);
    if (sensitive !== undefined) return sensitive.replace("-", " ");
    // A secret someone typed — a code, a password a "show password" switch made plain — fails closed too.
    const typed = await within(
      Promise.resolve().then(() => isolatedSecretValue(session.page)),
      SIGNALS_TIMEOUT_MS,
    );
    return typed === false ? undefined : "a secret field holds a value";
  };
  const refuse = (reason: string): never => {
    throw new TaviError("NOT_AUTHORIZED", `this page is never shown to the model (${reason}): read its text, or hand it to the person`, {
      details: { reason },
    });
  };
  const before = await refusal();
  if (before !== undefined) refuse(before);
  const clip = await resolveCaptureClip(sessionId, session, captureOptions);
  // A person acting in the page is not photographed (invariant 8).
  let bytes = await asAgent(ctx, session, () =>
    session.page.screenshot({
      type: "jpeg",
      quality: MODEL_CAPTURE_QUALITY,
      scale: clip === undefined ? "css" : "device",
      ...(clip === undefined ? {} : { clip }),
    }),
  );
  let marks: BrowserCaptureMark[] | undefined;
  if (captureOptions?.marks === true && clip === undefined) {
    marks = await collectRefMarks(session);
    bytes = await drawMarksOnScreenshot(session.page, bytes, marks, "image/jpeg");
  }
  const vpSize =
    typeof (session.page as { readonly viewportSize?: unknown }).viewportSize === "function" ? session.page.viewportSize() : null;
  const logicalWidth = clip?.width ?? vpSize?.width ?? 1280;
  const logicalHeight = clip?.height ?? vpSize?.height ?? 720;
  const imgDims = readImageDimensions(bytes, logicalWidth, logicalHeight);
  const scale: BrowserCaptureScale = {
    logicalWidth,
    logicalHeight,
    imageWidth: imgDims.width,
    imageHeight: imgDims.height,
  };
  // Checked again after: a page that moved on, or filled in, while it was taken is not kept.
  const after = await refusal();
  if (after !== undefined) refuse(after);
  const artifactId = prefixedId("art");
  const artifact = await artifacts.putArtifact({
    artifactId,
    // The page's, with the calling conversation's.
    label: browserArtifactLabel({ contextLabel, source: "web", pageUrl: session.page.url(), ref: artifactId, at: ctx.now() }),
    workspaceId: session.workspaceId,
    ...(session.taskId === undefined ? {} : { runId: session.taskId }),
    contentType: "image/jpeg",
    body: bytes,
    extension: "jpg",
    reviewState: "approved",
  });
  return {
    sessionId,
    artifactId: artifact.artifactId,
    capturedAt: ctx.now(),
    forModel: true,
    contentType: "image/jpeg",
    scale,
    ...(marks === undefined ? {} : { marks }),
  };
}
