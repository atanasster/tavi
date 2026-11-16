import { BodyTooLargeError } from "@tavi/node-kit";
import { describe, expect, it } from "vitest";

import { readJsonBody } from "../../src/shared/json-body.js";

describe("a JSON answer, read within a bound", () => {
  it("parses a body within its limit", async () => {
    expect(await readJsonBody(new Response('{"version":"1.2.3"}'))).toEqual({ version: "1.2.3" });
  });

  it("refuses a body past its limit, by what it declares or what arrives", async () => {
    await expect(readJsonBody(new Response(JSON.stringify({ padding: "x".repeat(64) })), 16)).rejects.toBeInstanceOf(BodyTooLargeError);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4; index += 1) controller.enqueue(new TextEncoder().encode('"xxxxxxxx"'));
        controller.close();
      },
    });
    await expect(readJsonBody(new Response(streamed), 16)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("reads past a leading byte-order mark, as Response.json() does", async () => {
    expect(await readJsonBody(new Response('\uFEFF{"ok":true}'))).toEqual({ ok: true });
  });

  it("rejects a body that is not JSON, for the caller to treat as an unexpected answer", async () => {
    await expect(readJsonBody(new Response("<html>proxy error</html>"))).rejects.toBeInstanceOf(SyntaxError);
  });

  it("quotes nothing of a body that is not JSON, which may hold a secret", async () => {
    const error = await readJsonBody(new Response("gho_ABCDEFGHIJKLMNOP")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(String((error as Error).message)).not.toContain("gho_");
    expect((error as Error).message).toBe("the body is not JSON");
  });
});
