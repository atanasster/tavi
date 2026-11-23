import { CLOUD_PROVIDERS, rhumbKeyOf, rhumbProviderOf } from "../models/rhumb-client.js";
import {
  keyPageOf,
  LOCAL_NO_KEY_CREDENTIAL,
  MODEL_PROVIDER_PRESETS,
  TaviError,
  WEB_SEARCH_KINDS,
  fastModelFailureIn,
  onboardingStepDetail,
  normaliseBaseUrl,
  onboardingEnvPreset,
  type ChannelDescriptor,
  type ModelProviderPreset,
  type OnboardingConnectAnswer,
  type OnboardingDetectAnswer,
  type OnboardingEnvVariable,
  type OnboardingFlowAnswer,
  type OnboardingFlowStep,
  type OnboardingStatus,
  type OnboardingStepKind,
  type OnboardingSurface,
  type OnboardingVerifyAnswer,
  suggestRoles,
  SERVICE_SETUP_COMMAND,
  modelUnverified,
  RHUMB_CREDENTIAL_REF,
  type ModelLifecycle,
  lifecycleByModel,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";
import { sleep } from "@tavi/node-kit";

import { detect } from "./detect.js";
import {
  addSearch,
  addChannel,
  aboutStep,
  channelCatalog,
  channelSecretFields,
  searchNeedsKey,
  channelsStep,
  ideasStep,
  languageStep,
  parseActiveHours,
  saveAbout,
  searchStep,
  tasksStep,
  serviceStep,
  voiceStep,
  type StepContext,
  type StepSystem,
} from "./steps.js";
import { OnboardCancelled, type ChoiceOption, type Prompter } from "./prompter.js";
import type { ChannelSecretFile } from "./parse.js";
import type { OnboardTransport } from "./transport.js";
import { GLYPHS } from "../../tui/theme.js";

/**
 * `tavi onboard` and `tavi setup`:
 * `onboard` walks only the open steps, in the flow's terminal order; `setup`
 * walks every step (or one), showing what is set and keeping it on Enter.
 * Every write is an existing command through the transport; a key comes
 * from a hidden prompt, a file, standard input or this process's own
 * environment, and never from argv.
 */

/** Exit codes: no required step open, one open, an owner needed, cancelled. */
export const ONBOARD_EXIT = { ok: 0, usage: 2, open: 3, unavailable: 4, cancelled: 130 } as const;

/** What `tavi setup --non-interactive` was given; a secret only as a path or standard input. */
interface HeadlessModel {
  readonly preset: string;
  /** `--preset` was given (absent, the model step runs only for a key or model flag). */
  readonly presetGiven?: boolean;
  readonly name?: string;
  readonly timezone?: string;
  readonly activeHours?: string;
  readonly search?: string;
  readonly searchKeyFile?: string;
  /** SearXNG's address: it takes no key. */
  readonly searchUrl?: string;
  /** `--channel-secret`: each a channel's secret field, read from a file. */
  readonly channelSecrets?: readonly ChannelSecretFile[];
  readonly keyFile?: string;
  readonly keyStdin?: boolean;
  readonly model?: string;
  readonly fastModel?: string;
  /** `--preset custom`'s OpenAI-compatible endpoint. */
  readonly baseUrl?: string;
}

export interface OnboardRun {
  readonly mode: "onboard" | "setup";
  readonly workspaceId: string;
  /** `tavi setup <step>`: that step alone, done or not. */
  readonly step?: OnboardingStepKind;
  /** Only these steps, in their order (tests walk one step without the rest). */
  readonly only?: readonly OnboardingStepKind[];
  readonly headless?: HeadlessModel;
  readonly json?: boolean;
}

export interface OnboardDependencies {
  readonly transport: OnboardTransport;
  readonly prompter: Prompter;
  /** This process's environment: detection reads names here, and a chosen key's value. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch;
  readonly readFile: (path: string) => Promise<string>;
  readonly readStdin: () => Promise<string>;
  /** Waits out the owner's verify gate (5 s) before a retry. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The platform, paths and user-scope commands the service step uses; the pairing wait. */
  readonly system: StepSystem;
  /** Sign in with OpenRouter in this process: the key it mints, stored as a typed one. */
  readonly signInWithOpenRouter?: () => Promise<string>;
  /** Sign in with ChatGPT in this process: the token record, as JSON, stored by the owner as the connection's credential. */
  readonly signInWithChatGpt?: () => Promise<string>;
}

class StepOpen extends Error {
  readonly flag: string;
  constructor(message: string, flag: string) {
    super(message);
    this.flag = flag;
  }
}

const preset = (id: string): ModelProviderPreset | undefined => MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === id);

/** The words the prompter speaks now: the workspace's language once it is known, English until then. */
const wordsOf = (deps: Pick<OnboardDependencies, "prompter">): CoreT => deps.prompter.words?.() ?? coreEnglish;

/** One line of a step's state, as the checklist and `tavi setup` show it. */
export function stepLine(step: OnboardingStatus["steps"][number], t: CoreT = coreEnglish): string {
  const mark =
    step.state === "done"
      ? GLYPHS.done
      : step.state === "unavailable"
        ? GLYPHS.unavailable
        : step.state === "skipped"
          ? GLYPHS.skipped
          : GLYPHS.todo;
  // The flow's own title, as Welcome and the Home card name it; one done elsewhere says where, on a line of its own
  // under the step, so a row with a command still fits a 100-column terminal.
  const label = step.title ?? t(STEP_LABELS[step.kind]);
  const command = STEP_COMMANDS[step.kind];
  const where =
    step.elsewhere === undefined || step.state === "done" || step.state === "unavailable"
      ? ""
      : command === ""
        ? `\n  ${t(ELSEWHERE_PLACE[step.elsewhere])}`
        : `\n  ${t(ELSEWHERE_WORDS[step.elsewhere], { command })}`;
  const detail = onboardingStepDetail(step, t);
  const note =
    step.state === "blocked"
      ? t("cli.onboard.afterModel")
      : step.state === "skipped"
        ? detail === ""
          ? t("cli.onboard.skipped")
          : t("cli.onboard.skippedDetail", { detail })
        : detail;
  return `${mark} ${label}${note === "" ? "" : ` — ${note}`}${where}`;
}

