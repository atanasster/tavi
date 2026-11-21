import { z } from "zod";

import type { ConfinedCommand } from "./confinement.js";
import type { MemoryReach } from "./ports/memory-service.js";
import type { AudioFacts, MediaContainer, Movement, SetupProblem, VideoFacts } from "./video.js";

/**
 * Video understanding's ports: what the video tools use of a decoder and of
 * the analysers, and
 * what an implementation package implements, as `PdfEnginePort` is for PDFs.
 *
 * Two ports, because decoding is one job with one implementation at a time
 * (bytes in, facts and frames out) while analysis is open-ended: several
 * analysers per capability, ordered by the owner, local or remote. An
 * analyser never parses the video container: it is handed decoded frames or
 * audio, by path in a run directory, so hostile-format parsing stays in the
 * decoder's one confined child.
 *
 * `@tavi/plugin-video` is the built-in decoder (the person's own FFmpeg) and
 * holds the command and MCP analysers; `@tavi/video-pose` and
 * `@tavi/video-transcribe` are add-ons. The owner names them in one module
 * (`apps/cli/src/features/video/host.ts`); the tools see only these ports.
 */

// ------------------------------------------------------------------ confinement

/** A child's launch before confinement: as `PdfLaunch`, plus the one writable run directory and its caps. */
export interface VideoLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Re-opened inside the denied home and data directory: the binary's library closure, a command analyser's own files. */
  readonly readRoots: readonly string[];
  /** The only writable path; the input, the policy file and every output live in it. */
  readonly runDirectory: string;
  readonly workload: "video";
  readonly limits: { readonly memoryBytes: number; readonly processes: number };
  /** Hosts it may reach: a remote command analyser's, whose calls are raised to external; none for anything else. */
  readonly domains?: readonly string[];
}

/** A launch, wrapped: `onExit` says whether its cgroup ended it out of memory, `kill` ends its whole cgroup. */
export type VideoWrapped = ConfinedCommand & { readonly onExit?: () => "oom" | undefined; readonly kill?: () => void };

/**
 * How video children are confined. The owner wraps each launch; a wrap may
 * refuse (`unconfined`: a Linux host whose sandbox tier is `unavailable`,
 * without `serve --video-allow-unconfined`). `none` runs them bare and
 * is for tests only.
 */
export type VideoSandbox =
  | { readonly kind: "wrapped"; readonly wrap: (launch: VideoLaunch) => VideoWrapped | { readonly refused: "unconfined" } }
  | { readonly kind: "none" };

/** Why a run produced no answer: killed past its clock or memory, died, answered out of protocol, or could not be confined. */
export const VIDEO_FAILURES = ["timeout", "memory", "crashed", "protocol", "unconfined"] as const;
export type VideoFailure = (typeof VIDEO_FAILURES)[number];

/** Why a call was refused before or instead of a run. */
export const VIDEO_REFUSALS = [
  "not-video",
  "too-large",
  "too-long",
  "too-many-pixels",
  "no-ffmpeg",
  "missing-feature",
  "no-audio",
  "refused-recently",
  "unreadable",
] as const;
export type VideoRefusal = (typeof VIDEO_REFUSALS)[number];

// ------------------------------------------------------------------ the decoder

export const VIDEO_DECODERS = ["h264", "hevc", "vp8", "vp9", "av1", "gif", "mpeg4"] as const;
export type VideoDecoderName = (typeof VIDEO_DECODERS)[number];
/** What a build may lack: a missing one narrows what the tools offer (`drawtext` is absent from Homebrew's FFmpeg 9.0.2). */
export const VIDEO_DECODER_FEATURES = ["scdet", "tile", "drawtext", "h264-encoder", "mpeg4-encoder", "audio-extract"] as const;
export type VideoDecoderFeature = (typeof VIDEO_DECODER_FEATURES)[number];

