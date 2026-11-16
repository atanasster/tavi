import { describe, expect, it } from "vitest";

import { aggregateStatus, checkPartCount, httpFailureReceipt, readJson, redactSecrets } from "../src/index.js";

describe("channel kit", () => {
  it("redacts each secret, and its HTTP Basic form under each user", () => {
    const basic = Buffer.from("api:k3y").toString("base64");
    expect(redactSecrets(`url /botk3y/x and Basic ${basic}`, ["k3y", undefined, ""], ["api"])).toBe(
      "url /bot<redacted>/x and Basic <redacted>",
    );
  });

  it("reads JSON or nothing, and maps a status and receipts to an outcome", async () => {
    expect(await readJson(new Response('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJson(new Response("<html>"))).toBeUndefined();
    expect(httpFailureReceipt(0, 404, "x").status).toBe("rejected");
    expect(httpFailureReceipt(0, 503, "x").status).toBe("uncertain");
    expect(aggregateStatus([{ index: 0, status: "accepted" }])).toBe("accepted");
    expect(aggregateStatus([{ index: 0, status: "rejected" }])).toBe("rejected");
    expect(
      aggregateStatus([
        { index: 0, status: "accepted" },
        { index: 1, status: "rejected" },
      ]),
    ).toBe("uncertain");
    expect(aggregateStatus([])).toBe("uncertain");
  });

  it("refuses a message with no parts or too many", () => {
    const message = { effectId: "e", connectionId: "c", destination: {}, parts: [] };
    expect(() => checkPartCount(message, 1, "X")).toThrow(/0 parts/);
    expect(() => checkPartCount({ ...message, parts: [{ content: "a" }, { content: "b" }] }, 1, "X")).toThrow(/2 parts/);
  });
});
