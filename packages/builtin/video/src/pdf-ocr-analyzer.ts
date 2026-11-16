import {
  PDF_LIMITS,
  VIDEO_LIMITS,
  type AnalyzeOutcome,
  type AnalyzeRequest,
  type AnalyzeResult,
  type PdfEnginePort,
  type VideoAnalyzerPort,
  type VideoCapability as Capability,
} from "@tavi/contracts";
import { encodePng } from "@tavi/child-kit";

import { readOutputFile } from "./decoder.js";

/**
 * The PDF engine's OCR as a video analyser: the decoder's raw
 * frames, written as PNGs here, read as pages by the PDF tools' own confined
 * OCR child (Tesseract, the `@tavi/pdf-ocr` add-on), at most
 * `ocrPagesPerCall` at a time. Local; no new runtime.
 */
export function createVideoOcrAnalyzer(engine: () => PdfEnginePort): VideoAnalyzerPort {
  const manifest = {
    id: "builtin.pdf-ocr",
    version: "1",
    attribution: { name: "Tesseract, through Tavi's PDF tools", url: "https://github.com/tesseract-ocr/tesseract", licence: "Apache-2.0" },
    capabilities: [
      { capability: "ocr" as const, inputs: ["frames" as const], output: "FrameText@1" as const, maxFrames: PDF_LIMITS.ocrPagesPerCall },
    ],
    local: true,
    confined: true,
    models: [{ name: "eng", installed: true }],
  };
  const failure = (
    code: "unsupported" | "bad-input" | "too-large" | "timeout" | "unavailable" | "memory" | "crashed" | "internal",
    message: string,
  ) => ({
    ok: false as const,
    error: { code, retryable: code === "too-large" || code === "timeout" || code === "unavailable" || code === "memory", message },
  });
  return {
    manifest: () => manifest,
    analyze: async <C extends Capability>(request: AnalyzeRequest<C>): Promise<AnalyzeOutcome<AnalyzeResult[C]>> => {
      if (request.capability !== "ocr") return failure("unsupported", "the PDF engine's OCR reads text only");
      const frames = request.frames ?? [];
      if (frames.length === 0) return failure("bad-input", "no frames to read");
      if (frames.length > PDF_LIMITS.ocrPagesPerCall)
        return failure("too-large", `the PDF engine's OCR reads at most ${String(PDF_LIMITS.ocrPagesPerCall)} frames at a time`);
      const images: { readonly page: number; readonly png: Uint8Array }[] = [];
      for (const [index, frame] of frames.entries()) {
        // The decoder's own output, read as any of its outputs is (no link followed, within the run's cap).
        const read = readOutputFile(frame.path, VIDEO_LIMITS.runDirMaxBytes);
        if (read === undefined) return failure("bad-input", "a frame could not be read");
        if (frame.format === "png") images.push({ page: index + 1, png: read.bytes });
        else if (frame.format === "rgb24" && read.bytes.length === frame.width * frame.height * 3)
          images.push({ page: index + 1, png: encodePng(read.bytes, frame.width, frame.height, { channels: 3 }) });
        else return failure("bad-input", "the PDF engine's OCR reads raw or PNG frames");
      }
      const started = Date.now();
      // The request's time and the caller's signal bound the call, as every analyser's do: either
      // ends the engine's OCR child at once.
      if (request.signal.aborted) return failure("timeout", "the call was stopped");
      const controller = new AbortController();
      const stopped = (): void => controller.abort();
      request.signal.addEventListener("abort", stopped, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.max(1, request.limits.timeoutMs));
      let result: Awaited<ReturnType<PdfEnginePort["ocr"]>>;
      try {
        result = await engine().ocr(images, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", stopped);
      }
      if (controller.signal.aborted)
        return failure(
          "timeout",
          request.signal.aborted ? "the call was stopped" : `the PDF engine's OCR ran past ${String(request.limits.timeoutMs)} ms`,
        );
      if (!result.ok) {
        if ("refused" in result)
          return result.refused === "no-ocr"
            ? failure("unavailable", "the PDF tools' OCR add-on (@tavi/pdf-ocr) is not installed")
            : result.refused === "too-large"
              ? failure("too-large", "the frames are too large for the PDF engine's OCR")
              : failure("bad-input", "a frame could not be read as an image");
        return failure(
          result.failure === "timeout" ? "timeout" : result.failure === "memory" ? "memory" : "crashed",
          `the OCR child ${result.failure === "timeout" ? "took too long" : result.failure === "memory" ? "ran out of memory" : "stopped"}`,
        );
      }
      const value = {
        frames: result.pages.map((page) => ({
          timeSec: frames[page.page - 1]?.timeSec ?? 0,
          text: page.text.slice(0, 4_000),
          confidence: page.confidence,
        })),
      };
      return { ok: true, result: value as AnalyzeResult[C], model: "eng", peakKb: result.peakKb, wallMs: Date.now() - started };
    },
    close: async () => undefined,
  };
}