/** Where a step this surface does not do is done. */
const ELSEWHERE_WORDS: Readonly<Record<OnboardingSurface, CoreKey>> = {
  web: "cli.onboard.elsewhere.webCommand",
  cli: "cli.onboard.elsewhere.cliCommand",
};
const ELSEWHERE_PLACE: Readonly<Record<OnboardingSurface, CoreKey>> = {
  web: "cli.onboard.elsewhere.web",
  cli: "cli.onboard.elsewhere.cli",
};

/** "2 of 6 done": the steps that apply here, done ones counted the same on every surface. */
export function checklistCount(status: OnboardingStatus, t: CoreT = coreEnglish): string {
  const applying = status.steps.filter((step) => step.state !== "unavailable");
  const done = applying.filter((step) => step.state === "done").length;
  return t("cli.onboard.count", { done: String(done), total: String(applying.length) });
}

const STEP_LABELS: Readonly<Record<OnboardingStepKind, CoreKey>> = {
  model: "cli.onboard.step.model",
  about: "cli.onboard.step.about",
  search: "cli.onboard.step.search",
  apps: "cli.onboard.step.apps",
  tasks: "cli.onboard.step.tasks",
  channels: "cli.onboard.step.channels",
  voice: "cli.onboard.step.voice",
  service: "cli.onboard.step.service",
  ideas: "cli.onboard.step.ideas",
  info: "cli.onboard.step.info",
};

/** The command that does each step by hand, for a step this terminal flow does not walk yet, or one deferred. */
const STEP_COMMANDS: Readonly<Record<OnboardingStepKind, string>> = {
  model: "tavi models add <id> --base-url <url> --credential <ref>",
  about: 'tavi config set operator.name "<your name>"',
  search: "tavi search add <id> --kind <kind>",
  apps: "tavi apps connect <app>",
  tasks: "tavi config set tasks.home tavi",
  channels: "tavi channels add <kind>",
  voice: "tavi setup voice",
  service: SERVICE_SETUP_COMMAND,
  ideas: "tavi ideas",
  info: "",
};

const status = async (deps: OnboardDependencies, workspaceId: string): Promise<OnboardingStatus> =>
  await deps.transport.request<OnboardingStatus>("onboarding", { action: "status", workspaceId, surface: "cli" });

// ------------------------------------------------------------------ the model step

interface ModelChoice {
  readonly preset: ModelProviderPreset;
  /** A detected env variable the key comes from. */
  readonly variable?: OnboardingEnvVariable;
  /** Custom's endpoint. */
  readonly baseUrl?: string;
}

async function chooseProvider(
  deps: OnboardDependencies,
  flowStep: OnboardingFlowStep | undefined,
  detected: OnboardingDetectAnswer,
  chatGptOffered: boolean,
): Promise<ModelChoice | "chatgpt"> {
  const t = wordsOf(deps);
  const options: ChoiceOption[] = [];
  for (const variable of detected.env) {
    const presetId = onboardingEnvPreset(variable);
    const found = preset(presetId);
    if (found !== undefined)
      options.push({
        value: `env:${variable}`,
        label: t("cli.onboard.ask.envKey", { variable }),
        hint: t("cli.onboard.ask.envKeyHint", { provider: found.name }),
      });
  }
  for (const local of detected.local) {
    const found = preset(local.preset);
    if (found !== undefined && local.toolCapableModels > 0)
      options.push({
        value: `local:${local.preset}`,
        label: t("cli.onboard.ask.localRunning", { provider: found.name, n: String(local.models), count: local.models }),
        hint: t("cli.onboard.ask.localHint"),
      });
  }
  const featured = (flowStep?.featured ?? ["openrouter", "ollama", "anthropic", "openai"]).filter(
    (id) => !options.some((option) => option.value === `local:${id}`),
  );
  for (const id of featured) {
    const found = preset(id);
    if (found === undefined) continue;
    options.push({
      value: id,
      label: flowStep?.recommended === id ? t("cli.onboard.ask.recommended", { provider: found.name }) : found.name,
      hint: t(found.localOnly ? "cli.onboard.ask.localNoKey" : "cli.onboard.ask.billed"),
    });
  }
  options.push({ value: "more", label: t("cli.onboard.ask.anotherProvider") });
  // Sign in with ChatGPT, a preview: offered when the owner (or this process, offline) offers it, as the canvas is.
  // Last, so the numbers above stay.
  if (chatGptOffered && deps.signInWithChatGpt !== undefined)
    options.push({ value: "chatgpt", label: t("cli.onboard.ask.chatGpt"), hint: t("cli.onboard.ask.chatGptHint") });
  const recommended = flowStep?.recommended;
  const picked = await deps.prompter.choose({
    label: t("cli.onboard.ask.provider"),
    options,
    default:
      (recommended !== undefined && options.some((option) => option.value === recommended) ? recommended : undefined) ??
      options[0]?.value ??
      "more",
  });
  if (picked.startsWith("env:")) {
    const variable = picked.slice(4) as OnboardingEnvVariable;
    return { preset: preset(onboardingEnvPreset(variable)) as ModelProviderPreset, variable };
  }
  if (picked.startsWith("local:")) return { preset: preset(picked.slice(6)) as ModelProviderPreset };
  if (picked === "chatgpt") return "chatgpt";
  if (picked !== "more") return { preset: preset(picked) as ModelProviderPreset };
  const other = await deps.prompter.choose({
    label: t("cli.onboard.ask.whichOne"),
    options: MODEL_PROVIDER_PRESETS.map((candidate) => ({
      value: candidate.id,
      label: candidate.name,
      ...(candidate.note === undefined ? {} : { hint: candidate.note }),
    })),
  });
  const chosen = preset(other) as ModelProviderPreset;
  if (chosen.baseUrl !== "") return { preset: chosen };
  const baseUrl = await deps.prompter.text({
    label: t("cli.onboard.ask.baseUrl"),
    check: (value) => (/^https?:\/\/\S+$/u.test(value) ? undefined : t("cli.onboard.ask.baseUrlWrong")),
  });
  return { preset: chosen, baseUrl };
}

