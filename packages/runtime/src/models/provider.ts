import {
  snapshotModelRequest,
  freezeModelValue,
  MAX_MESSAGE_TEXT_BYTES,
  ModelOutcomeSchema,
  TOOL_DOCUMENT_KEY,
  TOOL_MEDIA_KEY,
  TOOL_VIDEO_KEY,
  TaviError,
  providerToolName,
  hasToolMedia,
  toolResultText,
  type LanguageModelMessage,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type ModelPort,
  type ModelRequest,
  type ModelToolCall,
  type ModelUsage,
} from "@tavi/contracts";

import { providerRevision } from "../plugin-host/provider-bindings.js";
import { ModelChunkSchema, modelAwait, modelFailure, modelUsage } from "./provider-stream.js";

/** The single portable-provider boundary for every application model consumer. */
export function languageModelRequest(request: ModelRequest, signal: AbortSignal): LanguageModelRequest {
  request = snapshotModelRequest(request);
  const names = new Map(request.tools.map((tool) => [tool.id, tool.name]));
  const messages: LanguageModelMessage[] = [];
  const calls = new Map<string, string>();
  const answered = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (message.toolResults === undefined || message.toolResults.length === 0)
        throw new TaviError("INVALID_INPUT", "Model tool history needs explicit results");
      for (const result of message.toolResults) {
        if (calls.get(result.toolCallId) !== result.toolName || answered.has(result.toolCallId))
          throw new TaviError("INVALID_INPUT", "Model tool result has no matching unanswered call");
        answered.add(result.toolCallId);
        // A provider profile reads text and tools: an image result (a browser screenshot, a viewed artifact) is its fields, said not shown.
        // A document a result names (`pdf.view`) is not sent either: the result's own text stands for it.
        // Nor is a video (`video.view`): its key goes, as the document's does.
        const withoutVideo =
          typeof result.output === "object" && result.output !== null && TOOL_VIDEO_KEY in result.output
            ? {
                ...Object.fromEntries(Object.entries(result.output as Record<string, unknown>).filter(([key]) => key !== TOOL_VIDEO_KEY)),
                videoFile: "not sent: this provider profile reads text only",
              }
            : result.output;
        const withoutDocument =
          typeof withoutVideo === "object" && withoutVideo !== null && TOOL_DOCUMENT_KEY in withoutVideo
            ? {
                ...Object.fromEntries(Object.entries(withoutVideo as Record<string, unknown>).filter(([key]) => key !== TOOL_DOCUMENT_KEY)),
                documentFile: "not sent: this provider profile reads text only",
              }
            : withoutVideo;
        const output = !hasToolMedia(withoutDocument)
          ? withoutDocument
          : {
              ...Object.fromEntries(Object.entries(withoutDocument as Record<string, unknown>).filter(([key]) => key !== TOOL_MEDIA_KEY)),
              image: "not shown: this provider profile reads text only",
            };
        // An untrusted result is fenced in its envelope here, at conversion (UNTRUSTED-CONTENT U5): the checkpoint keeps it raw.
        messages.push({
          id: `${message.id}.${messages.length}`,
          role: "tool",
          source: { kind: "tool", callId: result.toolCallId },
          toolCallId: result.toolCallId,
          isError: result.isError,
          content: [{ type: "text", text: toolResultText(output, result.envelope) }],
        });
      }
    } else if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (calls.has(call.id) && !answered.has(call.id))
          throw new TaviError("INVALID_INPUT", "Model history repeats a tool call identity");
        calls.set(call.id, call.name);
        answered.delete(call.id);
      }
      messages.push({
        id: message.id,
        role: "assistant",
        source: { kind: "model", provider: request.connectionId, model: request.model },
        content: [
          ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "tool-call" as const,
            id: call.id,
            name: names.get(call.name) ?? providerToolName(call.name),
            arguments: JSON.stringify(call.input ?? null),
          })),
        ],
      });
    } else if (message.role === "system") {
    } else messages.push({ id: message.id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: message.text }] });
  }
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return {
    provider: request.connectionId,
    model: request.model,
    messages,
    signal,
    ...(system === "" ? {} : { system }),
    tools: request.tools.map((tool) => {
      if (tool.inputJsonSchema === null || typeof tool.inputJsonSchema !== "object" || Array.isArray(tool.inputJsonSchema))
        throw new TaviError("INVALID_INPUT", "Model tools require a JSON schema object");
      return {
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.inputJsonSchema) as Record<string, unknown>,
      };
    }),
    ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.purpose === "summary" ? { purpose: "compaction" as const } : {}),
  };
}

