/** A model provider's message vocabulary: plain data, so a plugin's provider needs no runtime import. */
export type LanguageModelBlock = { type: "text"; text: string } | { type: "tool-call"; id: string; name: string; arguments: string };
export type LanguageModelMessage = {
  id: string;
  content: readonly LanguageModelBlock[];
} & (
  | { role: "system"; source: { kind: "system-prompt" } }
  | { role: "user"; source: { kind: "user" } }
  | { role: "assistant"; source: { kind: "model"; provider: string; model: string } }
  | { role: "tool"; source: { kind: "tool"; callId: string }; toolCallId: string; isError?: boolean }
);
export interface LanguageModelInfo {
  provider: string;
  id: string;
  name: string;
  inputModalities?: readonly ("text" | "image" | "audio" | "video")[];
  context?: { contextWindow: number };
  defaultMaxTokens?: number;
}
export interface LanguageModelRequest {
  provider: string;
  model: string;
  messages: LanguageModelMessage[];
  system?: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  purpose?: "compaction" | "session-title";
}
export interface LanguageModelFailure {
  message: string;
  code: string;
  status?: number;
  providerRetryAfterMs?: number;
  requestId?: string;
}
export type LanguageModelChunk =
  | { type: "block-start"; index: number; blockType: "text" | "tool-call" | "reasoning" }
  | { type: "text-delta" | "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: LanguageModelBlock | { type: "reasoning"; text: string } }
  | {
      type: "usage";
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
      };
    }
  | {
      type: "finish";
      reason: { kind: "stop" | "tool-calls" | "max-tokens" } | { kind: "error" | "aborted"; failure: LanguageModelFailure };
      replayState?: unknown;
    };
/** One account owns one route. Listing is local configured metadata, never a network probe. */
export interface LanguageModelProvider {
  listModels(provider: string): readonly LanguageModelInfo[];
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LanguageModelInfo>;
  prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LanguageModelInfo;
    stream(options: LanguageModelRequest): AsyncIterable<LanguageModelChunk>;
  }>;
}
