import {
  HeartbeatGetAnswerSchema,
  MemoryListAnswerSchema,
  OnboardingConnectAnswerSchema,
  OnboardingDetectAnswerSchema,
  OnboardingFlowAnswerSchema,
  OnboardingReachedAnswerSchema,
  OnboardingSignInAnswerSchema,
  OnboardingSignInStatusAnswerSchema,
  OnboardingStatusSchema,
  OnboardingVerifyAnswerSchema,
  type OnboardingConnectAnswer,
  type OnboardingDetectAnswer,
  type OnboardingEnvVariable,
  type OnboardingFlowAnswer,
  type OnboardingReachedAnswer,
  type OnboardingSignInAnswer,
  type OnboardingSignInStatusAnswer,
  type OnboardingStatus,
  type OnboardingStepKind,
  type OnboardingVerifyAnswer,
  type VoiceSetupStatus,
  type WebSearchKind,
  VoiceSetupStatusSchema,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, mapOutcome, read, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * The Welcome page's side of the owner's `onboarding` command. Every answer is read through the
 * contract's schema. A key goes to the owner once, in `connect-key` or the
 * credentials it already uses, and is never read back.
 */

const onboarding = <T>(
  client: SettingsClient,
  payload: Record<string, unknown>,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  timeoutMs?: number,
): Promise<Outcome<T>> => read(client, "onboarding", payload, schema, timeoutMs === undefined ? {} : { timeoutMs });

/** `surface`: whose order the steps come in; the terminal's has the service step the canvas leaves out. */
export const loadStatus = (
  client: SettingsClient,
  workspaceId: string,
  surface: "web" | "cli" = "web",
): Promise<Outcome<OnboardingStatus>> => onboarding(client, { action: "status", workspaceId, surface }, OnboardingStatusSchema);
export const loadFlow = (client: SettingsClient, workspaceId: string): Promise<Outcome<OnboardingFlowAnswer>> =>
  onboarding(client, { action: "flow", workspaceId, surface: "web" }, OnboardingFlowAnswerSchema);
export const detectProviders = (client: SettingsClient, workspaceId: string): Promise<Outcome<OnboardingDetectAnswer>> =>
  onboarding(client, { action: "detect", workspaceId }, OnboardingDetectAnswerSchema);

export const connectDetected = (
  client: SettingsClient,
  workspaceId: string,
  preset: string,
  variable?: OnboardingEnvVariable,
): Promise<Outcome<OnboardingConnectAnswer>> =>
  onboarding(
    client,
    { action: "connect-detected", workspaceId, preset, ...(variable === undefined ? {} : { variable }) },
    OnboardingConnectAnswerSchema,
    60_000,
  );

export const connectKey = (
  client: SettingsClient,
  workspaceId: string,
  preset: string,
  key: string,
  baseUrl?: string,
): Promise<Outcome<OnboardingConnectAnswer>> =>
  onboarding(
    client,
    { action: "connect-key", workspaceId, preset, key, ...(baseUrl === undefined ? {} : { baseUrl }) },
    OnboardingConnectAnswerSchema,
    60_000,
  );

export const startSignIn = (
  client: SettingsClient,
  workspaceId: string,
  callbackOrigin: string,
): Promise<Outcome<OnboardingSignInAnswer>> =>
  onboarding(client, { action: "sign-in", workspaceId, preset: "openrouter", callbackOrigin }, OnboardingSignInAnswerSchema);
/** Sign in with ChatGPT: the owner listens on its own loopback; the address to open, and its state for `signInStatus`. */
export const startChatGptSignIn = (client: SettingsClient, workspaceId: string): Promise<Outcome<OnboardingSignInAnswer>> =>
  onboarding(client, { action: "sign-in", workspaceId, preset: "chatgpt" }, OnboardingSignInAnswerSchema);
export const signInStatus = (client: SettingsClient, workspaceId: string, state: string): Promise<Outcome<OnboardingSignInStatusAnswer>> =>
  onboarding(client, { action: "sign-in-status", workspaceId, state }, OnboardingSignInStatusAnswerSchema);

/** Verify a connection and model for a role before it becomes it: the page sets the role only on a pass. */
export const verifyTarget = (
  client: SettingsClient,
  workspaceId: string,
  role: "main" | "fast",
  connectionId: string,
  model: string,
): Promise<Outcome<OnboardingVerifyAnswer>> =>
  onboarding(client, { action: "verify", workspaceId, role, target: { connectionId, model } }, OnboardingVerifyAnswerSchema, 60_000);

/** The funnel's "reached": Welcome showed the step. Nothing waits on it. */
export const reachedStep = (
  client: SettingsClient,
  workspaceId: string,
  step: OnboardingStepKind,
): Promise<Outcome<OnboardingReachedAnswer>> =>
  onboarding(client, { action: "reached", workspaceId, step, surface: "web" }, OnboardingReachedAnswerSchema);
export const skipStep = (client: SettingsClient, workspaceId: string, step: OnboardingStepKind): Promise<Outcome<OnboardingStatus>> =>
  onboarding(client, { action: "skip", workspaceId, step, surface: "web" }, OnboardingStatusSchema);
export const completeStep = (
  client: SettingsClient,
  workspaceId: string,
  step: "about" | "tasks" | "info",
): Promise<Outcome<OnboardingStatus>> =>
  onboarding(client, { action: "complete-step", workspaceId, step, surface: "web" }, OnboardingStatusSchema);
export const dismissOnboarding = (client: SettingsClient, workspaceId: string): Promise<Outcome<OnboardingStatus>> =>
  onboarding(client, { action: "dismiss", workspaceId, surface: "web" }, OnboardingStatusSchema);
export const completeOnboarding = (client: SettingsClient, workspaceId: string): Promise<Outcome<OnboardingStatus>> =>
  onboarding(client, { action: "complete", workspaceId, surface: "web" }, OnboardingStatusSchema);

/** The role's target set once it passed: `main` is the workspace default, `fast` its role. */
export async function setRole(
  client: SettingsClient,
  workspaceId: string,
  role: "main" | "fast",
  connectionId: string,
  model: string,
): Promise<Outcome<unknown>> {
  return role === "main"
    ? await ask(
        client,
        "models",
        { action: "set-default", workspaceId, connectionId, model },
        { refused: translateNow("welcome.roles.defaultRefused") },
      )
    : await ask(
        client,
        "models",
        { action: "set-role", workspaceId, role: "fast", connectionId, model },
        { refused: translateNow("welcome.roles.fastRefused") },
      );
}

// ------------------------------------------------------------------ voice messages

/** What voice messages need here and the setup job's progress (`models voice-status`). */
export const loadVoice = (client: SettingsClient): Promise<Outcome<VoiceSetupStatus>> =>
  read(client, "models", { action: "voice-status" }, VoiceSetupStatusSchema, { timeoutMs: 30_000 });

/** Starts the owner's one setup job (Homebrew, the pinned model, `analyzers.json`); answers at once. */
export const startVoiceSetup = (client: SettingsClient): Promise<Outcome<VoiceSetupStatus>> =>
  read(client, "models", { action: "voice-setup" }, VoiceSetupStatusSchema, { timeoutMs: 30_000 });

// ------------------------------------------------------------------ about you

export interface AboutValues {
  readonly name?: string;
  readonly timezone?: string;
  readonly activeHours?: { readonly start: string; readonly end: string };
  /** Also as approved personal preferences (the untick option). */
  readonly remember: boolean;
}

/** A preference in the operator's personal scope: a new one, or the one held corrected (no `MEMORY_CONFLICT`); unchanged, nothing. */
async function rememberPreference(
  client: SettingsClient,
  workspaceId: string,
  key: "user.name" | "user.timezone",
  title: string,
  value: string,
): Promise<Outcome<unknown>> {
  const listed = await read(
    client,
    "memory",
    { action: "list", workspaceId, kinds: ["preference"], scopes: ["personal"] },
    MemoryListAnswerSchema,
  );
  if (!listed.ok) return listed;
  const held = listed.value.records.find(
    (record) => record.preferenceKey === key && (record.status === "approved" || record.status === "proposed"),
  );
  const body = `${title}: ${value}`;
  if (held !== undefined && held.status === "approved" && held.body === body) return { ok: true, value: undefined };
  return held === undefined
    ? await ask(
        client,
        "memory",
        { action: "remember", workspaceId, kind: "preference", scope: "personal", title, body, preferenceKey: key, preferenceValue: value },
        { refused: translateNow("welcome.about.memoryRefused") },
      )
    : await ask(
        client,
        "memory",
        { action: "correct", workspaceId, recordId: held.recordId, preferenceValue: value, body },
        { refused: translateNow("welcome.about.memoryRefused") },
      );
}

/**
 * The about step's writes: `operator.name` and the time zone in
 * workspace settings (the zone only when it differs from the host's), active
 * hours on the heartbeat while it is on, and — when the person left it ticked
 * and memory is on — the two preferences. Marked done after. What memory did
 * not take is said, and the settings stay saved.
 */
export async function saveAbout(
  client: SettingsClient,
  workspaceId: string,
  values: AboutValues,
  current: { readonly operatorName?: string; readonly timezone: string; readonly memoryOn: boolean },
): Promise<Outcome<string | undefined>> {
  if (values.name !== undefined && values.name !== current.operatorName) {
    const saved = await ask(
      client,
      "workspace-settings",
      { action: "set", workspaceId, key: "operatorName", value: values.name },
      { refused: translateNow("welcome.about.nameRefused") },
    );
    if (!saved.ok) return saved;
  }
  if (values.timezone !== undefined && values.timezone !== current.timezone) {
    const saved = await ask(
      client,
      "workspace-settings",
      { action: "set", workspaceId, key: "timezone", value: values.timezone },
      { refused: translateNow("welcome.about.zoneRefused") },
    );
    if (!saved.ok) return saved;
  }
  if (values.activeHours !== undefined) {
    const heartbeat = await read(client, "heartbeat", { action: "get", workspaceId }, HeartbeatGetAnswerSchema);
    if (heartbeat.ok && heartbeat.value.config.enabled) {
      const saved = await ask(
        client,
        "heartbeat",
        { action: "set", workspaceId, revision: heartbeat.value.revision, changes: { activeHours: values.activeHours } },
        { refused: translateNow("welcome.about.hoursRefused") },
      );
      if (!saved.ok) return saved;
    }
  }
  let note: string | undefined;
  if (values.remember && current.memoryOn) {
    for (const [key, title, value] of [
      ["user.name", "Name", values.name],
      ["user.timezone", "Time zone", values.timezone],
    ] as const) {
      if (value === undefined) continue;
      const remembered = await rememberPreference(client, workspaceId, key, title, value);
      if (!remembered.ok) note = translateNow("welcome.about.memoryNote", { message: remembered.message });
    }
  }
  const done = await completeStep(client, workspaceId, "about");
  return mapOutcome(done, () => note);
}

// ------------------------------------------------------------------ web search

/**
 * A provider added, keyed and enabled through `search` and `credentials` (the
 * search step), then tested. `madeHere` is the step's memory of having added
 * it: a retry (a wrong key, say) keys and tests that provider again rather
 * than adding a second, and a provider of the kind this step did not add is
 * left alone, as is a key stored under its name for something else. The
 * provider is added before its key is stored, so a refused add stores nothing.
 * One it added keyless and is now given a key (Tavily's is optional), or the
 * other way round, is removed and added again, since its row names its key;
 * a key this step stored is its own, so it is not taken for another's.
 */
export async function addSearchProvider(
  client: SettingsClient,
  kind: WebSearchKind,
  key: string | undefined,
  baseUrl: string | undefined,
  madeHere: { added: boolean; keyed?: boolean; keyStored?: boolean },
): Promise<Outcome<unknown>> {
  const credentialRef = key === undefined ? undefined : `search.${kind}`;
  const listed = await ask<{ readonly providers: readonly { readonly providerId: string }[]; readonly unreadable?: readonly string[] }>(
    client,
    "search",
    { action: "list" },
  );
  if (!listed.ok) return listed;
  const exists = [...listed.value.providers.map((provider) => provider.providerId), ...(listed.value.unreadable ?? [])].includes(kind);
  if (exists && !madeHere.added) return { ok: false, message: translateNow("welcome.search.exists", { kind }) };
  let present = exists;
  if (present && madeHere.keyed !== (credentialRef !== undefined)) {
    const removed = await ask(
      client,
      "search",
      { action: "remove", providerId: kind },
      { refused: translateNow("welcome.search.notChanged") },
    );
    if (!removed.ok) return removed;
    madeHere.added = false;
    present = false;
  }
  if (!present) {
    if (credentialRef !== undefined && madeHere.keyStored !== true) {
      const stored = await ask<{ readonly credentials: readonly string[] }>(client, "credentials", { action: "list" });
      if (!stored.ok) return stored;
      if (stored.value.credentials.includes(credentialRef))
        return {
          ok: false,
          message: translateNow("welcome.search.credentialTaken", { credential: credentialRef }),
        };
    }
    const added = await ask(
      client,
      "search",
      {
        action: "add",
        providerId: kind,
        kind,
        ...(credentialRef === undefined ? {} : { credentialRef }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      },
      { refused: translateNow("welcome.search.notAdded") },
    );
    if (!added.ok) return added;
    madeHere.added = true;
    madeHere.keyed = credentialRef !== undefined;
  }
  if (credentialRef !== undefined && key !== undefined) {
    const stored = await ask(
      client,
      "credentials",
      { action: "set", reference: credentialRef, value: key },
      { refused: translateNow("welcome.search.keyNotStored") },
    );
    if (!stored.ok) return stored;
    madeHere.keyStored = true;
  }
  const enabled = await ask(
    client,
    "search",
    { action: "enable", providerId: kind },
    { refused: translateNow("welcome.search.notEnabled") },
  );
  if (!enabled.ok) return enabled;
  return await ask(
    client,
    "search",
    { action: "test", providerId: kind },
    { refused: translateNow("welcome.search.noAnswer"), timeoutMs: 30_000 },
  );
}

/** Once per browser session, the page opens Welcome for a first run; remembered in `sessionStorage`, which may be unavailable. */
export const WELCOME_REDIRECT_KEY = "tavi.welcome.redirected";
export function redirectedThisSession(storage: Pick<Storage, "getItem" | "setItem"> | undefined): boolean {
  try {
    if (storage?.getItem(WELCOME_REDIRECT_KEY) === "1") return true;
    storage?.setItem(WELCOME_REDIRECT_KEY, "1");
  } catch {
    // Storage refused (a private window): the redirect can come once per load instead.
  }
  return false;
}

/**
 * Something setup counts may have changed on this page (an app connected, a
 * sheet closed): Home's checklist reads its status again. A window
 * event, so the page that changed it needs no line to the card.
 */
export const ONBOARDING_CHANGED_EVENT = "tavi:onboarding-changed";
export function announceOnboardingChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ONBOARDING_CHANGED_EVENT));
}