/**
 * The connection id this flow uses: its own from before when it still points
 * at the preset, else the first free one. A connection in use as the default
 * is never rebound: a change is made beside what works.
 */
async function connectionIdFor(
  deps: OnboardDependencies,
  status: OnboardingStatus,
  choice: ModelChoice,
  baseUrl: string,
  inUse: string | undefined,
): Promise<{ readonly connectionId: string; readonly exists: boolean }> {
  const connections = await deps.transport.request<readonly { readonly connectionId: string; readonly baseUrl: string }[]>("models", {
    action: "list",
  });
  const stored = new Set(
    (await deps.transport.request<{ readonly credentials: readonly string[] }>("credentials", { action: "list" })).credentials,
  );
  const own = status.steps.find((step) => step.kind === "model")?.createdRef;
  const byId = new Map(connections.map((connection) => [connection.connectionId, connection]));
  const ours = (candidate: string) =>
    candidate === own &&
    candidate !== inUse &&
    (byId.get(candidate) === undefined || normaliseBaseUrl(byId.get(candidate)?.baseUrl ?? "") === normaliseBaseUrl(baseUrl));
  const free = (candidate: string) => ours(candidate) || (!byId.has(candidate) && !stored.has(candidate));
  let connectionId = choice.preset.id;
  for (let suffix = 2; !free(connectionId); suffix += 1) connectionId = `${choice.preset.id}-${String(suffix)}`;
  return { connectionId, exists: byId.has(connectionId) };
}

/** The key, from where it may come: never argv. `again`: a retry, which always asks, whatever the first key came from. */
async function keyFor(deps: OnboardDependencies, choice: ModelChoice, headless: HeadlessModel | undefined, again = false): Promise<string> {
  if (choice.preset.localOnly && choice.variable === undefined && !again) return LOCAL_NO_KEY_CREDENTIAL;
  if (choice.variable !== undefined && !again) {
    const value = (deps.env[choice.variable] ?? "").trim();
    if (value === "") throw new TaviError("NOT_FOUND", `${choice.variable} is not set`);
    return value;
  }
  if (headless !== undefined) {
    if (headless.keyFile !== undefined) {
      const path = headless.keyFile;
      // A file that cannot be read is the flag's mistake, said as one (exit 2), never an internal failure.
      const key = await deps.readFile(path).catch((error: unknown) => {
        const reason = (error as { code?: unknown }).code === "ENOENT" ? "no such file" : errorMessage(error);
        throw new TaviError("INVALID_INPUT", `--key-file ${path}: ${reason}`, { details: { flag: "--key-file" } });
      });
      return key.trim();
    }
    if (headless.keyStdin === true) return (await deps.readStdin()).trim();
    throw new StepOpen(`${choice.preset.name} needs a key: pass --key-file <path> or --key-stdin`, "--key-file");
  }
  // OpenRouter mints a key on sign-in: the tile's first action, with pasting a key beside it.
  const t = wordsOf(deps);
  if (choice.preset.id === "openrouter" && deps.signInWithOpenRouter !== undefined && !again) {
    const how = await deps.prompter.choose({
      label: t("cli.onboard.ask.openRouterHow"),
      options: [
        { value: "sign-in", label: t("cli.onboard.ask.openRouterSignIn"), hint: t("cli.onboard.ask.openRouterSignInHint") },
        { value: "paste", label: t("cli.onboard.ask.pasteKey") },
      ],
      default: "sign-in",
    });
    if (how === "sign-in") {
      try {
        const key = await deps.signInWithOpenRouter();
        deps.prompter.say(`${GLYPHS.done} ${t("cli.onboard.say.openRouterSignedIn")}`);
        return key;
      } catch (error) {
        if (error instanceof OnboardCancelled) throw error;
        deps.prompter.say(`${GLYPHS.failed} ${errorMessage(error)}`);
      }
    }
  }
  deps.prompter.say(t("cli.onboard.say.createKey", { page: keyPageOf(choice.preset) }));
  return await deps.prompter.text({
    label: t("cli.onboard.ask.key", { provider: choice.preset.name }),
    secret: true,
    check: (value) =>
      value.trim() === "" ? t("cli.onboard.ask.keyEmpty") : /\s/u.test(value.trim()) ? t("cli.onboard.ask.keySpaces") : undefined,
  });
}

/**
 * What a lifecycle sync stored of the connection's models, by id, as `models show`
 * carries it: a connection set up again keeps its rows, a new one has none. A
 * failed read proposes models as if none were stored.
 */
async function storedLifecycles(
  deps: Pick<OnboardDependencies, "transport">,
  connectionId: string,
): Promise<ReadonlyMap<string, ModelLifecycle> | undefined> {
  try {
    const shown = await deps.transport.request<{
      readonly catalog: readonly { readonly modelId: string; readonly lifecycle?: ModelLifecycle }[];
    }>("models", { action: "show", connectionId });
    return lifecycleByModel(shown.catalog);
  } catch {
    return undefined;
  }
}