/** The decoder's own facts, read once at discovery from the build's own listings (no video is involved, so unconfined): `doctor` and registration read them. */
export interface VideoDecoderFacts {
  /** `"ffmpeg"` for the built-in decoder. */
  readonly kind: string;
  readonly version: string;
  readonly decoders: readonly VideoDecoderName[];
  readonly features: readonly VideoDecoderFeature[];
  /** E.g. below the latest security release: a `doctor` warning, never a refusal. */
  readonly warnings: readonly string[];
}

/** One video the owner has sniffed and copied into a run directory. */
export interface VideoInput {
  /** The verified copy, inside the run directory. */
  readonly path: string;
  readonly sha256: string;
  /** A video's, or an audio file's when the run was opened with `openAudio`. */
  readonly container: MediaContainer;
}

export interface DecodedFrame {
  /** The time decoded (the one asked for, pulled back inside the clip), never read back from the frame (`-ss` restarts timestamps). */
  readonly timeSec: number;
  /** Inside the run directory. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly format: "jpeg" | "png" | "rgb24";
}

/** One subtitle cue: when it shows, and its text without markup. */
export interface SubtitleCue {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * What frames to take: stills at given times (JPEG, for the model and the
 * canvas), or every frame at a rate (raw `rgb24`, for pose: Tavi draws on
 * them without parsing an image format).
 */
export type FramePlan =
  | { readonly kind: "times"; readonly times: readonly number[]; readonly longEdge: number }
  | { readonly kind: "rate"; readonly fps: number; readonly range: TimeRange; readonly maxWidth: number };

/** A contact sheet: cells at `times`, in order, `columns` × `rows`; labelled with each cell's time when the build has `drawtext`. */
export interface SheetPlan {
  readonly times: readonly number[];
  readonly columns: number;
  readonly rows: number;
  readonly cellLongEdge: number;
  /** A font file in the run directory for the labels; none: unlabelled. */
  readonly font?: string;
}

export type VideoResult<T> =
  | { readonly ok: true; readonly value: T; readonly peakKb: number; readonly wallMs: number }
  | { readonly ok: false; readonly refused: VideoRefusal; readonly detail?: string }
  | { readonly ok: false; readonly failure: VideoFailure };

/**
 * One video, sniffed and copied into a fresh run directory: every decoder
 * call on it writes its outputs in `directory`, and `dispose` removes it all.
 */
export interface VideoRun {
  readonly input: VideoInput;
  readonly directory: string;
  /**
   * An output's bytes, read as the run left it: only a regular file inside
   * the run directory, never through a link or from a FIFO the child
   * planted, at most `maxBytes`; undefined otherwise.
   */
  readOutput(path: string, maxBytes: number): Uint8Array | undefined;
  dispose(): void;
}

/** What a run is opened from: bytes the owner holds, or a file it has checked (a folder file). */
export type VideoSourceData = { readonly bytes: Uint8Array } | { readonly file: string };

export interface VideoDecoderPort {
  /** The build's facts, or why there is none (no FFmpeg found). */
  facts(): VideoDecoderFacts | { readonly missing: string };
  /** The video's container from its bytes, a fresh run directory and the verified copy in it; refused when it is no video or too large. */
  open(source: VideoSourceData): VideoResult<VideoRun>;
  probe(input: VideoInput): Promise<VideoResult<VideoFacts>>;
  /**
   * An audio file (a voice note: Ogg, MP3, WAV, M4A) in a run of its own, for its speech alone: `probeAudio` and
   * `audio` read it, and no frame tool does. Refused `not-video` when its bytes are none of these.
   */
  openAudio(source: VideoSourceData): VideoResult<VideoRun>;
  /** An audio run's length and sound; refused `no-audio` when the probe found no audio stream. */
  probeAudio(input: VideoInput): Promise<VideoResult<AudioFacts>>;
  /**
   * Each of `frames`, `sheet` and `audio` writes into a fresh directory of
   * its own under `out`, a directory inside the video's run directory, so
   * no call ever reads another's output.
   */
  frames(input: VideoInput, plan: FramePlan, out: string): Promise<VideoResult<readonly DecodedFrame[]>>;
  sheet(input: VideoInput, plan: SheetPlan, out: string): Promise<VideoResult<DecodedFrame>>;
  /** Per sampled frame, its time and scene-change score (0-100). */
  timeline(input: VideoInput, range: TimeRange): Promise<VideoResult<readonly (readonly [number, number])[]>>;
  /** 16 kHz mono WAV of `range`, from a video or an audio run; refused `no-audio` when the probe found no audio stream. */
  audio(input: VideoInput, range: TimeRange, out: string): Promise<VideoResult<{ readonly path: string; readonly seconds: number }>>;
  /**
   * The video's first text subtitle track (`mov_text`, SubRip, WebVTT, ASS) as cues, times in seconds; empty
   * when it has none. A bitmap track (DVD, PGS) cannot be read as text and is refused `unreadable`.
   */
  subtitles(input: VideoInput): Promise<VideoResult<readonly SubtitleCue[]>>;
  /** The native-video probe's clip: `rgb24` frames of `size` encoded as MP4 (H.264, or MPEG-4 Part 2 without libx264). */
  encodeClip(
    frames: readonly Uint8Array[],
    size: { readonly width: number; readonly height: number; readonly fps: number },
    out: string,
  ): Promise<VideoResult<string>>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ skeletons

/**
 * The joints Tavi reasons about, by name. Every skeleton maps its own index
 * order onto these; angles and overlays never index by position.
 */
export const JOINTS = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "neck",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "mid_hip",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  "left_big_toe",
  "right_big_toe",
] as const;
export type Joint = (typeof JOINTS)[number];

export const SKELETON_IDS = ["coco17", "halpe26", "body25", "mp33"] as const;
export const SkeletonIdSchema = z.enum(SKELETON_IDS);
export type SkeletonId = z.infer<typeof SkeletonIdSchema>;

const COCO17: readonly (Joint | null)[] = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
];

/**
 * Each skeleton's keypoints in its own index order, as Tavi's joint names
 * (`null`: a keypoint Tavi does not use). Sources: COCO person keypoints;
 * Halpe's 26-point body; OpenPose BODY_25; MediaPipe Pose's 33 landmarks
 * (its `foot_index` is the big toe). `neck` and `mid_hip` are derived as
 * means of the shoulders and hips where a skeleton lacks them.
 */
export const SKELETONS: Readonly<Record<SkeletonId, readonly (Joint | null)[]>> = {
  coco17: COCO17,
  halpe26: [
    ...COCO17,
    null /* head */,
    "neck",
    "mid_hip",
    "left_big_toe",
    "right_big_toe",
    null,
    null /* small toes */,
    "left_heel",
    "right_heel",
  ],
  body25: [
    "nose",
    "neck",
    "right_shoulder",
    "right_elbow",
    "right_wrist",
    "left_shoulder",
    "left_elbow",
    "left_wrist",
    "mid_hip",
    "right_hip",
    "right_knee",
    "right_ankle",
    "left_hip",
    "left_knee",
    "left_ankle",
    "right_eye",
    "left_eye",
    "right_ear",
    "left_ear",
    "left_big_toe",
    null /* left small toe */,
    "left_heel",
    "right_big_toe",
    null /* right small toe */,
    "right_heel",
  ],
  mp33: [
    "nose",
    null,
    "left_eye",
    null,
    null,
    "right_eye",
    null,
    "left_ear",
    "right_ear",
    null,
    null,
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    null,
    null,
    null,
    null,
    null,
    null /* hands */,
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
    "left_heel",
    "right_heel",
    "left_big_toe",
    "right_big_toe",
  ],
};

/** The bones an overlay draws, by joint name: a skeleton draws those whose two ends it has (or derives). */
export const BONES: readonly (readonly [Joint, Joint])[] = [
  ["left_shoulder", "right_shoulder"],
  ["left_hip", "right_hip"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
  ["left_ankle", "left_heel"],
  ["left_heel", "left_big_toe"],
  ["right_ankle", "right_heel"],
  ["right_heel", "right_big_toe"],
];

// ------------------------------------------------------------------ analyser results

/** The most frames a pose track may carry: 60 s at 10 fps; `video.pose` lowers `fps` for a longer range (`VIDEO_LIMITS.poseMaxFrames`). */
export const POSE_MAX_FRAMES = 600;

/** An ISO 639 language: two letters, or three where it has no two-letter code (whisper's `yue`, `haw`). */
export const LanguageCodeSchema = z.string().regex(/^[a-z]{2,3}$/);

const Coordinate = z.number().finite().min(-100_000).max(100_000);
const KeypointSchema = z.tuple([Coordinate, Coordinate, z.number().min(0).max(1)]);

/** `PoseTrack@1`: keypoints in pixels of the frames the analyser was handed, per person, per frame. */
export const PoseTrackSchema = z
  .strictObject({
    skeleton: SkeletonIdSchema,
    coordSpace: z.literal("pixels"),
    frames: z
      .array(
        z.strictObject({
          timeSec: z.number().min(0).max(36_000),
          people: z
            .array(
              z.strictObject({
                /** `[x, y, width, height]`. */
                bbox: z.tuple([Coordinate, Coordinate, z.number().min(0).max(100_000), z.number().min(0).max(100_000)]),
                score: z.number().min(0).max(1),
                keypoints: z.array(KeypointSchema).max(33),
              }),
            )
            .max(10),
        }),
      )
      .max(POSE_MAX_FRAMES),
  })
  .superRefine((track, context) => {
    const expected = SKELETONS[track.skeleton].length;
    track.frames.forEach((frame, index) => {
      for (const person of frame.people) {
        if (person.keypoints.length !== expected)
          context.addIssue({
            code: "custom",
            path: ["frames", index],
            message: `a ${track.skeleton} person has ${String(expected)} keypoints`,
          });
      }
    });
  });
export type PoseTrack = z.infer<typeof PoseTrackSchema>;

/** `Transcript@1`: speech with its times. */
export const TranscriptSchema = z.strictObject({
  language: LanguageCodeSchema,
  segments: z.array(z.strictObject({ startSec: z.number().min(0), endSec: z.number().min(0), text: z.string().max(2_000) })).max(2_000),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** `FrameText@1`: the text read off each frame. */
export const FrameTextSchema = z.strictObject({
  frames: z
    .array(z.strictObject({ timeSec: z.number().min(0), text: z.string().max(4_000), confidence: z.number().min(0).max(100) }))
    .max(50),
});
export type FrameText = z.infer<typeof FrameTextSchema>;

// ------------------------------------------------------------------ every analyser

/** `describe` is reserved: no analyser of it is built. */
export const VIDEO_CAPABILITIES = ["pose", "transcribe", "ocr", "describe"] as const;
export type VideoCapability = (typeof VIDEO_CAPABILITIES)[number];

export const ANALYZER_OUTPUTS = ["PoseTrack@1", "Transcript@1", "FrameText@1"] as const;
export type AnalyzerOutput = (typeof ANALYZER_OUTPUTS)[number];

/** Each built capability's result schema and its versioned name. */
export const CAPABILITY_OUTPUT = { pose: "PoseTrack@1", transcribe: "Transcript@1", ocr: "FrameText@1" } as const satisfies Record<
  Exclude<VideoCapability, "describe">,
  AnalyzerOutput
>;
export const ANALYZER_RESULT_SCHEMAS = {
  "PoseTrack@1": PoseTrackSchema,
  "Transcript@1": TranscriptSchema,
  "FrameText@1": FrameTextSchema,
} as const;

export const AnalyzerManifestSchema = z
  .strictObject({
    /** E.g. `builtin.rtmpose`, `cmd.mediapipe`, `mcp.vision-lab`. */
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    version: z.string().max(32),
    attribution: z.strictObject({ name: z.string().max(100), url: z.string().url().max(512).optional(), licence: z.string().max(64) }),
    capabilities: z
      .array(
        z.strictObject({
          capability: z.enum(VIDEO_CAPABILITIES),
          /** What it is handed, by reference. */
          inputs: z
            .array(z.enum(["frames", "audio", "video"]))
            .min(1)
            .max(3),
          output: z.enum(ANALYZER_OUTPUTS),
          /** For pose. */
          skeleton: SkeletonIdSchema.optional(),
          languages: z.array(LanguageCodeSchema).max(100).optional(),
          maxFrames: z.number().int().positive().max(POSE_MAX_FRAMES).optional(),
          maxAudioSec: z.number().positive().max(36_000).optional(),
        }),
      )
      .min(1)
      .max(4),
    /** False: data leaves the machine, and each call is raised to `external`. */
    local: z.boolean(),
    /** It runs in a Tavi-confined child. */
    confined: z.boolean(),
    models: z.array(z.strictObject({ name: z.string().max(100), installed: z.boolean() })).max(20),
  })
  .superRefine((manifest, context) => {
    manifest.capabilities.forEach((entry, index) => {
      // `describe` has no result type yet, so no analyser may claim it.
      if (entry.capability === "describe")
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "capability"],
          message: "describe is reserved: no analyser of it is built",
        });
      // Each capability is answered in its own result type, so the registry parses an answer against the right schema.
      else if (entry.output !== CAPABILITY_OUTPUT[entry.capability])
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "output"],
          message: `${entry.capability} answers ${CAPABILITY_OUTPUT[entry.capability]}`,
        });
    });
  });
