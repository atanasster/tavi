import { readBoundedBody } from "@tavi/node-kit";

/**
 * The most a sign-in, provider or npm answer the CLI reads as JSON may hold, far above those (a few
 * KB). PyPI's project document lists every release and is read under its own, larger bound.
 */
const JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A response's body parsed as JSON, read to at most `maxBytes` while it arrives (`Response.json()`
 * buffers whatever a server sends). Rejects with `BodyTooLargeError` past the limit and a `SyntaxError`
 * that quotes nothing of it for a body that is not JSON; the caller checks the shape it needs.
 */
export async function readJsonBody(response: Response, maxBytes: number = JSON_BODY_MAX_BYTES): Promise<unknown> {
  const { bytes } = await readBoundedBody(response, maxBytes);
  try {
    // TextDecoder drops a leading byte-order mark, as `Response.json()` does.
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // V8's own message quotes the start of the input, and a token endpoint's body can hold a secret.
    throw new SyntaxError("the body is not JSON");
  }
}