async function pickModels(
  deps: OnboardDependencies,
  presetId: string,
  discovered: readonly string[],
  headless: HeadlessModel | undefined,
  lifecycle?: ReadonlyMap<string, ModelLifecycle>,
): Promise<{ readonly main: string; readonly fast?: string }> {
  const suggestion = suggestRoles(presetId, discovered, lifecycle === undefined ? {} : { lifecycle });
  if (headless !== undefined) {
    const main = headless.model ?? suggestion.main;
    if (main === undefined) throw new StepOpen("No model could be chosen for you: pass --model <id>", "--model");
    const fast = headless.fastModel ?? (headless.model === undefined ? suggestion.fast : undefined);
    return { main, ...(fast === undefined || fast === main ? {} : { fast }) };
  }
  const t = wordsOf(deps);
  const options: ChoiceOption[] = suggestion.candidates.map((model, index) => ({
    value: model,
    label: model,
    ...(index === 0 ? { hint: t("cli.onboard.ask.suggested") } : {}),
  }));
  options.push({ value: "other", label: t("cli.onboard.ask.other") });
  const chosen = await deps.prompter.choose({ label: t("cli.onboard.ask.model"), options, default: suggestion.main ?? "other" });
  const main =
    chosen !== "other"
      ? chosen
      : await deps.prompter.text({
          label: t("cli.onboard.ask.modelId"),
          check: (value) => (value === "" ? t("cli.onboard.ask.modelIdWrong") : undefined),
        });
  if (suggestion.fast === undefined || suggestion.fast === main) return { main };
  const fast = await deps.prompter.confirm({ label: t("cli.onboard.ask.fastModel", { model: suggestion.fast }), default: true });
  return fast ? { main, fast: suggestion.fast } : { main };
}

/** Verify one connection and model for a role before it becomes it, waiting out the owner's gate once. */
async function verified(
  deps: OnboardDependencies,
  workspaceId: string,
  role: "main" | "fast",
  connectionId: string,
  model: string,
): Promise<OnboardingVerifyAnswer["results"][number] | undefined> {
  const payload = { action: "verify", workspaceId, role, target: { connectionId, model } } as const;
  try {
    return (await deps.transport.request<OnboardingVerifyAnswer>("onboarding", payload, 60_000)).results[0];
  } catch (error) {
    if (!(error instanceof TaviError) || error.details?.["code"] !== "RATE_LIMITED") throw error;
    await (deps.sleep ?? sleep)(5_000);
    return (await deps.transport.request<OnboardingVerifyAnswer>("onboarding", payload, 60_000)).results[0];
  }
}

/**
 * Verify the chosen main model (and fast, once main passes), say each result,
 * and make them the roles: once main passes, or — when nothing worked before —
 * as they are, so the checklist says why it failed. A failed verify never moves
 * a working default.
 */
async function proveRoles(
  deps: OnboardDependencies,
  run: OnboardRun,
  connectionId: string,
  roles: { readonly main: string; readonly fast?: string },
  working: boolean,
): Promise<{
  readonly main?: OnboardingVerifyAnswer["results"][number] | undefined;
  readonly fast?: OnboardingVerifyAnswer["results"][number] | undefined;
}> {
  const say = (text: string) => deps.prompter.say(text);
  say(`Checking ${roles.main} with one short request…`);
  const main = await verified(deps, run.workspaceId, "main", connectionId, roles.main);
  const fast =
    main?.ok === true && roles.fast !== undefined ? await verified(deps, run.workspaceId, "fast", connectionId, roles.fast) : undefined;
  for (const result of [main, fast]) {
    if (result === undefined) continue;
    if (result.ok)
      say(
        `${GLYPHS.done} ${result.role === "main" ? "Inference ready" : "Fast model ready"}: ${result.model}${result.advice === undefined ? "" : ` — ${result.advice}`}`,
      );
    else
      say(
        `${GLYPHS.failed} ${result.role === "main" ? "The model" : "The fast model"} ${result.model} failed: ${result.advice ?? result.errorCode ?? "unknown"}`,
      );
  }
  if (main?.ok === true || !working) {
    await deps.transport.request("models", { action: "set-default", workspaceId: run.workspaceId, connectionId, model: roles.main });
    if (fast?.ok === true && roles.fast !== undefined)
      await deps.transport.request("models", {
        action: "set-role",
        workspaceId: run.workspaceId,
        role: "fast",
        connectionId,
        model: roles.fast,
      });
  }
  return { main, fast };
}

/**
 * The model step by Sign in with ChatGPT: the browser signs in here,
 * the owner stores the token record as the connection's credential (the
 * connection first, on the Responses wire), and the chosen models become the
 * roles once each verifies, as a typed key's do.
 */
async function chatGptModelStep(deps: OnboardDependencies, run: OnboardRun, current: OnboardingStatus): Promise<void> {
  const say = (text: string) => deps.prompter.say(text);
  if (deps.signInWithChatGpt === undefined) return;
  say("Signing in with ChatGPT in your browser. It uses your ChatGPT plan's allowance; ChatGPT Settings → Usage shows and limits it.");
  let answer: OnboardingConnectAnswer;
  try {
    const credential = await deps.signInWithChatGpt();
    answer = await deps.transport.request<OnboardingConnectAnswer>(
      "onboarding",
      { action: "connect-signed-in", workspaceId: run.workspaceId, preset: "chatgpt", credential },
      60_000,
    );
  } catch (error) {
    say(`${GLYPHS.failed} ${errorMessage(error)}`);
    return;
  }
  say(`${GLYPHS.done} Signed in with ChatGPT (${String(answer.models.length)} models)`);
  const roles = await pickModels(deps, "chatgpt", answer.models, undefined);
  const working = current.steps.find((step) => step.kind === "model")?.state === "done";
  const { main } = await proveRoles(deps, run, answer.connectionId, roles, working);
  if (main?.ok !== true && working) say("Your previous model is still the default.");
}

/** A model set up but not checked yet (`tavi models add`): one short request, if the person wants it, and its result. */
async function checkModel(deps: OnboardDependencies, workspaceId: string, step: OnboardingStatus["steps"][number]): Promise<void> {
  const name = step.detail.split(" · ").slice(0, 2).join(" · ");
  const t = wordsOf(deps);
  if (!(await deps.prompter.confirm({ label: t("cli.onboard.ask.checkModel", { name }), default: true }))) return;
  deps.prompter.say(t("cli.onboard.say.checking"));
  const answer = await deps.transport
    .request<OnboardingVerifyAnswer>("onboarding", { action: "verify", workspaceId, role: "main" }, 60_000)
    .catch((error: unknown) => error);
  const result =
    answer instanceof Error || answer === null || typeof answer !== "object" ? undefined : (answer as OnboardingVerifyAnswer).results[0];
  if (result === undefined)
    deps.prompter.say(`${GLYPHS.todo} It could not be checked now: ${answer instanceof Error ? errorMessage(answer) : "no answer"}`);
  else if (result.ok) deps.prompter.say(`${GLYPHS.done} ${name} answered`);
  else deps.prompter.say(`${GLYPHS.todo} ${result.advice ?? "It did not answer as expected"}`);
}