export type AnalyzerManifest = z.infer<typeof AnalyzerManifestSchema>;

/** Per capability, what a request carries besides its media. */
export interface AnalyzeOptions {
  readonly pose: Readonly<Record<string, never>>;
  readonly transcribe: { readonly language?: string };
  readonly ocr: { readonly language: "eng" };
  readonly describe: Readonly<Record<string, never>>;
}

/** Per capability, what a successful analysis answers. */
export interface AnalyzeResult {
  readonly pose: PoseTrack;
  readonly transcribe: Transcript;
  readonly ocr: FrameText;
  readonly describe: never;
}

export interface AnalyzeRequest<C extends VideoCapability> {
  readonly capability: C;
  /** By path in the run directory: the analyser may read only those. */
  readonly frames?: readonly DecodedFrame[];
  readonly audio?: { readonly path: string; readonly seconds: number };
  /** Where it may write scratch files and its answer. */
  readonly runDirectory: string;
  readonly options: AnalyzeOptions[C];
  readonly limits: { readonly timeoutMs: number; readonly maxOutputBytes: number };
  readonly signal: AbortSignal;
  /**
   * Whom the call is for: an analyser that reaches a service on someone's
   * behalf (an MCP server) checks they may use it, and refuses a call
   * that names no one. Others ignore it.
   */
  readonly caller?: AnalyzerCaller;
}

