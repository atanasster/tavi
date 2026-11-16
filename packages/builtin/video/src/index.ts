/**
 * `@tavi/plugin-video` (docs/VIDEO.md): the
 * built-in video decoder over the person's own FFmpeg, one confined, capped
 * run per call, its command and MCP analysers, the PDF engine's OCR as an
 * analyser, and the pose arithmetic. It implements `VideoDecoderPort`,
 * `VideoAnalyzerPort` and `VideoPoseEnginePort` on contracts and the child
 * kit alone; the owner names it in `apps/cli/src/features/video/host.ts`,
 * and nothing else imports it. Its building blocks are `./internals`, for
 * the evals.
 */

export { findFfmpeg, libraryRoots, listBinaryLibraries, type FfmpegPaths, type FindFfmpegOptions } from "./ffmpeg.js";
export { createFfmpegDecoder, type FfmpegDecoderOptions } from "./decoder.js";
export { createAnalyzerRegistry, type AnalyzerRegistry } from "./registry.js";
export { createCommandAnalyzer, type CommandAnalyzerEntry, type CommandAnalyzerOptions } from "./command-analyzer.js";
export { createMcpAnalyzer, type McpAnalyzerAnswer, type McpAnalyzerOptions } from "./mcp-analyzer.js";
export { createVideoOcrAnalyzer } from "./pdf-ocr-analyzer.js";
export { createVideoPoseEngine } from "./pose-engine.js";