/**
 * The model step: detect → choose → key → add (or rebind its own
 * connection from a run that stopped) → discover → roles → verify. The
 * connection id is recorded before the first write, so a run stopped between
 * the key and the connection resumes on the same id. A failed verify keeps
 * the connection and offers another key or model; nothing is removed.
 */
async function modelStep(
  deps: OnboardDependencies,
  run: OnboardRun,
  current: OnboardingStatus,
  flowStep: OnboardingFlowStep | undefined,
): Promise<void> {
  const say = (text: string) => deps.prompter.say(text);
  const headless = run.headless;
  let choice: ModelChoice;
  if (headless !== undefined) {
    const named = preset(headless.preset);
    if (named === undefined)
      throw new StepOpen(
        `--preset must be one of ${MODEL_PROVIDER_PRESETS.map((candidate) => candidate.id).join(", ")} (custom with --base-url)`,
        "--preset",
      );
    if (named.baseUrl === "" && headless.baseUrl === undefined)
      throw new StepOpen("--preset custom needs its endpoint: pass --base-url <url>", "--base-url");
    if (named.baseUrl !== "" && headless.baseUrl !== undefined)
      throw new StepOpen(`${named.name}'s endpoint is fixed: --base-url goes with --preset custom`, "--base-url");
    choice = { preset: named, ...(headless.baseUrl === undefined ? {} : { baseUrl: headless.baseUrl }) };
  } else {
    say("");
    say("Tavi needs one model to answer you.");
    const detected = await detect({
      env: deps.env,
      fetch: deps.fetch,
      existing: async () =>
        (await deps.transport.request<readonly { readonly connectionId: string }[]>("models", { action: "list" })).map(
          (connection) => connection.connectionId,
        ),
    });
    const chosen = await chooseProvider(deps, flowStep, detected, current.chatGptSignIn === true);
    if (chosen === "chatgpt") return await chatGptModelStep(deps, run, current);
    choice = chosen;
  }
  const baseUrl = choice.baseUrl ?? choice.preset.baseUrl;
  // What works now stays until its replacement is proven: the default's connection is never rebound, and moves only after a pass.
  const working = current.steps.find((step) => step.kind === "model")?.state === "done";
  const inUse = (
    await deps.transport.request<{ readonly workspaceDefault: { readonly target: { readonly connectionId: string } } | null }>("models", {
      action: "roles",
      workspaceId: run.workspaceId,
    })
  ).workspaceDefault?.target.connectionId;
  const { connectionId, exists } = await connectionIdFor(deps, current, choice, baseUrl, inUse);
  // Beside one that is already there: said, so a second connection is never a surprise.
  if (connectionId !== choice.preset.id)
    deps.prompter.say(
      `A connection or key named ${choice.preset.id} is already there (in use, or added outside setup), so this one is added beside it as ${connectionId}; setup never changes one it did not make.`,
    );
  await deps.transport.request("onboarding", { action: "created", workspaceId: run.workspaceId, step: "model", ref: connectionId });
  let key = await keyFor(deps, choice, headless);
  const store = async () => {
    // The connection at its endpoint first, then its key: the key is bound to that origin before it is stored.
    if (exists) await deps.transport.request("models", { action: "rebind", connectionId, credentialRef: connectionId });
    else
      await deps.transport.request("models", {
        action: "add",
        connectionId,
        label:
          connectionId === choice.preset.id
            ? choice.preset.name
            : `${choice.preset.name} ${connectionId.slice(choice.preset.id.length + 1)}`,
        baseUrl,
        credentialRef: connectionId,
        localOnly: choice.preset.localOnly,
      });
    await deps.transport.request("credentials", { action: "set", reference: connectionId, value: key });
  };
  await store();
  for (let attempt = 0; ; attempt += 1) {
    let discovered: readonly string[];
    try {
      discovered = (
        await deps.transport.request<{ readonly models: readonly { readonly modelId: string }[] }>(
          "models",
          { action: "discover", connectionId },
          30_000,
        )
      ).models.map((entry) => entry.modelId);
    } catch (error) {
      say(`${GLYPHS.failed} ${choice.preset.name} could not list its models: ${errorMessage(error)}`);
      if (
        headless !== undefined ||
        attempt > 2 ||
        !(await deps.prompter.confirm({ label: wordsOf(deps)("cli.onboard.ask.anotherKey"), default: true }))
      )
        throw new StepOpen("The model step is not done: its models could not be listed", "--key-file");
      key = await keyFor(deps, choice, headless, true);
      await deps.transport.request("credentials", { action: "set", reference: connectionId, value: key });
      continue;
    }
    const roles = await pickModels(deps, choice.preset.id, discovered, headless, await storedLifecycles(deps, connectionId));
    const { main } = await proveRoles(deps, run, connectionId, roles, working);
    if (main?.ok === true) {
      // Only a provider Rhumb lists: a custom or local endpoint is never checked.
      if (headless === undefined && CLOUD_PROVIDERS.has(rhumbProviderOf(baseUrl) ?? "")) await offerRhumbKey(deps);
      return;
    }
    if (headless !== undefined) throw new StepOpen(`The model step is not done: ${main?.advice ?? "verify failed"}`, "--key-file");
    if (working) say("Your previous model is still the default.");
    const options: ChoiceOption[] = [
      // A local server takes no key: there is none to change.
      ...(choice.preset.localOnly ? [] : [{ value: "key", label: wordsOf(deps)("cli.onboard.ask.enterKey") }]),
      { value: "model", label: wordsOf(deps)("cli.onboard.ask.chooseModel") },
      { value: "later", label: wordsOf(deps)("cli.onboard.ask.later"), hint: wordsOf(deps)("cli.onboard.ask.laterHint") },
    ];
    const next = await deps.prompter.choose({
      label: wordsOf(deps)("cli.onboard.ask.whatNow"),
      options,
      default: main?.errorCode === "auth" && !choice.preset.localOnly ? "key" : "model",
    });
    if (next === "later") return;
    if (next === "key") {
      key = await keyFor(deps, choice, headless, true);
      await deps.transport.request("credentials", { action: "set", reference: connectionId, value: key });
    }
  }
}