/** The person and workspace a video tool call is made for, as an MCP server's tools are checked against them. */
export interface AnalyzerCaller {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly memoryReach?: MemoryReach | undefined;
}

/**
 * The two-tier error model: on the transient ones the registry tries the next
 * analyser; `unsupported`, `bad-input` and `protocol` are contract errors and
 * stop the chain.
 */
export const ANALYZER_ERRORS = [
  "unsupported",
  "bad-input",
  "too-large",
  "timeout",
  "unavailable",
  "model-load",
  "memory",
  "crashed",
  "protocol",
  "internal",
] as const;
export type AnalyzerErrorCode = (typeof ANALYZER_ERRORS)[number];
/** The errors the next analyser in the owner's order is tried after. */
export const ANALYZER_FALLBACK_ERRORS: readonly AnalyzerErrorCode[] = ["too-large", "timeout", "unavailable", "model-load", "memory"];

export type AnalyzeOutcome<T> =
  | { readonly ok: true; readonly result: T; readonly model: string; readonly peakKb?: number; readonly wallMs: number }
  | { readonly ok: false; readonly error: { readonly code: AnalyzerErrorCode; readonly retryable: boolean; readonly message: string } };

export interface VideoAnalyzerPort {
  manifest(): AnalyzerManifest;
  analyze<C extends VideoCapability>(request: AnalyzeRequest<C>): Promise<AnalyzeOutcome<AnalyzeResult[C]>>;
  /** Start what a call needs (a model loaded) before one is made. */
  prewarm?(): void;
  close(): Promise<void>;
}