export function languageModelPort(provider: LanguageModelProvider): ModelPort {
  return {
    async stream(mutableRequest, { signal: callerSignal, onEvent }) {
      const request = snapshotModelRequest(mutableRequest);
      const lifetime = new AbortController();
      const signal = AbortSignal.any([callerSignal, lifetime.signal, AbortSignal.timeout(300_000)]);
      const { signal: _signal, ...plainInput } = languageModelRequest(request, signal);
      const input = Object.freeze({ ...freezeModelValue(plainInput), signal });
      let text = "";
      let textBytes = 0;
      let usage: ModelUsage = {};
      let usageSeen = false;
      let wireBytes = 0;
      let chunks = 0;
      let iterator: AsyncIterator<unknown> | undefined;
      let consumerError: unknown;
      let consumerFailed = false;
      const toolCalls: ModelToolCall[] = [];
      const canonical = new Map(request.tools.map((tool) => [tool.name, tool.id]));
      const blocks = new Map<number, { type: string; text: string; id?: string; name?: string; ended: boolean; announced: boolean }>();
      const emit = (event: Parameters<Parameters<ModelPort["stream"]>[1]["onEvent"]>[0]) => {
        signal.throwIfAborted();
        try {
          onEvent(event);
        } catch (error) {
          consumerFailed = true;
          consumerError = error;
          throw error;
        }
      };
      try {
        signal.throwIfAborted();
        const prepared = await modelAwait(provider.prepareCall(request.connectionId, request.model, signal), signal);
        signal.throwIfAborted();
        if (prepared.model.provider !== request.connectionId || prepared.model.id !== request.model)
          throw new TaviError("NOT_AUTHORIZED", "Prepared model does not match the requested route");
        iterator = prepared.stream(input)[Symbol.asyncIterator]();
        while (true) {
          signal.throwIfAborted();
          const next = await modelAwait(iterator.next(), signal);
          signal.throwIfAborted();
          if (next.done) throw Object.assign(new Error("Model stream ended without a terminal result"), { code: "STREAM_CLOSED" });
          const parsed = ModelChunkSchema.safeParse(next.value);
          if (!parsed.success) throw new TaviError("MODEL_FAILED", "Invalid model stream chunk");
          const chunk = parsed.data;
          wireBytes += Buffer.byteLength(JSON.stringify(chunk));
          if (++chunks > 65_536 || wireBytes > 2 * 1024 * 1024) throw new TaviError("MODEL_FAILED", "Model stream exceeds the host limit");
          if (chunk.type === "block-start") {
            if (blocks.has(chunk.index) || chunk.blockType === "reasoning")
              throw new TaviError("MODEL_FAILED", "Unsupported or repeated model block");
            blocks.set(chunk.index, { type: chunk.blockType, text: "", ended: false, announced: false });
          } else if (chunk.type === "reasoning-delta") {
            throw new TaviError("MODEL_FAILED", "Unsupported or repeated model block");
          } else if (chunk.type === "text-delta" || chunk.type === "tool-call-delta" || chunk.type === "block-end") {
            const block = blocks.get(chunk.index);
            if (block === undefined || block.ended) throw new TaviError("MODEL_FAILED", "Model delta has no open block");
            const type = chunk.type === "block-end" ? chunk.block.type : chunk.type === "tool-call-delta" ? "tool-call" : "text";
            if (type !== block.type) throw new TaviError("MODEL_FAILED", "Model block type changed");
            if (chunk.type === "text-delta") {
              const bytes = Buffer.byteLength(chunk.text);
              if (textBytes + bytes > MAX_MESSAGE_TEXT_BYTES) throw new TaviError("MODEL_FAILED", "Model output exceeds the host limit");
              textBytes += bytes;
              block.text += chunk.text;
              text += chunk.text;
              emit({ type: "text.delta", attemptId: request.attemptId, blockId: `block-${chunk.index}`, text: chunk.text });
            } else if (chunk.type === "tool-call-delta") {
              if (chunk.id !== "" && block.id !== undefined && block.id !== chunk.id)
                throw new TaviError("MODEL_FAILED", "Model tool identity changed");
              if (chunk.name !== undefined && block.name !== undefined && block.name !== chunk.name)
                throw new TaviError("MODEL_FAILED", "Model tool name changed");
              if (chunk.id !== "") block.id = chunk.id;
              if (chunk.name !== undefined) block.name = chunk.name;
              block.text += chunk.argumentsDelta;
              if (Buffer.byteLength(block.text) > 65_536) throw new TaviError("MODEL_FAILED", "Model tool arguments exceed the host limit");
              if (block.name !== undefined && !block.announced) {
                const name = canonical.get(block.name);
                if (name === undefined) throw new TaviError("MODEL_FAILED", "Unknown model tool");
                block.announced = true;
                emit({ type: "tool.input.started", attemptId: request.attemptId, blockId: `block-${chunk.index}`, toolName: name });
              }
            } else if (chunk.type === "block-end") {
              block.ended = true;
              if (chunk.block.type === "text") {
                if (chunk.block.text !== block.text) throw new TaviError("MODEL_FAILED", "Model text does not match its deltas");
              } else if (chunk.block.type === "tool-call") {
                const completed = chunk.block;
                const name = canonical.get(completed.name);
                if (
                  name === undefined ||
                  toolCalls.length >= 64 ||
                  toolCalls.some((call) => call.id === completed.id) ||
                  (block.id !== undefined && block.id !== completed.id) ||
                  (block.name !== undefined && block.name !== completed.name)
                )
                  throw new TaviError("MODEL_FAILED", "Invalid model tool correlation");
                if (Buffer.byteLength(completed.arguments) > 65_536)
                  throw new TaviError("MODEL_FAILED", "Model tool arguments exceed the host limit");
                const value: unknown = JSON.parse(completed.arguments);
                // The adapter may normalize whitespace at block-end; the JSON value must agree.
                if (block.text !== "" && providerRevision(JSON.parse(block.text)) !== providerRevision(value))
                  throw new TaviError("MODEL_FAILED", "Model tool arguments changed at completion");
                const call = { id: completed.id, name, input: value };
                toolCalls.push(call);
                if (!block.announced)
                  emit({ type: "tool.input.started", attemptId: request.attemptId, blockId: `block-${chunk.index}`, toolName: name });
                emit({
                  type: "tool.completed",
                  attemptId: request.attemptId,
                  blockId: `block-${chunk.index}`,
                  toolName: name,
                  callId: call.id,
                  input: call.input,
                });
              }
            }
          } else if (chunk.type === "usage") {
            const reported = modelUsage(chunk.usage);
            if (usageSeen && providerRevision(reported) !== providerRevision(usage))
              throw new TaviError("MODEL_FAILED", "Conflicting model usage reports");
            usage = reported;
            usageSeen = true;
          } else if (chunk.type === "finish") {
            const failure = "failure" in chunk.reason ? chunk.reason.failure : undefined;
            if (failure === undefined && [...blocks.values()].some((block) => !block.ended))
              throw new TaviError("MODEL_FAILED", "Model finished with open blocks");
            const error = failure === undefined ? undefined : modelFailure(failure, chunk.reason.kind === "aborted");
            // Error-event zero counts are not evidence of a free interrupted request.
            if (error !== undefined) usage = {};
            emit({ type: "model.result", attemptId: request.attemptId, connectionId: request.connectionId, model: request.model, usage });
            return ModelOutcomeSchema.parse({
              status: error === undefined ? "completed" : error.code === "aborted" ? "aborted" : "failed",
              attemptId: request.attemptId,
              text,
              toolCalls,
              usage,
              finishReason: chunk.reason.kind,
              ...(error === undefined
                ? {}
                : { error, ...(error.providerRequestId === undefined ? {} : { providerRequestId: error.providerRequestId }) }),
            });
          }
        }
      } catch (error) {
        if (consumerFailed && error === consumerError) throw error;
        if (error instanceof TaviError && error.code === "NOT_AUTHORIZED") throw error;
        const failure = modelFailure(error, signal.aborted);
        return ModelOutcomeSchema.parse({
          status: failure.code === "aborted" ? "aborted" : "failed",
          attemptId: request.attemptId,
          text: text.slice(0, MAX_MESSAGE_TEXT_BYTES),
          toolCalls,
          usage: {},
          error: failure,
          ...(failure.providerRequestId === undefined ? {} : { providerRequestId: failure.providerRequestId }),
        });
      } finally {
        lifetime.abort(new Error("Model attempt settled"));
        // A noncooperative generator must not hold shutdown; its late values are ignored.
        if (iterator?.return !== undefined)
          void Promise.resolve()
            .then(() => iterator?.return?.())
            .catch(() => {});
      }
    },
  };
}