/**
 * Once a cloud model works: a Rhumb key, so tavi can say before a model it
 * uses retires (`tavi models sync`, and serve daily). Optional, skipped on
 * Enter, and never asked again once a key is stored or `RHUMB_KEY` is set.
 */
export async function offerRhumbKey(
  deps: Pick<OnboardDependencies, "transport" | "prompter">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (rhumbKeyOf(env) !== undefined) return;
  const stored = await deps.transport
    .request<{ readonly credentials: readonly string[] }>("credentials", { action: "list" })
    .then((answer) => answer.credentials.includes(RHUMB_CREDENTIAL_REF))
    .catch(() => true);
  if (stored) return;
  const t = wordsOf(deps);
  deps.prompter.say(t("cli.onboard.say.rhumb"));
  const key = (await deps.prompter.text({ label: t("cli.onboard.ask.rhumbKey"), secret: true })).trim();
  if (key === "") return;
  try {
    await deps.transport.request("credentials", { action: "set", reference: RHUMB_CREDENTIAL_REF, value: key });
    deps.prompter.say(`${GLYPHS.done} ${t("cli.onboard.say.rhumbStored")}`);
  } catch (error) {
    deps.prompter.say(`${GLYPHS.failed} ${t("cli.onboard.say.rhumbNotStored", { why: errorMessage(error) })}`);
  }
}

// ------------------------------------------------------------------ the walk

/** A first run: no step is done yet. */
const firstAsk = (current: OnboardingStatus): boolean => !current.steps.some((step) => step.state === "done");

/** The steps a run walks, in the terminal flow's order. Headless, a step runs only when its flags are given. */
function walked(run: OnboardRun, current: OnboardingStatus): readonly OnboardingStepKind[] {
  if (run.headless !== undefined) {
    const given = run.headless;
    // Headless, a step runs only for its own flags: `tavi setup about --non-interactive` with none leaves about as it is.
    const flagged: readonly OnboardingStepKind[] = [
      ...(given.model !== undefined || given.keyFile !== undefined || given.keyStdin === true || given.presetGiven === true
        ? ["model" as const]
        : []),
      ...(given.name !== undefined || given.timezone !== undefined || given.activeHours !== undefined ? ["about" as const] : []),
      ...(given.search !== undefined ? ["search" as const] : []),
      ...(given.channelSecrets !== undefined ? ["channels" as const] : []),
    ];
    return run.step === undefined ? flagged : flagged.filter((kind) => kind === run.step);
  }
  if (run.step !== undefined) return [run.step];
  // A step done on another surface is listed after the run, with where it is done, never walked here.
  const here = current.steps.filter((step) => step.elsewhere === undefined);
  // A model set up but not checked yet is offered its one check first.
  const unchecked = modelUnverified(current.steps.find((step) => step.kind === "model")) ? ["model" as const] : [];
  const kinds =
    run.mode === "onboard"
      ? [...unchecked, ...current.open.filter((kind) => here.some((step) => step.kind === kind))]
      : here.filter((step) => step.state !== "unavailable").map((step) => step.kind);
  return kinds.filter((kind) => run.only === undefined || run.only.includes(kind));
}

export interface OnboardOutcome {
  readonly exit: number;
  readonly status?: OnboardingStatus;
  /** The flag a headless run was missing, when a required step is still open. */
  readonly missing?: string;
  /** What a headless run could not finish, and the command that does (`tavi channels pair <channel>`). */
  readonly next?: string;
  /** Flags a headless run did not apply, and why. */
  readonly ignored?: readonly string[];
  /** The first prompt the person chose: opened in a new chat's composer, unsent. */
  readonly draft?: string;
}

/** A step this surface does not walk (`tavi setup apps`): the canvas does it, and the command that does it now. */
const elsewhereLine = (title: string, kind: OnboardingStepKind): string =>
  `${GLYPHS.todo} ${title} — this one is done in tavi ui, or now with: ${STEP_COMMANDS[kind]}`;

function elsewhere(deps: OnboardDependencies, kind: OnboardingStepKind, flowStep: OnboardingFlowStep | undefined): void {
  if (STEP_COMMANDS[kind] === "") return;
  deps.prompter.say(elsewhereLine(flowStep?.title ?? kind, kind));
}

/** A step this terminal flow leaves to another surface or command: said with what does it. */
function deferred(deps: OnboardDependencies, step: OnboardingStatus["steps"][number]): void {
  if (step.state === "done") return;
  const t = wordsOf(deps);
  deps.prompter.say(
    `${stepLine(step, t)}${STEP_COMMANDS[step.kind] === "" ? "" : `\n  ${t("cli.onboard.later", { command: STEP_COMMANDS[step.kind] })}`}`,
  );
}

