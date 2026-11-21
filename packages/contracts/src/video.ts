import { z } from "zod";

import { LanguageCodeSchema, SkeletonIdSchema } from "./video-engine.js";

/**
 * Video understanding's tools: the
 * five tools' inputs and results, the limits every run is held to, and the
 * facts a probe reports. Everything a decoder or an analyser answers is
 * parsed with these schemas in the owner before a field of it is read, and
 * every result stays under `MAX_TOOL_RESULT_BYTES`.
 */

// ------------------------------------------------------------------ limits

/** The owner's constants, set from measurements. */
export const VIDEO_LIMITS = {
  /** Input size; each channel's own cap applies first. */
  maxInputBytes: 100 * 1024 * 1024,
  /** Duration for facts and frames. */
  maxDurationSec: 600,
  poseMaxDurationSec: 60,
  /** Native video: a clip handed to a model whole. */
  viewMaxDurationSec: 120,
  viewMaxBytes: 20 * 1024 * 1024,
  /** Pixels per decoded frame (`-max_pixels`). */
  maxPixels: 4096 * 4096,
  sheetMaxCells: 9,
  framesStoredPerCall: 9,
  /** Frames handed to a model at once: `TOOL_MEDIA_MAX`. */
  framesShownPerCall: 3,
  /** A still's long edge, as Anthropic's image limit advises. */
  outputLongEdge: 1568,
  /** A contact sheet's padding between cells and margin around them, in pixels (its `tile` filter). */
  sheetGapPx: 4,
  /** A still's bytes: `artifacts.view_image`'s `MAX_VIEW_IMAGE_BYTES`. */
  frameMaxBytes: 5_000_000,
  /** Pose frames' width (never upscaled). */
  poseFrameWidth: 640,
  /** The scene timeline's sampling rate at most, lowered for long clips so its output fits `timelineMaxBytes`. */
  timelineMaxFps: 5,
  timelineMaxBytes: 1024 * 1024,
  /** A probe's JSON. */
  probeMaxBytes: 256 * 1024,
  /** A child's diagnostics kept (they may quote the file): capped and never shown. */
  stderrMaxBytes: 64 * 1024,
  /** A subtitle track as FFmpeg writes it out (SubRip text): past it, the track is not read. */
  subtitlesMaxBytes: 512 * 1024,
  /** The cgroup's `memory.max`, the RSS watchdog's cap below it, and `pids.max` (srt's Node, bwrap and FFmpeg's threads count). */
  childMemoryMb: 384,
  childRssMb: 320,
  /** The same two caps for a transcription analyser: a speech model holds its weights and buffers (whisper.cpp's base model about 300 MiB). */
  transcribeMemoryMb: 1_024,
  transcribeRssMb: 960,
  processes: 64,
  infoTimeoutMs: 10_000,
  framesTimeoutMs: 60_000,
  poseTimeoutMs: 120_000,
  transcribeTimeoutMs: 180_000,
  /** What one run may write. */
  runDirMaxBytes: 64 * 1024 * 1024,
  /** Frames one pose run decodes: `fps` is lowered for a long range so `fps × seconds` stays within it (POSE_MAX_FRAMES). */
  poseMaxFrames: 600,
  poseSamplesPerSeries: 60,
  poseSeriesPerCall: 6,
  /** UTF-8 bytes of one call's serialized `segments` and `subtitles`, together: `nextFrom` pages on it, under `MAX_TOOL_RESULT_BYTES`. */
  transcriptBytesPerCall: 48 * 1024,
  /** How long a video whose run was killed is refused. */
  refuseKilledForMs: 24 * 60 * 60_000,
} as const;

/**
 * How raw `rgb24` frames of a video fit one decoder run: the
 * size they are decoded at (upright, at most `maxWidth` wide, never
 * upscaled), each frame's bytes with a row of slack for FFmpeg's `-2`
 * rounding, and how many fit 90% of the run's write cap. The decoder lowers a
 * rate to fit it; `video.pose` cuts a range into runs by it.
 */
export function rawFrameBudget(
  video: { readonly width: number; readonly height: number; readonly rotation: number },
  maxWidth: number,
): { readonly width: number; readonly frameBytes: number; readonly frames: number } {
  const turned = video.rotation === 90 || video.rotation === 270;
  const shownWidth = Math.max(1, turned ? video.height : video.width);
  const shownHeight = turned ? video.width : video.height;
  const width = Math.max(1, Math.min(maxWidth, shownWidth));
  const frameBytes = width * (Math.ceil((width * shownHeight) / shownWidth) + 2) * 3;
  return { width, frameBytes, frames: Math.floor((0.9 * VIDEO_LIMITS.runDirMaxBytes) / Math.max(1, frameBytes)) };
}

