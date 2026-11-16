import { describe, expect, it } from "vitest";

import { createTelegramApi } from "../src/api.js";

/** The Bot API's envelope, checked: a malformed body throws (the request's fate is unknown), never a value of the wrong shape. */

function apiAnswering(body: string, status = 200) {
  return createTelegramApi({
    fetch: (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as typeof fetch,
    token: () => "test-token",
    apiBaseUrl: "https://api.telegram.test",
    requestTimeoutMs: 1000,
    uploadTimeoutMs: 1000,
    pollTimeoutSeconds: 0,
  });
}

const FILE = { field: "document", filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([1]) };

describe("Telegram Bot API envelope", () => {
  it("keeps a valid success and a valid refusal as the API sent them", async () => {
    await expect(apiAnswering(JSON.stringify({ ok: true, result: { id: 7 } })).call("getMe", {})).resolves.toEqual({
      ok: true,
      result: { id: 7 },
    });
    await expect(apiAnswering(JSON.stringify({ ok: true, result: false })).call("deleteMessage", {})).resolves.toEqual({
      ok: true,
      result: false,
    });
    const refusal = { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } };
    await expect(apiAnswering(JSON.stringify(refusal), 429).call("sendMessage", {})).resolves.toEqual(refusal);
    await expect(apiAnswering(JSON.stringify({ ok: false, error_code: 400 }), 400).call("sendMessage", {})).resolves.toEqual({
      ok: false,
      error_code: 400,
      description: "Telegram refused with 400",
    });
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "42"],
    ["no ok", JSON.stringify({ result: {} })],
    ["a success without a result", JSON.stringify({ ok: true })],
    ["a refusal without a code", JSON.stringify({ ok: false, description: "nope" })],
    [
      "a refusal with a non-numeric retry_after",
      JSON.stringify({ ok: false, error_code: 429, description: "x", parameters: { retry_after: "5" } }),
    ],
  ])("throws on %s, never answering a refusal", async (_label, body) => {
    await expect(apiAnswering(body, 502).call("getMe", {})).rejects.toThrow("Telegram answered 502 with a malformed response");
    await expect(apiAnswering(body, 200).callMultipart("sendDocument", { chat_id: "1" }, FILE)).rejects.toThrow(
      "Telegram answered 200 with a malformed response",
    );
  });

  it.each([
    ["an HTML page", "<html>"],
    ["a truncated body", '{"ok":true,"result":{"mess'],
  ])("throws on %s the same way, without the token", async (_label, body) => {
    const error = await apiAnswering(body, 200)
      .call("sendMessage", {})
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Telegram answered 200 with a malformed response");
    expect((error as Error).message).not.toContain("test-token");
  });
});