/** A headless run's other steps: each flag sets its step; a step without its flags is left as it is. */
async function headlessSteps(
  deps: OnboardDependencies,
  run: OnboardRun,
  kind: OnboardingStepKind,
  outcome: { next?: string; ignored: string[]; ownerNeeded?: boolean },
): Promise<void> {
  const given = run.headless as HeadlessModel;
  const context = { transport: deps.transport, prompter: deps.prompter, workspaceId: run.workspaceId };
  if (kind === "about") {
    const hours = given.activeHours === undefined ? undefined : parseActiveHours(given.activeHours);
    if (given.activeHours !== undefined && hours === undefined)
      throw new StepOpen("--active-hours takes a range such as 08:00-22:00", "--active-hours");
    const saved = await saveAbout(context, definedOnly({ name: given.name, timezone: given.timezone, activeHours: hours }));
    outcome.ignored.push(...saved.ignored);
  } else if (kind === "search" && given.search !== undefined) {
    if (!(WEB_SEARCH_KINDS as readonly string[]).includes(given.search))
      throw new StepOpen(`--search must be one of ${WEB_SEARCH_KINDS.join(", ")}`, "--search");
    const searchKind = given.search as (typeof WEB_SEARCH_KINDS)[number];
    const needsKey = searchNeedsKey(searchKind);
    if (needsKey && given.searchKeyFile === undefined)
      throw new StepOpen(`${given.search} needs a key: pass --search-key-file <path>`, "--search-key-file");
    if (searchKind === "searxng" && given.searchUrl === undefined)
      throw new StepOpen("searxng is reached by its address: pass --search-url <https://…>", "--search-url");
    await addSearch(
      deps.transport,
      searchKind,
      needsKey && given.searchKeyFile !== undefined ? (await deps.readFile(given.searchKeyFile)).trim() : undefined,
      given.searchUrl,
    );
  } else if (kind === "channels" && given.channelSecrets !== undefined) {
    // Added and tested; pairing needs a person to send the code, so the step stays open.
    const flags = given.channelSecrets.map((secret) => `--channel-secret ${secret.channel}:${secret.field}`);
    if (!deps.transport.attached) {
      // A channel's connection, ingress and pairing live in the owner.
      outcome.ignored.push(...flags.map((flag) => `${flag} (a channel needs a running owner: start tavi serve, then run this again)`));
      outcome.next = "tavi serve";
      outcome.ownerNeeded = true;
      return;
    }
    // Each channel and field is the catalog's: one it does not list is refused before anything is read or saved.
    const catalog = await channelCatalog(deps.transport);
    const byChannel = new Map<string, { readonly descriptor: ChannelDescriptor; readonly files: Map<string, string> }>();
    for (const secret of given.channelSecrets) {
      const descriptor = catalog.find((candidate) => candidate.providerId === secret.channel);
      if (descriptor === undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `--channel-secret: no channel ${JSON.stringify(secret.channel)} is installed; installed: ${catalog.map((one) => one.providerId).join(", ") || "none"}`,
        );
      const keys = channelSecretFields(descriptor).map((field) => field.key);
      if (!keys.includes(secret.field))
        throw new TaviError(
          "INVALID_INPUT",
          `--channel-secret: ${descriptor.label} has no secret ${JSON.stringify(secret.field)}; it takes ${keys.join(", ") || "none"}`,
        );
      const entry = byChannel.get(secret.channel) ?? { descriptor, files: new Map<string, string>() };
      entry.files.set(secret.field, secret.file);
      byChannel.set(secret.channel, entry);
    }
    const own = (await status(deps, run.workspaceId)).steps.find((step) => step.kind === "channels")?.createdRef;
    for (const [providerId, { descriptor, files }] of byChannel) {
      const secrets: Record<string, string> = {};
      for (const [field, file] of files) secrets[field] = (await deps.readFile(file)).trim();
      const added = await addChannel(deps.transport, run.workspaceId, descriptor, secrets, own);
      if (added.problem !== undefined) {
        // Not connected: said in the answer, with nothing to pair.
        deps.prompter.say(`${descriptor.label}: ${added.problem}`);
        outcome.ignored.push(`--channel-secret ${providerId} (${descriptor.label} refused it: ${added.problem})`);
        continue;
      }
      outcome.next ??= `tavi channels pair ${providerId}`;
    }
  }
}

