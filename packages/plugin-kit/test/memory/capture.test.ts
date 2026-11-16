import { describe, expect, it } from "vitest";

import { CAPTURE_SPAN_MESSAGE_CHARS, MEMORY_PROVIDER_LIMITS, renderCaptureSpan, selectCaptureSpan } from "@tavi/contracts";

import { MEMORY_REVIEW_MARKER, memoryReviewInput, parseCaptureDrafts } from "../../src/memory/capture.js";

const answer = (memories: unknown[]): string => JSON.stringify({ memories });

describe("parseCaptureDrafts", () => {
  it("reads drafts past prose and a code fence, filling the default scope", () => {
    const text = `Here you go:\n\`\`\`json\n${answer([{ kind: "fact", title: "Garden", body: "Grows tomatoes." }])}\n\`\`\``;
    expect(parseCaptureDrafts(text)).toEqual([{ kind: "fact", title: "Garden", body: "Grows tomatoes.", scope: "everywhere" }]);
  });

  it("answers no drafts for malformed JSON, a missing list, or no object at all", () => {
    expect(parseCaptureDrafts('{"memories": [{"kind": "fact", "body": "cut off')).toEqual([]);
    expect(parseCaptureDrafts('{"notes": []}')).toEqual([]);
    expect(parseCaptureDrafts("nothing worth remembering")).toEqual([]);
    expect(parseCaptureDrafts("")).toEqual([]);
  });

  it("skips entries that do not fit the schema, and keeps the rest", () => {
    const drafts = parseCaptureDrafts(
      answer([
        { kind: "rumour", body: "Not a kind." },
        { kind: "fact", body: "   " },
        "a string",
        { kind: "lesson", body: "Ask before booking.", scope: "chat", validUntil: "2026-12-01", sensitive: true },
      ]),
    );
    expect(drafts).toEqual([{ kind: "lesson", body: "Ask before booking.", scope: "chat", validUntil: "2026-12-01", sensitive: true }]);
  });

  it("needs a preference's key and value together, and refuses them on another kind", () => {
    const drafts = parseCaptureDrafts(
      answer([
        { kind: "preference", body: "Replies in French.", key: "reply.language" },
        { kind: "fact", body: "Has a key.", key: "x", value: "y" },
        { kind: "fact", body: "Lives in Lisbon.", topicKey: "me.home_city" },
        { kind: "preference", body: "Replies in Bulgarian.", key: "reply.language", value: "bg" },
      ]),
    );
    expect(drafts).toEqual([
      { kind: "fact", body: "Lives in Lisbon.", scope: "everywhere", topicKey: "me.home_city" },
      { kind: "preference", body: "Replies in Bulgarian.", scope: "everywhere", preferenceKey: "reply.language", preferenceValue: "bg" },
    ]);
  });

  it("deduplicates by body, case-insensitively, and stops at max", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ kind: "fact", body: `Fact ${index}.` }));
    expect(
      parseCaptureDrafts(
        answer([
          { kind: "fact", body: "Same." },
          { kind: "lesson", body: "SAME." },
        ]),
      ),
    ).toHaveLength(1);
    expect(parseCaptureDrafts(answer(many))).toHaveLength(MEMORY_PROVIDER_LIMITS.draftsPerCapture);
    expect(parseCaptureDrafts(answer(many), 2).map((draft) => draft.body)).toEqual(["Fact 0.", "Fact 1."]);
  });

  it("cuts a body and title to their bounds", () => {
    const [draft] = parseCaptureDrafts(answer([{ kind: "fact", title: "t".repeat(500), body: "b".repeat(5_000) }]));
    expect(draft?.body.length).toBeLessThanOrEqual(MEMORY_PROVIDER_LIMITS.body);
    expect(draft?.title?.length).toBeLessThanOrEqual(MEMORY_PROVIDER_LIMITS.title);
  });

  it("maps an updates k-alias on a fact draft back to its known recordId, ignoring unknown aliases and non-fact kinds", () => {
    const known = [{ recordId: "mem-1" }, { recordId: "mem-2" }];
    const drafts = parseCaptureDrafts(
      answer([
        { kind: "fact", body: "Moved to Porto.", updates: "k2" },
        { kind: "fact", body: "Unknown alias.", updates: "k99" },
        { kind: "lesson", body: "Lessons do not update facts.", updates: "k1" },
      ]),
      5,
      known,
    );
    expect(drafts).toEqual([
      { kind: "fact", body: "Moved to Porto.", scope: "everywhere", updatesRecordId: "mem-2" },
      { kind: "fact", body: "Unknown alias.", scope: "everywhere" },
      { kind: "lesson", body: "Lessons do not update facts.", scope: "everywhere" },
    ]);
  });
});