/** The registry's answer: the outcome, the analyser that gave it, and every one tried. */
export type RegistryOutcome<T> = AnalyzeOutcome<T> & { readonly analyzer?: string; readonly tried: readonly string[] };

/**
 * How a call may use the chain. `unattended`: a run nobody watches, where a
 * local analyser is preferred over a remote one ahead of it, so a routine
 * still gets an answer. `remote`: the one remote analyser the
 * call was assessed external for and allowed to use (its id, as the approval
 * card named it). No other remote analyser is reached, not even as a
 * fallback, so a call assessed read-only cannot send the video off the
 * machine, and one approved for one remote analyser cannot send it to another.
 */
export interface AnalyzerChainOptions {
  readonly unattended?: boolean;
  readonly remote?: string;
}

/** What a call will carry, known before it is made: how its first analyser is chosen. */
export interface AnalyzerCall {
  readonly capability: VideoCapability;
  readonly frames?: number;
  readonly audioSec?: number;
}

/** The owner's ordered choice per capability; tools ask the registry, never an implementation. */
export interface VideoAnalyzerRegistry {
  /** In the owner's order, enabled and installed only. */
  for(capability: VideoCapability): readonly VideoAnalyzerPort[];
  /**
   * The analyser a call would try first: the first in order that takes what
   * the call carries. Its manifest decides the call's effect:
   * a remote one makes the call external, and only it is then `remote`.
   */
  first(call: AnalyzerCall, options?: Pick<AnalyzerChainOptions, "unattended">): VideoAnalyzerPort | undefined;
  analyze<C extends VideoCapability>(
    request: AnalyzeRequest<C>,
    options?: AnalyzerChainOptions,
  ): Promise<RegistryOutcome<AnalyzeResult[C]>>;
}

