import {
  ANALYZER_FALLBACK_ERRORS,
  ANALYZER_RESULT_SCHEMAS,
  CAPABILITY_OUTPUT,
  type AnalyzeOutcome,
  type AnalyzeRequest,
  type AnalyzeResult,
  type AnalyzerCall,
  type AnalyzerChainOptions,
  type AnalyzerManifest,
  type RegistryOutcome,
  type VideoAnalyzerPort,
  type VideoAnalyzerRegistry,
  type VideoCapability,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * The owner's ordered choice of analysers per capability: a request
 * goes to the first analyser whose manifest covers its capability and what it
 * carries; on a transient failure (`ANALYZER_FALLBACK_ERRORS`) the next is
 * tried, while a contract error (`unsupported`, `bad-input`, `protocol`, or
 * anything else) stops the chain. Every answer is parsed here, in the owner,
 * against its capability's result schema and size: one that fails is
 * `protocol`, whatever the analyser said.
 *
 * A remote analyser (`local: false`) is reached only by a call assessed
 * external for it (`remote` names it), so a call allowed as read-only never
 * sends a video off the machine, and one approved for one remote analyser
 * never falls back to another; on an unattended run a local analyser is put
 * ahead of remote ones, so a routine still gets an answer.
 */

export interface AnalyzerRegistry extends VideoAnalyzerRegistry {
  /** Each capability's chain as configured, for `doctor`. */
  chains(): Readonly<Partial<Record<VideoCapability, readonly AnalyzerManifest[]>>>;
  /** Closes every analyser. */
  close(): Promise<void>;
}

type Failure = Extract<AnalyzeOutcome<never>, { readonly ok: false }>["error"];

function failure(code: Failure["code"], message: string): Extract<AnalyzeOutcome<never>, { readonly ok: false }> {
  return { ok: false, error: { code, retryable: ANALYZER_FALLBACK_ERRORS.includes(code), message } };
}

/** What a request carries, as `first` is asked about it. */
function callOf(request: AnalyzeRequest<VideoCapability>): AnalyzerCall {
  return {
    capability: request.capability,
    ...(request.frames === undefined ? {} : { frames: request.frames.length }),
    ...(request.audio === undefined ? {} : { audioSec: request.audio.seconds }),
  };
}

/** Why an analyser cannot take this call without being asked (`unsupported` or `too-large`), or nothing when it can. */
function mismatch(manifest: AnalyzerManifest, call: AnalyzerCall): Failure | undefined {
  const entry = manifest.capabilities.find((candidate) => candidate.capability === call.capability);
  if (entry === undefined) return { code: "unsupported", retryable: false, message: `${manifest.id} does not do ${call.capability}` };
  const frames = call.frames ?? 0;
  const carried = [...(frames > 0 ? ["frames" as const] : []), ...(call.audioSec === undefined ? [] : ["audio" as const])];
  // It must take what the call carries: frames for pose and OCR, audio for transcription.
  if (!carried.some((input) => entry.inputs.includes(input)))
    return {
      code: "unsupported",
      retryable: false,
      message: `${manifest.id} takes ${entry.inputs.join(", ")}, not ${carried.join(", ") || "nothing"}`,
    };
  if (entry.maxFrames !== undefined && frames > entry.maxFrames)
    return { code: "too-large", retryable: true, message: `${manifest.id} takes at most ${String(entry.maxFrames)} frames` };
  if (entry.maxAudioSec !== undefined && call.audioSec !== undefined && call.audioSec > entry.maxAudioSec)
    return { code: "too-large", retryable: true, message: `${manifest.id} takes at most ${String(entry.maxAudioSec)} s of audio` };
  return undefined;
}

/** An answer as the owner takes it: valid against its result schema, within the size asked, in the skeleton declared. */
function checked<C extends VideoCapability>(
  manifest: AnalyzerManifest,
  request: AnalyzeRequest<C>,
  outcome: Extract<AnalyzeOutcome<AnalyzeResult[C]>, { readonly ok: true }>,
): AnalyzeOutcome<AnalyzeResult[C]> {
  if (request.capability === "describe") return failure("protocol", "describe has no result type");
  const capability = request.capability as Exclude<VideoCapability, "describe">;
  const parsed = ANALYZER_RESULT_SCHEMAS[CAPABILITY_OUTPUT[capability]].safeParse(outcome.result);
  if (!parsed.success)
    return failure(
      "protocol",
      `${manifest.id} answered outside ${CAPABILITY_OUTPUT[capability]}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const size = Buffer.byteLength(JSON.stringify(parsed.data));
  if (size > request.limits.maxOutputBytes)
    return failure("protocol", `${manifest.id} answered ${String(size)} bytes; the most is ${String(request.limits.maxOutputBytes)}`);
  const declared = manifest.capabilities.find((entry) => entry.capability === capability)?.skeleton;
  if (capability === "pose" && declared !== undefined && (parsed.data as { readonly skeleton: string }).skeleton !== declared)
    return failure("protocol", `${manifest.id} declared ${declared} and answered another skeleton`);
  return { ...outcome, result: parsed.data as AnalyzeResult[C] };
}

export function createAnalyzerRegistry(chains: Readonly<Partial<Record<VideoCapability, readonly VideoAnalyzerPort[]>>>): AnalyzerRegistry {
  const of = (capability: VideoCapability): readonly VideoAnalyzerPort[] => (capability === "describe" ? [] : (chains[capability] ?? []));
  const ordered = (capability: VideoCapability, options: AnalyzerChainOptions): readonly VideoAnalyzerPort[] => {
    const chain = of(capability);
    if (options.unattended !== true || !chain.some((analyzer) => analyzer.manifest().local)) return chain;
    // Unattended, a local analyser goes first; the remote ones keep their order behind it.
    return [...chain.filter((analyzer) => analyzer.manifest().local), ...chain.filter((analyzer) => !analyzer.manifest().local)];
  };
  return {
    for: of,
    first: (call, options = {}) => ordered(call.capability, options).find((analyzer) => mismatch(analyzer.manifest(), call) === undefined),
    chains: () =>
      Object.fromEntries(
        Object.entries(chains).map(([capability, analyzers]) => [capability, (analyzers ?? []).map((analyzer) => analyzer.manifest())]),
      ),
    async analyze<C extends VideoCapability>(
      request: AnalyzeRequest<C>,
      options: AnalyzerChainOptions = {},
    ): Promise<RegistryOutcome<AnalyzeResult[C]>> {
      const tried: string[] = [];
      const chain = ordered(request.capability, options);
      const call = callOf(request);
      if (chain.length === 0) return { ...failure("unavailable", `no analyser does ${request.capability} here`), tried };
      let last: Failure | undefined;
      for (const analyzer of chain) {
        const manifest = analyzer.manifest();
        // A remote analyser is reached only by the call allowed to use that one.
        if (!manifest.local && options.remote !== manifest.id) {
          last ??= {
            code: "unavailable",
            retryable: true,
            message: `${manifest.id} is remote, and this call was not allowed to send the video to it`,
          };
          continue;
        }
        if (request.signal.aborted) return { ...failure("timeout", "the call was stopped"), tried };
        // One that cannot take what the call carries is passed over unasked.
        const refused = mismatch(manifest, call);
        if (refused !== undefined) {
          last = refused;
          continue;
        }
        tried.push(manifest.id);
        let outcome: AnalyzeOutcome<AnalyzeResult[C]>;
        try {
          outcome = await analyzer.analyze(request);
        } catch (error) {
          // An analyser that throws broke its contract: the chain stops, as for any contract error.
          outcome = failure("internal", `${manifest.id} failed: ${errorMessage(error)}`);
        }
        const final = outcome.ok ? checked(manifest, request, outcome) : outcome;
        if (final.ok) return { ...final, analyzer: manifest.id, tried };
        last = final.error;
        if (!ANALYZER_FALLBACK_ERRORS.includes(final.error.code)) return { ok: false, error: final.error, analyzer: manifest.id, tried };
      }
      return {
        ok: false,
        error: last ?? { code: "unavailable", retryable: true, message: `no analyser does ${request.capability} here` },
        tried,
      };
    },
    close: async () => {
      const all = new Set(Object.values(chains).flatMap((analyzers) => [...(analyzers ?? [])]));
      // Every one is closed, whichever fails; the first failure is then said.
      const closed = await Promise.allSettled([...all].map(async (analyzer) => analyzer.close()));
      const failed = closed.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    },
  };
}
