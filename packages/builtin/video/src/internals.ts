/**
 * `@tavi/plugin-video/internals`: the decoder's building blocks — its
 * FFmpeg templates, runner, supervisor, pose arithmetic and subtitles —
 * for the repository's evals and conformance tests, which drive them one
 * at a time. The owner composes the decoder from `@tavi/plugin-video`
 * alone.
 */

export { demuxerOf, SNIFF_BYTES, sniffVideo } from "./sniff.js";
export {
  belowSecureRelease,
  decoderFacts,
  FFMPEG_PREFIXES,
  FFMPEG_SECURE_RELEASES,
  findFfmpeg,
  libraryRoots,
  listBinaryLibraries,
  listedNames,
  parseLibraryListing,
  parseVersion,
  type FfmpegPaths,
  type FindFfmpegOptions,
} from "./ffmpeg.js";
export {
  argSeconds,
  audioArgs,
  commonInputOptions,
  encodeClipArgs,
  FACTS_ARGS,
  FFMPEG_ONLY,
  FORMAT_WHITELIST,
  frameAtArgs,
  probeArgs,
  rateFramesArgs,
  scaleLongEdge,
  sheetArgs,
  subtitleArgs,
  timelineArgs,
} from "./templates.js";
export {
  createRunner,
  hashFile,
  VideoOpenError,
  type ExecRequest,
  type ExecResult,
  type RunDirectory,
  type Runner,
  type RunnerOptions,
} from "./run.js";
export {
  createFfmpegDecoder,
  jpegSize,
  readOutputFile,
  parseTimeline,
  probeFacts,
  quarterTurn,
  type FfmpegDecoderOptions,
} from "./decoder.js";
export { createAnalyzerRegistry, type AnalyzerRegistry } from "./registry.js";
export {
  checkCommandArgs,
  COMMAND_FRAMES_INDEX,
  COMMAND_PLACEHOLDERS,
  COMMAND_RESULT_FILE,
  createCommandAnalyzer,
  type CommandAnalyzerEntry,
  type CommandAnalyzerOptions,
} from "./command-analyzer.js";
export { createMcpAnalyzer, MCP_INLINE_MAX_BYTES, type McpAnalyzerAnswer, type McpAnalyzerOptions } from "./mcp-analyzer.js";
export {
  sizeOf,
  supervise,
  WRITE_POLL_MS,
  type Ended,
  type Supervised,
  type SupervisedLaunch,
  type SuperviseOptions,
} from "./supervise.js";
export {
  FLEXION_JOINTS,
  flexion,
  hipBelowKnee,
  interiorAngle,
  jointAt,
  jointsOf,
  kneePastToe,
  MIN_KEYPOINT_SCORE,
  skeletonHas,
  trunkLean,
  trunkThigh,
  type Joints,
  type MeasuredJoint,
  type Point,
  type Side,
  type SidedJoint,
} from "./angles.js";
export { fillGaps, MAX_GAP_FRAMES, savitzkyGolay, smoothSeries } from "./smooth.js";
export { findReps, type Rep } from "./reps.js";
export {
  evaluatePose,
  VIEW_FRONT_FROM,
  VIEW_SIDE_BELOW,
  type EvaluatedRep,
  type PoseEvaluation,
  type PoseEvaluationInput,
  type SeriesJoint,
} from "./template-engine.js";
export { drawOverlay, type Overlay, type OverlayAngle, type OverlayInput } from "./overlay.js";
export { cuesWithin, MAX_SUBTITLE_CUES, parseSubRip, plainCueText } from "./subtitles.js";
export { createVideoPoseEngine } from "./pose-engine.js";
export { createVideoOcrAnalyzer } from "./pdf-ocr-analyzer.js";