// ------------------------------------------------------------------ the owner's analyser configuration

/** The built-in analysers' ids: the pose and transcription add-ons, and the PDF engine's OCR. */
export const BUILTIN_ANALYZERS = ["rtmpose", "whisper-cpp", "pdf-ocr"] as const;

/**
 * One entry of `<data>/video/analyzers.json`: a built-in (optionally
 * on the end user's own model files), an owner-configured command, or
 * an MCP server's tool. Host configuration: not a workspace setting, never
 * editable from the canvas or by a model.
 */
export const AnalyzerEntrySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("builtin"),
    id: z.enum(BUILTIN_ANALYZERS),
    /** The end user's own weights, under the licence they hold; never copied or redistributed. */
    model: z
      .strictObject({
        path: z.string().min(1).max(4_096),
        detectorPath: z.string().min(1).max(4_096).optional(),
        skeleton: SkeletonIdSchema.optional(),
        licence: z.string().min(1).max(64),
      })
      .optional(),
  }),
  z
    .strictObject({
      type: z.literal("command"),
      id: z.string().regex(/^[a-z0-9-]{1,32}$/),
      command: z.string().min(1).max(4_096),
      /** Placeholders (`{{framesDir}}`, `{{audio}}`, `{{outDir}}`, `{{options}}`) are whole arguments, never interpolated. */
      args: z.array(z.string().max(4_096)).max(32),
      manifest: AnalyzerManifestSchema,
      /** The script's own files, readable inside the denied home. */
      readRoots: z.array(z.string().min(1).max(4_096)).max(8),
      /** Hosts a remote command may reach; only with `manifest.local: false`, so its calls are raised to external. */
      domains: z.array(z.string().min(1).max(253)).max(8).optional(),
    })
    .refine((entry) => entry.domains === undefined || entry.domains.length === 0 || !entry.manifest.local, {
      message: "a command that reaches the network is not local: set manifest.local to false",
      path: ["domains"],
    }),
  z.strictObject({
    type: z.literal("mcp"),
    server: z.string().min(1).max(128),
    tool: z.string().min(1).max(128),
    /** Pinned by the owner, when the server's tool carries none (`_meta["tavi/analyzer"]`). */
    manifest: AnalyzerManifestSchema.optional(),
  }),
]);
export type AnalyzerEntry = z.infer<typeof AnalyzerEntrySchema>;

