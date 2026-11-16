import { afterEach, describe, expect, it } from "vitest";

import { page, startSite, type Site } from "../src/site.js";

const sites: Site[] = [];
afterEach(async () => {
  while (sites.length > 0) await sites.pop()?.close();
});

describe("startSite", () => {
  it("answers each path from its function, with the site's origin, and records what was asked", async () => {
    const site = await startSite({
      answer: (path, origin) =>
        path === "/robots.txt"
          ? { type: "text/plain", body: "User-agent: *\n" }
          : path === "/moved"
            ? { status: 301, headers: { Location: "/home" }, body: "" }
            : { body: page("Home", `<a href="${origin}/next">next</a>`) },
    });
    sites.push(site);
    expect(site.origin).toBe(`http://127.0.0.1:${site.port}`);
    const home = await fetch(`${site.origin}/home?q=1`);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await home.text()).toBe(
      `<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><a href="${site.origin}/next">next</a></body></html>`,
    );
    expect((await fetch(`${site.origin}/robots.txt`)).headers.get("content-type")).toBe("text/plain");
    const moved = await fetch(`${site.origin}/moved`, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/home");
    expect(site.asked).toEqual(["/home?q=1", "/robots.txt", "/moved"]);
    expect(site.posted).toEqual([]);
  });

  it("answers a POST from its own function and records its path", async () => {
    const site = await startSite({
      answer: () => ({ status: 404, body: "no" }),
      post: () => ({ body: page("Submitted", "<p>Thanks.</p>") }),
    });
    sites.push(site);
    const submitted = await fetch(`${site.origin}/submit`, { method: "POST", body: "application=1" });
    expect(await submitted.text()).toContain("Thanks.");
    expect(site.posted).toEqual(["/submit"]);
    expect(site.asked).toEqual(["/submit"]);
  });
});
