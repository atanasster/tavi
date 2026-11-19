import { startOpenAiStub, type OpenAiStub } from "@tavi/test-support/openai-stub";

/**
 * The provider onboarding talks to: an OpenAI-compatible stub that lists `m1`
 * and accepts only `key`, refusing any other with 401. Verify's probe (a
 * request offering `probe_noop`) is answered with a call to that tool; any
 * other turn in words, "Hello from the stub.", each counting the prompt it read. While `chat.unknown` holds,
 * generation answers 404 for the model, as a provider does for one the
 * account cannot use.
 */
export function startOnboardingStub(key: string, chat: { readonly unknown: boolean } = { unknown: false }): Promise<OpenAiStub> {
  return startOpenAiStub({
    key,
    reply: (request) => {
      // Prompt tokens in proportion to the request, as a server reports them: a short count reads as a prompt it cut.
      const promptTokens = Math.ceil(request.raw.length / 4);
      if (chat.unknown)
        return {
          status: 404,
          body: { error: { message: "The model `m1` does not exist", type: "invalid_request_error", code: "model_not_found" } },
        };
      return request.raw.includes("probe_noop")
        ? {
            calls: [{ id: "call_1", name: "probe_noop" }],
            usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
          }
        : { says: "Hello from the stub.", usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 } };
    },
  });
}
