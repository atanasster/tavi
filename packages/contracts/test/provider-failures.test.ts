import { describe, expect, it } from "vitest";

import { TaviError } from "../src/errors.js";
import { modelOutcomeObservation, ProviderFailureLog, thrownProviderObservation } from "../src/provider-failures.js";

/** What a provider's failure says of the work that met it, shared by routines and schedules. */

describe("provider failures", () => {
  it("classes a rate limit and a retryable fault as transient, a rejected key as credentials, and nothing else", () => {
    expect(modelOutcomeObservation({ status: "completed" })).toBe("ok");
    expect(modelOutcomeObservation({ status: "failed", error: { code: "rate_limit", retryable: true } })).toBe("transient");
    expect(modelOutcomeObservation({ status: "failed", error: { code: "provider", retryable: true } })).toBe("transient");
    expect(modelOutcomeObservation({ status: "failed", error: { code: "provider", retryable: false } })).toBeUndefined();
    expect(modelOutcomeObservation({ status: "failed", error: { code: "quota_exceeded", retryable: false } })).toBeUndefined();
    expect(modelOutcomeObservation({ status: "failed", error: { code: "auth", retryable: false } })).toBe("credentials");
    expect(thrownProviderObservation(new TaviError("NOT_CONFIGURED", "no key"))).toBe("credentials");
    expect(thrownProviderObservation(new TaviError("MODEL_FAILED", "lost"))).toBeUndefined();
  });

  it("keeps a credential failure, clears a transient one a later success recovered, and forgets once read", () => {
    const log = new ProviderFailureLog();
    log.note("task-1", "model", "transient");
    log.note("task-1", "model", "ok");
    expect(log.take("task-1")).toBeUndefined();

    log.note("task-2", "model", "credentials");
    log.note("task-2", "model", "transient");
    log.note("task-2", "model", "ok");
    expect(log.take("task-2")).toBe("credentials");
    expect(log.take("task-2")).toBeUndefined();

    log.note("task-3", "model", "transient");
    expect(log.take("task-3")).toBe("transient");
  });

  it("remembers only work with a failure, and forgets the oldest past its bound", () => {
    const log = new ProviderFailureLog();
    log.note("fine", "model", "ok");
    for (let index = 0; index < 300; index += 1) log.note(`task-${index}`, "model", "transient");
    expect(log.take("task-0")).toBeUndefined();
    expect(log.take("task-299")).toBe("transient");
  });
});
