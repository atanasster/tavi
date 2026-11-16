import {
  TaviError,
  isRefusedEarly,
  refusedEarly,
  type AgentWaitOutcome,
  type MessagingConnectionRecord,
  type ToolQuestion,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { signInLapse } from "../../src/features/apps/account-tools.js";

/** A channel account's call that meets its sign-in. */

const NOW = "2026-11-11T09:00:00.000Z";
const record = (authState: MessagingConnectionRecord["authState"], accountIdentity: string): MessagingConnectionRecord => ({
  connectionId: "gmail-1",
  providerId: "gmail",
  workspaceId: "default",
  accountIdentity,
  settings: {},
  credentialRefs: { oauth: "channels.gmail-1.oauth" },
  enabled: true,
  configRevision: 1,
  authState,
  createdAt: NOW,
  updatedAt: NOW,
});
const lapsed = signInLapse({ providerId: "gmail", label: "Google" }, (account) => `${account.accountIdentity}'s sign-in expired`);
const notConnected = refusedEarly("NOT_CONFIGURED", "Gmail is not connected", { signIn: true });

describe("a call that meets its account's sign-in", () => {
  it("asks an account never signed in for its first sign-in, by the app's name, and ends in Tavi's words (QA 2090, 2091)", async () => {
    const asked: ToolQuestion[] = [];
    const ask = async (question: ToolQuestion): Promise<AgentWaitOutcome> => {
      asked.push(question);
      return { kind: "answered", connect: { outcome: "declined" } };
    };
    const error = await lapsed(record("none", "Gmail"), notConnected, undefined, ask).catch((thrown: unknown) => thrown);
    expect(asked[0]?.connect).toMatchObject({ appName: "Google", reason: "", health: "not-set-up" });
    expect(isRefusedEarly(error)).toBe(true);
    expect(error).toMatchObject({ message: "Google is not signed in: the person chose not to sign in to Google now." });
  });

  it("asks an account that was signed in to sign in again, with why", async () => {
    const asked: ToolQuestion[] = [];
    const ask = async (question: ToolQuestion): Promise<AgentWaitOutcome> => {
      asked.push(question);
      return { kind: "wait-timeout" };
    };
    await lapsed(record("expired", "me@gmail.com"), notConnected, undefined, ask).catch(() => undefined);
    expect(asked[0]?.connect).toMatchObject({ reason: "me@gmail.com's sign-in expired", health: "needs-sign-in" });
  });

  it("keeps a refusal made before reaching the provider as Tavi's words where it shows the Connect card, and no other", async () => {
    const attended = { humanQuestionsAllowed: true, mode: "interactive" } as never;
    const early = await lapsed(record("none", "Gmail"), notConnected, attended).catch((thrown: unknown) => thrown);
    expect(early).toMatchObject({ code: "NOT_AUTHORIZED", details: { connectCard: true, signIn: true } });
    expect(isRefusedEarly(early)).toBe(true);
    const refused = new TaviError("NOT_AUTHORIZED", "Gmail refused its sign-in (HTTP 401)", { details: { signIn: true } });
    const late = await lapsed(record("connected", "me@gmail.com"), refused, attended).catch((thrown: unknown) => thrown);
    expect(late).toMatchObject({ code: "NOT_AUTHORIZED", details: { connectCard: true } });
    expect(isRefusedEarly(late)).toBe(false);
  });
});
