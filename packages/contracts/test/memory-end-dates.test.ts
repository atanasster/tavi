import { describe, expect, it } from "vitest";

import { memoryEndDateField, memoryErasesAt, memoryProposalExpiresAt, memoryRecordIsPast, resolveMemoryValidUntil } from "../src/index.js";

/** A model-facing `validUntil`, mapped by kind. */
describe("validUntil", () => {
  const now = "2026-10-11T10:00:00.000Z";

  it("reads a date as through that day in the workspace's zone, and a date-time as written", () => {
    expect(resolveMemoryValidUntil("2026-10-16", now)).toEqual({ ok: true, at: "2026-10-17T00:00:00.000Z" });
    // Friday in Berlin (summer time, UTC+2) ends at 22:00 UTC.
    expect(resolveMemoryValidUntil("2026-10-16", now, "Europe/Berlin")).toEqual({ ok: true, at: "2026-10-16T22:00:00.000Z" });
    expect(resolveMemoryValidUntil("2026-10-16", now, "America/New_York")).toEqual({ ok: true, at: "2026-10-17T04:00:00.000Z" });
    // Across the autumn change: the next day's own offset counts (Berlin is UTC+1 from 25 Oct).
    expect(resolveMemoryValidUntil("2026-10-25", now, "Europe/Berlin")).toEqual({ ok: true, at: "2026-10-25T23:00:00.000Z" });
    expect(resolveMemoryValidUntil("2026-10-16T18:30:00+02:00", now)).toEqual({ ok: true, at: "2026-10-16T16:30:00.000Z" });
    // An unknown zone is UTC rather than a failure.
    expect(resolveMemoryValidUntil("2026-10-16", now, "Mars/Olympus")).toEqual({ ok: true, at: "2026-10-17T00:00:00.000Z" });
  });

  it("refuses a date in the past or today's start, more than five years ahead, or one that is not a date", () => {
    expect(resolveMemoryValidUntil("2026-10-01", now)).toMatchObject({ ok: false, reason: expect.stringMatching(/future/) });
    expect(resolveMemoryValidUntil("2026-10-11T09:00:00Z", now)).toMatchObject({ ok: false });
    expect(resolveMemoryValidUntil("2032-01-01", now)).toMatchObject({ ok: false, reason: expect.stringMatching(/5 years/) });
    expect(resolveMemoryValidUntil("next Friday", now)).toMatchObject({ ok: false });
    expect(resolveMemoryValidUntil("2026-02-30", now)).toMatchObject({ ok: false });
    // A date-time without its zone is ambiguous.
    expect(resolveMemoryValidUntil("2026-10-16T18:30:00", now)).toMatchObject({ ok: false });
  });

  it("puts a fact's end in validTo and a preference's or lesson's in expiryAt", () => {
    expect(memoryEndDateField("fact")).toBe("validTo");
    expect(memoryEndDateField("preference")).toBe("expiryAt");
    expect(memoryEndDateField("lesson")).toBe("expiryAt");
  });

  it("calls an ended fact, a lapsed expiry and an expired approved record past, never a lapsed proposal", () => {
    const at = "2026-10-20T00:00:00.000Z";
    expect(memoryRecordIsPast({ status: "approved", validTo: "2026-10-17T00:00:00.000Z" }, at)).toBe(true);
    expect(memoryRecordIsPast({ status: "approved", expiryAt: "2026-10-17T00:00:00.000Z" }, at)).toBe(true);
    expect(memoryRecordIsPast({ status: "approved", validTo: "2026-10-27T00:00:00.000Z" }, at)).toBe(false);
    expect(memoryRecordIsPast({ status: "expired", currentRevisionId: "memrev-1" }, at)).toBe(true);
    expect(memoryRecordIsPast({ status: "expired" }, at)).toBe(false);
    expect(memoryRecordIsPast({ status: "revoked", validTo: "2026-10-17T00:00:00.000Z" }, at)).toBe(false);
  });

  it("lapses a proposal at its own end date when that comes first, and erases an expired record a window after the mark", () => {
    const recordedAt = "2026-10-11T00:00:00.000Z";
    expect(memoryProposalExpiresAt({ recordedAt, validTo: "2026-10-17T00:00:00.000Z" }, 30)).toBe("2026-10-17T00:00:00.000Z");
    expect(memoryProposalExpiresAt({ recordedAt, expiryAt: "2026-10-15T00:00:00.000Z", validTo: "2026-10-17T00:00:00.000Z" }, 30)).toBe(
      "2026-10-15T00:00:00.000Z",
    );
    expect(memoryProposalExpiresAt({ recordedAt }, 30)).toBe("2026-11-10T00:00:00.000Z");
    expect(memoryErasesAt({ updatedAt: "2026-10-17T00:00:00.000Z" }, 30)).toBe("2026-11-16T00:00:00.000Z");
  });
});