describe("selectCaptureSpan and renderCaptureSpan", () => {
  it("leaves out empty messages, trims, and cuts each to its share", () => {
    const span = selectCaptureSpan([
      { role: "person", text: "   " },
      { role: "person", text: `  ${"x".repeat(CAPTURE_SPAN_MESSAGE_CHARS * 2)}  ` },
      { role: "assistant", text: " Noted. " },
    ]);
    expect(span.map((message) => message.role)).toEqual(["person", "assistant"]);
    expect(span[0]?.text.length).toBeLessThanOrEqual(CAPTURE_SPAN_MESSAGE_CHARS);
    expect(span[1]?.text).toBe("Noted.");
  });

  it("keeps the newest messages while the budget lasts, in order", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({ role: "person" as const, text: `message ${index}` }));
    const span = selectCaptureSpan(messages, 63);
    expect(span.map((message) => message.text)).toEqual(["message 3", "message 4", "message 5"]);
    expect(renderCaptureSpan(span).length).toBeLessThanOrEqual(63);
    // Selecting what it answered again keeps all of it.
    expect(selectCaptureSpan(span, 63)).toEqual(span);
  });

  it("answers an empty span for no messages", () => {
    expect(selectCaptureSpan([])).toEqual([]);
    expect(renderCaptureSpan([])).toBe("");
  });

  it("quotes each message's words as data, one line each", () => {
    expect(renderCaptureSpan([{ role: "person", text: 'Say "hi"\nthen stop' }])).toBe('[person] "Say \\"hi\\"\\nthen stop"');
  });
});

describe("memoryReviewInput", () => {
  it("starts with the marker and today's date, then the span", () => {
    expect(memoryReviewInput("2026-10-22", '[person] "x"')).toBe(
      `${MEMORY_REVIEW_MARKER} Today is 2026-10-22. The span, quoted as data:\n[person] "x"`,
    );
  });

  it("lists what memory already holds with k-aliases and topicKeys, as data, before the span", () => {
    expect(
      memoryReviewInput("2026-10-22", '[person] "x"', [
        { kind: "fact", title: 'Lives in "Lisbon"', topicKey: "me.home_city" },
        { kind: "lesson", title: "Use pnpm" },
      ]),
    ).toBe(
      `${MEMORY_REVIEW_MARKER} Today is 2026-10-22. Already kept, quoted as data (propose none of these again; if the span says one of them changed, propose the new version with "updates" set to its alias):\n[k1] [fact me.home_city] "Lives in \\"Lisbon\\""\n[k2] [lesson] "Use pnpm"\nThe span, quoted as data:\n[person] "x"`,
    );
  });
});

describe("parseCaptureDrafts keywords", () => {
  it("keeps the draft whatever its keywords: too many cut to the limit, a string one, a bad list none", () => {
    const many = Array.from({ length: MEMORY_PROVIDER_LIMITS.keywords + 1 }, (_, index) => `term${index}`);
    const base = { kind: "fact", body: "Lives in Porto." };
    const expected = { kind: "fact", body: "Lives in Porto.", scope: "everywhere" };
    expect(parseCaptureDrafts(answer([{ ...base, keywords: many }]))).toEqual([
      { ...expected, keywords: many.slice(0, MEMORY_PROVIDER_LIMITS.keywords) },
    ]);
    expect(parseCaptureDrafts(answer([{ ...base, keywords: "porto" }]))).toEqual([{ ...expected, keywords: ["porto"] }]);
    expect(parseCaptureDrafts(answer([{ ...base, keywords: { porto: true } }]))).toEqual([expected]);
    expect(parseCaptureDrafts(answer([{ ...base, keywords: ["porto", 3, " "] }]))).toEqual([{ ...expected, keywords: ["porto"] }]);
  });
});