export const AnalyzerConfigSchema = z.strictObject({
  pose: z
    .array(AnalyzerEntrySchema)
    .max(4)
    .default([{ type: "builtin", id: "rtmpose" }]),
  transcribe: z
    .array(AnalyzerEntrySchema)
    .max(4)
    .default([{ type: "builtin", id: "whisper-cpp" }]),
  ocr: z
    .array(AnalyzerEntrySchema)
    .max(4)
    .default([{ type: "builtin", id: "pdf-ocr" }]),
});
export type AnalyzerConfig = z.infer<typeof AnalyzerConfigSchema>;

// ------------------------------------------------------------------ the owner's pose engine

/**
 * What Tavi itself does with a pose track: follow the
 * subject, measure, find reps, check the setup, and draw a rep's overlay.
 * Built in `@tavi/plugin-video`; the video tools see only this port, so no
 * analyser decides how its keypoints are measured, reported or drawn.
 */
export interface PoseEvaluationRequest {
  readonly track: PoseTrack;
  readonly frameSize: { readonly width: number; readonly height: number };
  readonly movement: Movement;
  readonly side: "left" | "right" | "auto";
  readonly cameraMoving?: boolean;
}

export type PoseJoints = Readonly<Partial<Record<Joint, { readonly x: number; readonly y: number; readonly score: number }>>>;

export interface PoseEvaluationResult {
  readonly side: "left" | "right";
  readonly subject: readonly (PoseJoints | undefined)[];
  readonly boxes: readonly (readonly [number, number, number, number] | undefined)[];
  readonly setup: {
    readonly view: "side" | "oblique" | "front" | "unknown";
    readonly fullBody: boolean;
    readonly personCount: number;
    readonly meanKeypointScore: number;
    readonly problems: readonly SetupProblem[];
  };
  readonly series: readonly {
    readonly joint: "knee" | "hip" | "ankle" | "elbow" | "shoulder" | "trunk";
    readonly side: "left" | "right";
    readonly samples: readonly (readonly [number, number])[];
  }[];
  readonly reps: readonly {
    readonly startSec: number;
    readonly bottomSec: number;
    readonly endSec: number;
    readonly bottomIndex: number;
    readonly atBottom: Readonly<Record<string, number>>;
    readonly faults: readonly string[];
  }[];
  readonly validated: boolean;
}

export interface PoseOverlayRequest {
  readonly frame: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly joints: PoseJoints;
  readonly box?: readonly [number, number, number, number];
  readonly angles: readonly {
    readonly joint: "knee" | "hip" | "ankle" | "elbow" | "shoulder" | "trunk";
    readonly side: "left" | "right";
    readonly degrees: number;
  }[];
}

export interface VideoPoseEnginePort {
  evaluate(request: PoseEvaluationRequest): PoseEvaluationResult;
  /** A PNG of the key frame with the subject drawn, cropped to it; undefined when nothing says where the subject is. */
  overlay(request: PoseOverlayRequest): { readonly png: Uint8Array; readonly width: number; readonly height: number } | undefined;
}
