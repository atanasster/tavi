import { z } from "zod";
import {
  AFFORDABLE_TOKENS_PATTERN,
  CONTEXT_OVERFLOW_PATTERN,
  MAX_MESSAGE_TEXT_BYTES,
  ModelErrorSchema,
  ModelUsageSchema,
  TaviError,
  scrubCredentialText,
  type ModelError,
  type ModelUsage,
} from "@tavi/contracts";
const count = z.number().int().nonnegative().safe();
const index = count.max(127);
const failure = z.object({
  message: z.string().max(16_384),
  code: z.string().max(128),
  status: z.number().int().optional(),
  providerRetryAfterMs: count.optional(),
  requestId: z.string().max(256).optional(),
});
const text = z.object({ type: z.literal("text"), text: z.string().max(MAX_MESSAGE_TEXT_BYTES) });
const tool = z.object({
  type: z.literal("tool-call"),
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  arguments: z.string().max(65_536),
});
export const ModelChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("block-start"), index, blockType: z.enum(["text", "tool-call", "reasoning"]) }),
  z.object({ type: z.literal("text-delta"), index, text: z.string().max(65_536) }),
  z.object({ type: z.literal("reasoning-delta"), index, text: z.string().max(65_536) }),
  z.object({
    type: z.literal("tool-call-delta"),
    index,
    id: z.string().max(128),
    name: z.string().max(128).optional(),
    argumentsDelta: z.string().max(65_536),
  }),
  z.object({
    type: z.literal("block-end"),
    index,
    block: z.discriminatedUnion("type", [
      text,
      tool,
      z.object({ type: z.literal("reasoning"), text: z.string().max(MAX_MESSAGE_TEXT_BYTES) }),
    ]),
  }),
  z.object({
    type: z.literal("usage"),
    usage: z.object({
      inputTokens: count,
      outputTokens: count,
      totalTokens: count.optional(),
      cacheReadTokens: count.optional(),
      cacheWriteTokens: count.optional(),
      reasoningTokens: count.optional(),
    }),
  }),
  z.object({
    type: z.literal("finish"),
    reason: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("stop") }),
      z.object({ kind: z.literal("tool-calls") }),
      z.object({ kind: z.literal("max-tokens") }),
      z.object({ kind: z.literal("error"), failure }),
      z.object({ kind: z.literal("aborted"), failure }),
    ]),
  }),
]);
export type ModelChunk = z.infer<typeof ModelChunkSchema>;
export function modelFailure(value: unknown, aborted: boolean): ModelError {
  const thrown = value !== null && typeof value === "object" ? value : {};
  const nested = Reflect.get(thrown, "failure");
  const object = nested !== null && typeof nested === "object" ? nested : thrown;
  const field = (key: string): unknown => Reflect.get(object, key);
  const raw = typeof field("code") === "string" ? String(field("code")).toUpperCase() : "";
  const status = field("status");
  let code: ModelError["code"] = "provider";
  let retryable = false;
  if (aborted || raw === "ABORTED") code = "aborted";
  else if (["QUOTA", "ACCOUNT_QUOTA", "QUOTA_EXCEEDED"].includes(raw)) code = "quota_exceeded";
  else if (["AUTH", "INVALID_CREDENTIAL"].includes(raw)) code = "auth";
  else if (raw === "RATE_LIMIT") {
    code = "rate_limit";
    retryable = true;
  } else if (["INVALID_REQUEST", "INVALID_CONFIG", "CONTEXT_WINDOW_EXCEEDED", "IMAGE_OFFLOAD_REQUIRED"].includes(raw))
    code = "invalid_request";
  else if (raw === "MODEL_RETIRED") code = "model_retired";
  else if (["MODEL_UNAVAILABLE", "UNKNOWN_MODEL"].includes(raw)) code = "model_unavailable";
  else if (["SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED"].includes(raw)) retryable = true;
  else if (status === 401 || status === 403) code = "auth";
  else if (status === 429) {
    code = "rate_limit";
    retryable = true;
  } else if (status === 400 || status === 413) code = "invalid_request";
  else if (typeof status === "number" && status >= 500 && status <= 599) retryable = true;
  const delay = field("providerRetryAfterMs");
  const requestId = field("requestId");
  const message = scrubCredentialText(typeof field("message") === "string" ? String(field("message")) : "Model provider failed").slice(
    0,
    2000,
  );
  const contextOverflow = raw === "CONTEXT_WINDOW_EXCEEDED" || (code === "invalid_request" && CONTEXT_OVERFLOW_PATTERN.test(message));
  // A key that can pay for fewer output tokens than were asked for: the turn asks once more for what it can afford.
  const affordable = Number(AFFORDABLE_TOKENS_PATTERN.exec(message)?.[1] ?? 0);
  return ModelErrorSchema.parse({
    code,
    retryable,
    message,
    ...(contextOverflow ? { contextOverflow: true } : {}),
    ...(affordable > 0 ? { affordableTokens: affordable } : {}),
    ...(typeof delay === "number" && Number.isSafeInteger(delay) && delay >= 0 ? { retryAfterMs: Math.min(delay, 86_400_000) } : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId.slice(0, 256) } : {}),
  });
}
export function modelUsage(u: Extract<ModelChunk, { type: "usage" }>["usage"]): ModelUsage {
  const input = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  if (
    !Number.isSafeInteger(input) ||
    (u.totalTokens !== undefined && u.totalTokens !== input + u.outputTokens) ||
    (u.reasoningTokens ?? 0) > u.outputTokens
  )
    throw new TaviError("MODEL_FAILED", "Provider usage counters are inconsistent");
  return ModelUsageSchema.parse({
    inputTokens: input,
    inputNoCacheTokens: u.inputTokens,
    inputCacheReadTokens: u.cacheReadTokens ?? 0,
    inputCacheWriteTokens: u.cacheWriteTokens ?? 0,
    outputTokens: u.outputTokens,
    ...(u.totalTokens === undefined ? {} : { totalTokens: u.totalTokens }),
    ...(u.reasoningTokens === undefined ? {} : { outputReasoningTokens: u.reasoningTokens }),
  });
}
/** Cancellation also settles providers that ignore their signal. Late results cannot emit events. */
export async function modelAwait<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