/** Run `tavi onboard` or `tavi setup`. Cancelling keeps every write made so far. */
export async function runOnboard(deps: OnboardDependencies, run: OnboardRun): Promise<OnboardOutcome> {
  const say = (text: string) => deps.prompter.say(text);
  // `ownerNeeded`: a channel was asked for with no owner to hold it (exit 4).
  const extra: { next?: string; ignored: string[]; draft?: string; ownerNeeded?: boolean } = { ignored: [] };
  const result = (exit: number, current: OnboardingStatus): OnboardOutcome => ({
    exit,
    status: current,
    ...(extra.next === undefined ? {} : { next: extra.next }),
    ...(extra.ignored.length === 0 ? {} : { ignored: extra.ignored }),
    ...(extra.draft === undefined ? {} : { draft: extra.draft }),
  });
  try {
    const flow = await deps.transport.request<OnboardingFlowAnswer>("onboarding", {
      action: "flow",
      workspaceId: run.workspaceId,
      surface: "cli",
    });
    let current = await status(deps, run.workspaceId);
    // No flow at all (`tavi.onboarding` disabled, no plugin's): the checklist alone, with the command for each open step.
    if (current.providerId === null && run.headless === undefined) {
      const t = wordsOf(deps);
      say(t("cli.onboard.flowOff"));
      for (const step of current.steps)
        say(
          step.state === "done" || STEP_COMMANDS[step.kind] === ""
            ? stepLine(step, t)
            : `${stepLine(step, t)}\n  ${STEP_COMMANDS[step.kind]}`,
        );
      return result(current.complete ? ONBOARD_EXIT.ok : ONBOARD_EXIT.open, current);
    }
    const steps = walked(run, current);
    if (steps.length === 0) {
      if (run.headless === undefined) {
        // What is still open is another surface's (apps, web search): said, with where, never as "set up".
        const elsewhereOpen = current.steps.filter((step) => current.open.includes(step.kind));
        const t = wordsOf(deps);
        if (elsewhereOpen.length === 0) say(t("cli.onboard.allSet"));
        else {
          say(t("cli.onboard.leftElsewhere", { count: checklistCount(current, t) }));
          for (const step of elsewhereOpen) say(stepLine(step, t));
        }
      }
      // Headless with the model still open and no flag for it: the flag it needs is named.
      if (run.headless !== undefined && !current.complete)
        return { ...result(ONBOARD_EXIT.open, current), missing: run.headless.presetGiven === true ? "--key-file" : "--preset" };
      return result(current.complete ? ONBOARD_EXIT.ok : ONBOARD_EXIT.open, current);
    }
    // A first run is welcomed; a run that picks up what is left, or one step (`tavi setup service`), says what it is.
    if (run.headless === undefined)
      say(run.step !== undefined ? "Setup" : run.mode === "onboard" && !firstAsk(current) ? "Setup — what is left" : flow.flow.title);
    // The language comes first, so every later question can be asked in it: on a first run, and in a full `tavi setup`.
    if (run.headless === undefined && run.step === undefined && (run.mode === "setup" || firstAsk(current)))
      await languageStep({ transport: deps.transport, prompter: deps.prompter, workspaceId: run.workspaceId });
    for (const kind of steps) {
      const step = current.steps.find((candidate) => candidate.kind === kind);
      const flowStep = flow.flow.steps.find((candidate) => candidate.kind === kind);
      if (step === undefined && kind !== "search" && kind !== "apps") continue;
      const changing = step?.state === "done" && run.mode === "setup";
      // The funnel's "reached": a step a person is asked about, never one headless flags set. A failed count is not a failed run.
      if (run.headless === undefined && !(step?.state === "done" && run.mode === "onboard"))
        await deps.transport.request("onboarding", { action: "reached", workspaceId: run.workspaceId, step: kind }).catch(() => undefined);
      const context: StepContext = {
        transport: deps.transport,
        prompter: deps.prompter,
        system: deps.system,
        workspaceId: run.workspaceId,
        mode: run.mode,
        ...(flowStep === undefined ? {} : { flowStep }),
        status: current,
        ...(changing ? { changing: true } : {}),
      };
      if (kind === "model") {
        // `setup` shows what is set and keeps it on Enter; `onboard` never asks about a step that is done.
        if (
          step?.state === "done" &&
          run.mode === "setup" &&
          run.headless === undefined &&
          !(await deps.prompter.confirm({
            label: wordsOf(deps)("cli.onboard.changeIt", {
              step: wordsOf(deps)("cli.onboard.step.model"),
              detail: onboardingStepDetail(step, wordsOf(deps)),
            }),
            default: false,
          }))
        )
          continue;
        if (step?.state === "done" && run.headless === undefined && run.mode === "onboard") {
          if (modelUnverified(step)) await checkModel(deps, run.workspaceId, step);
          continue;
        }
        await modelStep(deps, run, current, flowStep);
      } else if (run.headless !== undefined) {
        await headlessSteps(deps, run, kind, extra);
      } else if (
        step?.state === "done" &&
        run.mode === "setup" &&
        kind !== "ideas" &&
        kind !== "service" &&
        !(await deps.prompter.confirm({
          label: wordsOf(deps)("cli.onboard.changeIt", {
            step: wordsOf(deps)(STEP_LABELS[kind]),
            detail: onboardingStepDetail(step, wordsOf(deps)),
          }),
          default: false,
        }))
      ) {
        continue;
      } else {
        switch (kind) {
          case "about":
            await aboutStep(context);
            break;
          case "channels":
            // Asked for by name with no owner to pair on: the run says so in its exit (4).
            if (run.step === "channels" && !deps.transport.attached) extra.ownerNeeded = true;
            await channelsStep(context);
            break;
          case "voice":
            await voiceStep(context);
            break;
          case "service":
            await serviceStep(context);
            break;
          case "search":
            await searchStep(context);
            break;
          case "tasks":
            await tasksStep(context);
            break;
          case "ideas": {
            const draft = await ideasStep(context);
            if (draft !== undefined) extra.draft = draft;
            break;
          }
          // A step the terminal has no flow for (apps): where it is done instead.
          default:
            if (step !== undefined) deferred(deps, step);
            else elsewhere(deps, kind, flowStep);
        }
      }
      current = await status(deps, run.workspaceId);
    }
    if (run.headless === undefined) {
      say("");
      const t = wordsOf(deps);
      for (const step of current.steps) say(stepLine(step, t));
      // The model step is done on `main`, but Ideas and summaries run on a fast model that failed.
      const fastAdvice = fastModelFailureIn(
        current.steps.find((step) => step.kind === "model"),
        t,
      );
      if (fastAdvice !== undefined) say(`${GLYPHS.todo} ${t("cli.onboard.fixFast", { advice: fastAdvice })}`);
      // The canvas's steps (apps, search) not walked in this run: said, with the command that does each now.
      for (const flowStep of flow.flow.steps) {
        if (
          !steps.includes(flowStep.kind) &&
          !current.steps.some((step) => step.kind === flowStep.kind) &&
          STEP_COMMANDS[flowStep.kind] !== ""
        )
          say(elsewhereLine(flowStep.title, flowStep.kind));
      }
    }
    // A headless run's required step left open names the flag it needs.
    if (run.headless !== undefined && !current.complete)
      return { ...result(ONBOARD_EXIT.open, current), missing: run.headless.presetGiven === true ? "--key-file" : "--preset" };
    // A channel was asked for and only a running owner could hold it.
    if (extra.ownerNeeded === true && current.complete) return result(ONBOARD_EXIT.unavailable, current);
    return result(current.complete ? ONBOARD_EXIT.ok : ONBOARD_EXIT.open, current);
  } catch (error) {
    if (error instanceof OnboardCancelled) {
      say("\nStopped. What was set up is kept; `tavi onboard` picks up from here.");
      return { exit: ONBOARD_EXIT.cancelled };
    }
    if (error instanceof StepOpen) {
      say(error.message);
      return { exit: ONBOARD_EXIT.open, missing: error.flag, ...(extra.next === undefined ? {} : { next: extra.next }) };
    }
    throw error;
  }
}
