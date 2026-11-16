import { expect, it } from "vitest";
import { publicFetch, type FetchTransportPort } from "../src/index.js";

function transport(status: number, headers: Record<string, string>, body = ""): FetchTransportPort {
  return {
    async exchange() {
      return {
        status,
        headers,
        chunks: (async function* () {
          if (body !== "") yield new TextEncoder().encode(body);
        })(),
      };
    },
  };
}

const resolve = async () => ["93.184.216.34"];
const url = "https://example.com/data.json";

it("keeps response headers and +json types out of a fetch's result, so receipts stay strict", async () => {
  const plain = await publicFetch(
    { networkMode: "open_web", resolve, transport: transport(200, { "content-type": "application/json", "set-cookie": "s=1" }, "{}") },
    { url },
    AbortSignal.timeout(2000),
  );
  expect(plain).not.toHaveProperty("headers");
  await expect(
    publicFetch(
      { networkMode: "open_web", resolve, transport: transport(200, { "content-type": "application/ld+json" }, "{}") },
      { url },
      AbortSignal.timeout(2000),
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

it("reads a feed served as RSS or Atom, as it reads any XML", async () => {
  for (const type of ["application/rss+xml", "application/atom+xml; charset=utf-8"]) {
    const feed = await publicFetch(
      { networkMode: "open_web", resolve, transport: transport(200, { "content-type": type }, "<rss></rss>") },
      { url: "https://example.com/feed.xml" },
      AbortSignal.timeout(2000),
    );
    expect(feed.body).toBe("<rss></rss>");
  }
});