// ------------------------------------------------------------------ inputs

export const VIDEO_CONTAINERS = ["mp4", "mov", "3gp", "webm", "matroska", "gif"] as const;
export const VideoContainerSchema = z.enum(VIDEO_CONTAINERS);
export type VideoContainer = z.infer<typeof VideoContainerSchema>;

/** Each container's media type, as intake stores it. */
export const VIDEO_MEDIA_TYPES: Readonly<Record<VideoContainer, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
  webm: "video/webm",
  matroska: "video/x-matroska",
  gif: "image/gif",
};

/** Audio files the decoder opens for their speech alone (a voice note): never a video tool's input. */
export const AUDIO_CONTAINERS = ["ogg", "mp3", "wav", "m4a", "aac"] as const;
export type AudioContainer = (typeof AUDIO_CONTAINERS)[number];
/** Each audio container's media type, as intake stores it. */
export const AUDIO_MEDIA_TYPES: Readonly<Record<AudioContainer, string>> = {
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
};
/** What a decoder run holds: a video, or an audio file opened for its speech. */
export type MediaContainer = VideoContainer | AudioContainer;
/** Whether a run's container is an audio file's. */
export function isAudioContainer(container: MediaContainer): container is AudioContainer {
  return (AUDIO_CONTAINERS as readonly string[]).includes(container);
}

/** An audio file's facts, as the decoder reads them: its length and its sound. */
export interface AudioFacts {
  readonly sha256: string;
  readonly container: AudioContainer;
  readonly durationSec: number;
  readonly audio: { readonly codec: string; readonly channels: number; readonly sampleRate: number };
}

export const VideoSourceSchema = z.union([
  z.strictObject({ artifactId: z.string().min(1).max(128).describe("An approved video or GIF artifact, e.g. a chat attachment") }),
  z.strictObject({ path: z.string().min(1).max(4_096).describe("A video in your working folder or an attached folder") }),
]);
export type VideoSource = z.infer<typeof VideoSourceSchema>;

export const SecondsSchema = z.number().min(0).max(36_000);

// ------------------------------------------------------------------ facts

export const VideoFactsSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  container: VideoContainerSchema,
  durationSec: z.number().min(0),
  video: z.strictObject({
    codec: z.string().max(32),
    /** The coded size, before rotation. */
    width: z.number().int().min(0),
    height: z.number().int().min(0),
    fps: z.number().min(0).max(1_000),
    /** Clockwise display rotation, from the display matrix. */
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    frames: z.number().int().min(0).optional(),
    /** A high-frame-rate capture (≥ 100 fps). */
    slowMotion: z.boolean(),
  }),
  audio: z.strictObject({ codec: z.string().max(32), channels: z.number().int().min(0), sampleRate: z.number().int().min(0) }).optional(),
  subtitles: z.number().int().min(0),
  /** Whether the file carries a location; never the value. */
  hasLocation: z.boolean(),
  withinLimits: z.strictObject({ frames: z.boolean(), pose: z.boolean(), view: z.boolean() }),
});
export type VideoFacts = z.infer<typeof VideoFactsSchema>;

// ------------------------------------------------------------------ the tools

export const VIDEO_TOOL_IDS = ["video.info", "video.frames", "video.view", "video.pose", "video.transcribe"] as const;
export type VideoToolId = (typeof VIDEO_TOOL_IDS)[number];

/** `video.info`: read-only, sink none. */
export const VideoInfoInputSchema = z.strictObject({ source: VideoSourceSchema });
export type VideoInfoInput = z.infer<typeof VideoInfoInputSchema>;
export const VideoInfoResultSchema = z.strictObject({ video: VideoFactsSchema, note: z.string().max(500).optional() });
export type VideoInfoResult = z.infer<typeof VideoInfoResultSchema>;

