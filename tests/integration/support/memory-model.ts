import { expect } from "vitest";

import type { ModelPort, ModelRequest } from "@tavi/contracts";

/** The memory passes' model stand-in: one answer (or a failure) for every call, and the calls it was given. */
export function answerWith(text: string | Error): {
  readonly model: ModelPort;
  readonly calls: { readonly request: ModelRequest; readonly keepRequest: boolean | undefined }[];
} {
  const calls: { readonly request: ModelRequest; readonly keepRequest: boolean | undefined }[] = [];
  const model: ModelPort = {
    async stream(request, options) {
      calls.push({ request, keepRequest: options.keepRequest });
      if (text instanceof Error) throw text;
      return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
    },
  };
  return { model, calls };
}

/** One extraction call, kept off the record, under the pass's attempt prefix, with no tools and its own token cap. */
export function expectOneExtraction(
  calls: readonly { readonly request: ModelRequest; readonly keepRequest: boolean | undefined }[],
  attemptPrefix: string,
  maxOutputTokens: number,
): ModelRequest {
  expect(calls).toHaveLength(1);
  const { request, keepRequest } = calls[0] as (typeof calls)[number];
  expect(keepRequest).toBe(false);
  expect(request.purpose).toBe("extraction");
  expect(request.attemptId.startsWith(attemptPrefix)).toBe(true);
  expect(request.maxOutputTokens).toBe(maxOutputTokens);
  expect(request.tools).toEqual([]);
  return request;
}
