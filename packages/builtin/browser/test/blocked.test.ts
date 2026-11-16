import { describe, expect, it } from "vitest";

import { classifyPage, type PageSignals } from "../src/blocked.js";

const page = (overrides: Partial<PageSignals>): PageSignals => ({
  url: "https://example.com/",
  text: "",
  frames: [],
  password: false,
  ...overrides,
});

describe("classifyPage", () => {
  it("names the walls the Sofia–Tampa run met", () => {
    expect(classifyPage(page({ url: "https://www.skyscanner.net/sttc/px/captcha-v2/index.html?url=Lw==" }))?.kind).toBe("captcha");
    expect(classifyPage(page({ url: "https://www.kayak.com/help/bots.html", title: "What is a bot?" }))?.kind).toBe("bot-wall");
    expect(classifyPage(page({ url: "https://consent.google.com/ml?continue=https://www.google.com/travel/flights&gl=BG" }))?.kind).toBe(
      "consent",
    );
    expect(classifyPage(page({ url: "https://www.google.com/sorry/index?continue=x" }))?.kind).toBe("rate-limit");
  });

  it("names challenges by their text, frames, title and status", () => {
    expect(classifyPage(page({ text: "Press & Hold to confirm you are a human (and not a bot)." }))?.kind).toBe("captcha");
    expect(classifyPage(page({ title: "Just a moment..." }))?.detail).toBe("Cloudflare's browser check");
    expect(
      classifyPage(page({ text: "Please complete the check", frames: ["https://www.google.com/recaptcha/api2/anchor?k=x"] }))?.kind,
    ).toBe("captcha");
    expect(classifyPage(page({ status: 429, text: "Slow down" }))?.kind).toBe("rate-limit");
    expect(classifyPage(page({ url: "https://tickets.queue-it.net/?c=event", text: "Please wait" }))).toEqual({
      kind: "rate-limit",
      detail: "a virtual waiting room",
    });
    expect(classifyPage(page({ text: "You are now in line. Your estimated wait time is 4 minutes." }))).toEqual({
      kind: "rate-limit",
      detail: "a virtual waiting room",
    });
    expect(classifyPage(page({ status: 200, text: "Rate limit exceeded. Please try again in a few minutes." }))).toEqual({
      kind: "rate-limit",
      detail: "a rate-limit page",
    });
    expect(classifyPage(page({ status: 503, text: "You are rate limited. Please try again in a few minutes." }))?.kind).toBe("rate-limit");
    // A short page of API docs that explains rate limits is no wall.
    expect(classifyPage(page({ status: 200, text: "API reference. Each key has a rate limit of 60 calls a minute." }))).toBeUndefined();
    expect(classifyPage(page({ status: 403, text: "Forbidden" }))?.kind).toBe("bot-wall");
    expect(classifyPage(page({ text: "Our systems have detected unusual traffic from your computer network." }))?.kind).toBe("bot-wall");
    expect(classifyPage(page({ url: "https://github.com/login", password: true }))?.kind).toBe("login");
    expect(classifyPage(page({ url: "https://accounts.google.com/v3/signin/identifier", password: true }))?.kind).toBe("login");
    expect(classifyPage(page({ url: "https://gitlab.com/users/sign_in", password: true }))?.kind).toBe("login");
  });

  it("leaves a page that only talks about them alone", () => {
    const article = `How CAPTCHAs work. Are you a robot? Sites ask to verify you are human. ${"Long article text. ".repeat(100)}`;
    expect(classifyPage(page({ text: article, frames: ["https://www.google.com/recaptcha/api2/anchor"] }))).toBeUndefined();
    expect(classifyPage(page({ url: "https://news.example/story", password: true }))).toBeUndefined();
    // A signed-in account's settings with a change-password field is not a sign-in wall.
    expect(classifyPage(page({ url: "https://shop.example/account/security", password: true }))).toBeUndefined();
    expect(classifyPage(page({ url: "https://example.com/oauth/authorize", password: true }))).toBeUndefined();
    expect(classifyPage(page({ status: 403, text: article }))).toBeUndefined();
    expect(classifyPage(page({ url: "not a url", text: "Flights from 802 EUR" }))).toBeUndefined();
  });
});