/** `video.frames`: read-only, sink none (`ocr` may raise a call to external). */
export const VideoFramesInputSchema = z.strictObject({
  source: VideoSourceSchema,
  mode: z
    .enum(["uniform", "scene", "motion", "at"])
    .default("uniform")
    .describe("uniform: evenly spaced; scene: at cuts; motion: at the busiest moments; at: the times in `at`"),
  at: z.array(SecondsSchema).min(1).max(9).optional().describe("Times in seconds, for mode `at`"),
  from: SecondsSchema.optional(),
  to: SecondsSchema.optional(),
  count: z.number().int().min(1).max(9).default(6),
  layout: z.enum(["sheet", "frames"]).default("sheet").describe("sheet: one timestamped contact sheet; frames: separate stills"),
  ocr: z.boolean().default(false).describe("Also read on-screen text from the frames"),
});
export type VideoFramesInput = z.infer<typeof VideoFramesInputSchema>;
export const VideoFramesResultSchema = z.strictObject({
  video: VideoFactsSchema,
  frames: z
    .array(
      z.strictObject({
        index: z.number().int(),
        timeSec: z.number(),
        artifactId: z.string(),
        motion: z.number().min(0).max(100).optional(),
      }),
    )
    .max(VIDEO_LIMITS.framesStoredPerCall),
  sheet: z.strictObject({ artifactId: z.string(), columns: z.number().int(), rows: z.number().int(), labelled: z.boolean() }).optional(),
  motionTimeline: z
    .array(z.tuple([z.number(), z.number()]))
    .max(120)
    .optional(),
  text: z
    .array(z.strictObject({ timeSec: z.number(), text: z.string().max(1_000) }))
    .max(VIDEO_LIMITS.framesStoredPerCall)
    .optional(),
  /** The artifacts handed to the model, at most `framesShownPerCall`. */
  shown: z.array(z.string()).max(VIDEO_LIMITS.framesShownPerCall),
  /** Which OCR analyser ran. */
  analyzer: z.string().max(64).optional(),
  note: z.string().max(500).optional(),
});
export type VideoFramesResult = z.infer<typeof VideoFramesResultSchema>;

/** `video.view`: read-only, sink none. */
export const VideoViewInputSchema = z.strictObject({
  source: VideoSourceSchema,
  from: SecondsSchema.optional(),
  to: SecondsSchema.optional(),
});
export type VideoViewInput = z.infer<typeof VideoViewInputSchema>;
export const VideoViewResultSchema = z.strictObject({
  video: VideoFactsSchema,
  sheet: z.strictObject({ artifactId: z.string(), columns: z.number().int(), rows: z.number().int() }),
  frames: z.array(z.strictObject({ timeSec: z.number(), artifactId: z.string() })).max(2),
  /** The fallback images. */
  shown: z.array(z.string()).max(VIDEO_LIMITS.framesShownPerCall),
  /** Why the clip itself cannot be handed over. */
  notWhole: z.string().max(300).optional(),
});
export type VideoViewResult = z.infer<typeof VideoViewResultSchema>;

/** `video.pose`: read-only, sink none, or external when the pose analyser is remote. */
export const MOVEMENTS = ["generic", "squat", "push-up", "lunge", "hip-hinge"] as const;
export const MovementSchema = z.enum(MOVEMENTS);
export type Movement = z.infer<typeof MovementSchema>;
/** The joints a pose series is about; their flexion is defined by `MeasureSpec`'s `flexion` (movement-templates.ts). */
export const POSE_SERIES_JOINTS = ["knee", "hip", "ankle", "elbow", "shoulder", "trunk"] as const;
export const SETUP_PROBLEMS = [
  "not-side-on",
  "body-cut-off",
  "occluded",
  "low-light-or-blur",
  "several-people",
  "tracking-lost",
  "camera-moving",
  "skeleton-lacks-joint",
] as const;
export type SetupProblem = (typeof SETUP_PROBLEMS)[number];

export const VideoPoseInputSchema = z.strictObject({
  source: VideoSourceSchema,
  movement: MovementSchema.default("generic"),
  side: z.enum(["left", "right", "auto"]).default("auto").describe("The side of the body facing the camera"),
  from: SecondsSchema.optional(),
  to: SecondsSchema.optional(),
  fps: z.number().int().min(5).max(30).default(10),
});
export type VideoPoseInput = z.infer<typeof VideoPoseInputSchema>;
export const VideoPoseResultSchema = z.strictObject({
  video: VideoFactsSchema,
  analyzer: z.strictObject({
    id: z.string().max(64),
    model: z.string().max(100),
    skeleton: SkeletonIdSchema,
    licence: z.string().max(64),
    tried: z.array(z.string().max(64)).max(8),
  }),
  setup: z.strictObject({
    view: z.enum(["side", "oblique", "front", "unknown"]),
    fullBody: z.boolean(),
    personCount: z.number().int().min(0),
    meanKeypointScore: z.number().min(0).max(1),
    problems: z.array(z.enum(SETUP_PROBLEMS)).max(8),
  }),
  /** Measured for this analyser and setup class; absent otherwise. */
  errorBandDeg: z.number().min(0).max(90).optional(),
  /** Whether the movement's template has passed its owner-recorded fixtures; until then no faults are named. */
  validated: z.boolean(),
  /** Downsampled: at most `poseSamplesPerSeries` `[timeSec, degrees]` each. */
  series: z
    .array(
      z.strictObject({
        joint: z.enum(POSE_SERIES_JOINTS),
        side: z.enum(["left", "right"]),
        samples: z.array(z.tuple([z.number(), z.number()])).max(VIDEO_LIMITS.poseSamplesPerSeries),
      }),
    )
    .max(VIDEO_LIMITS.poseSeriesPerCall),
  reps: z
    .array(
      z.strictObject({
        startSec: z.number(),
        bottomSec: z.number(),
        endSec: z.number(),
        /** The template's measures at the rep's key frame, e.g. `kneeFlexionDeg`, `hipBelowKnee` (0/1). */
        atBottom: z.record(z.string().max(32), z.number()),
        /** The template's named faults found. */
        faults: z.array(z.string().max(64)).max(8),
        /** The rep's key frame with the body drawn on it: the first reps' only, and none where the frame could not be drawn. */
        overlayArtifactId: z.string().optional(),
      }),
    )
    .max(20),
  shown: z.array(z.string()).max(VIDEO_LIMITS.framesShownPerCall),
  limits: z.string().max(1_000),
});
export type VideoPoseResult = z.infer<typeof VideoPoseResultSchema>;

/** `video.transcribe`: read-only, sink none when the analyser is local. */
export const VideoTranscribeInputSchema = z.strictObject({
  source: VideoSourceSchema,
  from: SecondsSchema.optional(),
  to: SecondsSchema.optional(),
  language: LanguageCodeSchema.optional().describe(
    "The spoken language, as an ISO 639 code (two letters, or three where it has no two-letter one, e.g. yue); detected when absent",
  ),
});
export type VideoTranscribeInput = z.infer<typeof VideoTranscribeInputSchema>;

/**
 * Voice messages' setup, as onboarding's voice step and Settings read it (`models voice-status`): what is here, what
 * is missing, and the job `models voice-setup` started.
 */
export const VoiceSetupStatusSchema = z.strictObject({
  /** macOS or Linux. */
  supported: z.boolean(),
  /** A transcriber is ready and FFmpeg is found: a voice message is read. */
  ready: z.boolean(),
  ffmpeg: z.boolean(),
  whisper: z.boolean(),
  model: z.boolean(),
  /** The step can add what is missing itself (Homebrew for the tools; the model and configuration need none). */
  automatic: z.boolean(),
  missing: z.array(z.string().max(300)).max(8),
  /** What to run by hand where the step cannot. */
  commands: z.array(z.string().max(400)).max(4),
  modelInfo: z.strictObject({ file: z.string().max(100), megabytes: z.number().int().nonnegative(), licence: z.string().max(64) }),
  job: z
    .strictObject({
      state: z.enum(["running", "done", "failed"]),
      phase: z.enum(["install", "download", "configure"]),
      message: z.string().max(300),
      received: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type VoiceSetupStatus = z.infer<typeof VoiceSetupStatusSchema>;

/** `audio.transcribe`: a voice note or other audio attachment's speech, by its artifact. */
export const AudioTranscribeInputSchema = z.strictObject({
  artifactId: z.string().min(1).max(128).describe("An audio artifact, e.g. a voice message's attachment"),
  from: SecondsSchema.optional(),
  to: SecondsSchema.optional(),
  language: LanguageCodeSchema.optional().describe(
    "The spoken language, as an ISO 639 code (two letters, or three where it has no two-letter one, e.g. yue); detected when absent",
  ),
});
export type AudioTranscribeInput = z.infer<typeof AudioTranscribeInputSchema>;
export const VideoTranscribeResultSchema = z.strictObject({
  video: VideoFactsSchema,
  segments: z.array(z.strictObject({ startSec: z.number(), endSec: z.number(), text: z.string().max(1_000) })).max(400),
  subtitles: z
    .array(z.strictObject({ startSec: z.number(), endSec: z.number(), text: z.string().max(1_000) }))
    .max(400)
    .optional(),
  /** Which analyser transcribed the speech; absent when none could, and the subtitles stand alone. */
  analyzer: z.strictObject({ id: z.string().max(64), model: z.string().max(100) }).optional(),
  /** Page on from here: at most `transcriptBytesPerCall` per call. */
  nextFrom: SecondsSchema.optional(),
  note: z.string().max(500).optional(),
});
export type VideoTranscribeResult = z.infer<typeof VideoTranscribeResultSchema>;
