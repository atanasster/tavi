import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  TaviError,
  WEB_SEARCH_ALLOW_RULE_ID,
  WEB_SEARCH_CAPABILITIES,
  WEB_SEARCH_KINDS,
  printable,
  type ChannelDescriptor,
  type ChannelSecretField,
  type ChannelsProbeAnswer,
  type ChannelsPairAnswer,
  type ChannelsPairingAnswer,
  type ChannelsPeopleAnswer,
  type ChannelsSaveAnswer,
  type HeartbeatGetAnswer,
  type IdeasChipsAnswer,
  type IdeasSettingsAnswer,
  type MessagingSetup,
  type MemoryListAnswer,
  type OnboardingFlowStep,
  type OnboardingStatus,
  type VoiceSetupStatus,
  type WorkspaceSettingsAnswer,
  errorTextIn,
  navPath,
  renderTextRef,
  voiceMissingWords,
} from "@tavi/contracts";
import { DEFAULT_LOCALE, LOCALE_NAMES, SUPPORTED_LOCALES, isLocale } from "@tavi/contracts/i18n";
import { sleep, WSL1_UNSUPPORTED, WSL_KEEP_RUNNING, wslVersion, type WslVersion } from "@tavi/node-kit";

import { FAST_MODEL_FAILED } from "@tavi/agent-host/onboarding-host";

import { serviceUnitPaths, unitNamesDataDirectory } from "./facts.js";
import { DEFAULT_SERVICE_LABEL, renderServiceUnit } from "../service/unit.js";
import { OnboardCancelled, type ChoiceOption, type Prompter } from "./prompter.js";
import { attachedTransport, type OnboardTransport } from "./transport.js";
import { connectLiveOwner } from "../../cli/owner-connection.js";
import { GLYPHS } from "../../tui/theme.js";
import { wordsIn } from "../../shared/terminal-words.js";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

/**
 * The terminal's steps after the model:
 * about you, where tasks live, a channel, keeping Tavi running, web search and a first idea.
 * Each writes through its own family's command; each can be skipped ("not
 * now"), which marks it skipped, or left with the command that does it.
 */

/** What these steps read and run beside the transport, injectable for tests. */
export interface StepSystem {
  readonly platform: NodeJS.Platform;
  /** The WSL version on Linux under Windows; absent elsewhere. */
  readonly wsl?: WslVersion;
  readonly home: string;
  readonly dataDirectory: string;
  /** The `node` that runs Tavi, and the entry point the person ran: what a unit execs. */
  readonly nodePath: string;
  readonly entryPath: string;
  /** Runs a user-scope service command (never `sudo`); its exit and output. */
  readonly run: (command: string, args: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>;
  readonly sleep: (ms: number) => Promise<void>;
  /** A fresh read of a file: the unit the service step finds. */
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly writeText: (path: string, text: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  /**
   * Whether an owner answers for this data directory, and whether it runs as
   * the service (its own `TAVI_SERVICE=1`, which the status's service step
   * says); undefined when none answers. Absent, a start is not checked.
   */
  readonly ownerIsService?: () => Promise<boolean | undefined>;
}

/** A user-scope service command for the service step: `launchctl` or `systemctl --user`, never through a shell, never `sudo`. */
export async function userScopeRunner(
  command: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly output: string }> {
  if (command !== "launchctl" && command !== "systemctl")
    throw new TaviError("NOT_AUTHORIZED", `the service step runs only launchctl or systemctl --user, not ${command}`);
  if (command === "systemctl" && args[0] !== "--user") throw new TaviError("NOT_AUTHORIZED", "the service step runs systemctl --user only");
  const { execFile } = await import("node:child_process");
  return await new Promise((done) => {
    execFile(command, [...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      done({
        code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

export function defaultStepSystem(dataDirectory: string, run: StepSystem["run"]): StepSystem {
  const wsl = wslVersion();
  return {
    platform: process.platform,
    ...(wsl === undefined ? {} : { wsl }),
    home: homedir(),
    dataDirectory: resolve(dataDirectory),
    nodePath: process.execPath,
    entryPath: resolve(process.argv[1] ?? ""),
    run,
    sleep: (ms) => sleep(ms),
    // A file that cannot be read reads as absent, as the importer takes a missing one.
    readText: async (path) => await readFile(path, "utf8").catch(() => undefined),
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, { mode: 0o644 });
    },
    remove: async (path) => await unlink(path),
    ownerIsService: async () => {
      // No live owner reachable: nothing to ask, as when none runs.
      const client = await connectLiveOwner(dataDirectory, ["onboarding"]).catch(() => undefined);
      if (client === undefined) return undefined;
      try {
        const status = await attachedTransport(client).request<OnboardingStatus>(
          "onboarding",
          { action: "status", workspaceId: "default", surface: "cli" },
          5_000,
        );
        return status.steps.find((step) => step.kind === "service")?.detail === "Running as a service";
      } catch {
        // No answer yet (a store still opening, a timeout): not a different owner, so the wait goes on.
        return undefined;
      } finally {
        client.close();
      }
    },
  };
}

export interface StepContext {
  readonly transport: OnboardTransport;
  readonly prompter: Prompter;
  readonly system: StepSystem;
  readonly workspaceId: string;
  readonly mode: "onboard" | "setup";
  readonly flowStep?: OnboardingFlowStep;
  readonly status: OnboardingStatus;
  /** `tavi setup` already asked "Change it?" of this done step, and the answer was yes. */
  readonly changing?: boolean;
}

const say = (context: StepContext, text: string) => context.prompter.say(text);
/** The words the prompter speaks now: the workspace's language once it is known, English until then. */
const wordsOf = (context: Pick<StepContext, "prompter">): CoreT => context.prompter.words?.() ?? coreEnglish;
const skip = async (context: StepContext, kind: "about" | "channels" | "voice" | "service" | "search" | "ideas" | "apps" | "tasks") => {
  await context.transport.request("onboarding", { action: "skip", workspaceId: context.workspaceId, step: kind });
};

/** Whether the step is done already: a "not now" then leaves it as it is, never marked skipped. */
const doneAlready = (context: StepContext, kind: string) => context.status.steps.find((step) => step.kind === kind)?.state === "done";

/** Asked before a step starts, unless the person just said to change it; a no marks an open step skipped. */
async function begin(
  context: StepContext,
  kind: "about" | "channels" | "voice" | "service" | "search",
  question: string,
): Promise<boolean> {
  if (context.changing === true) return true;
  const go = await context.prompter.confirm({ label: question, default: true });
  if (!go && !doneAlready(context, kind)) await skip(context, kind);
  return go;
}

// ------------------------------------------------------------------ language

/**
 * The language Tavi speaks, asked first so every later question can be asked
 * in it. Its label is in every language, since none is chosen yet; English is
 * the default and a stored choice is pre-selected. `workspace.locale` is
 * written only when the choice differs from English or one is already stored,
 * so a workspace left in English keeps no setting. With one language pack
 * there is nothing to ask.
 */
export async function languageStep(context: Pick<StepContext, "transport" | "prompter" | "workspaceId">): Promise<void> {
  if (SUPPORTED_LOCALES.length < 2) return;
  try {
    const settings = await context.transport.request<WorkspaceSettingsAnswer>("workspace-settings", {
      action: "get",
      workspaceId: context.workspaceId,
    });
    const stored = settings.settings.locale;
    const chosen = await context.prompter.choose({
      label: "Language / Език",
      options: SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
      default: stored ?? DEFAULT_LOCALE,
    });
    if (!isLocale(chosen)) return;
    // The questions after this one are asked in the language chosen — only once it is the workspace's, so a save
    // that fails leaves the run speaking the language every later `tavi` command will.
    if (chosen === stored || (stored === undefined && chosen === DEFAULT_LOCALE)) {
      context.prompter.useWords?.(wordsIn(chosen));
      return;
    }
    await context.transport.request("workspace-settings", {
      action: "set",
      workspaceId: context.workspaceId,
      key: "locale",
      value: chosen,
    });
    context.prompter.useWords?.(wordsIn(chosen));
    context.prompter.say(`${GLYPHS.done} ${wordsIn(chosen)("cli.onboard.language", { name: LOCALE_NAMES[chosen] })}`);
  } catch (error) {
    // Ctrl-C or the input ending stops the run, as at every other question.
    if (error instanceof OnboardCancelled) throw error;
    context.prompter.say(`${GLYPHS.failed} ${errorTextIn(error, wordsOf(context))}`);
  }
}

// ------------------------------------------------------------------ about you

/** A preference in the operator's personal scope: a new one, or the one already held corrected (no `MEMORY_CONFLICT`). */
async function remember(
  context: Pick<StepContext, "transport" | "workspaceId">,
  key: "user.name" | "user.timezone",
  value: string,
  title: string,
): Promise<void> {
  const listed = await context.transport.request<MemoryListAnswer>("memory", {
    action: "list",
    workspaceId: context.workspaceId,
    kinds: ["preference"],
    scopes: ["personal"],
  });
  const held = listed.records.find(
    (record) => record.preferenceKey === key && (record.status === "approved" || record.status === "proposed"),
  );
  // What memory already holds is not written again.
  if (held !== undefined && held.status === "approved" && held.body === `${title}: ${value}`) return;
  if (held !== undefined)
    await context.transport.request("memory", {
      action: "correct",
      workspaceId: context.workspaceId,
      recordId: held.recordId,
      preferenceValue: value,
      body: `${title}: ${value}`,
    });
  else
    await context.transport.request("memory", {
      action: "remember",
      workspaceId: context.workspaceId,
      kind: "preference",
      scope: "personal",
      title,
      body: `${title}: ${value}`,
      preferenceKey: key,
      preferenceValue: value,
    });
}

export interface AboutValues {
  readonly name?: string;
  readonly timezone?: string;
  readonly activeHours?: { readonly start: string; readonly end: string };
}

const HOURS = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/u;

/** `08:00-22:00` as a range, or undefined. */
export function parseActiveHours(text: string): { readonly start: string; readonly end: string } | undefined {
  const match = HOURS.exec(text.trim());
  return match === null || match[1] === match[2] ? undefined : { start: match[1] as string, end: match[2] as string };
}

/**
 * Save what was given (the about step): `operator.name` and the timezone in
 * workspace settings, active hours on the heartbeat when it is on, and the
 * name and zone as approved personal preferences when memory is on. What could
 * not be written is said, never thrown: the rest stays saved.
 */
export async function saveAbout(
  context: Pick<StepContext, "transport" | "prompter" | "workspaceId">,
  values: AboutValues,
): Promise<{ readonly ignored: readonly string[] }> {
  const ignored: string[] = [];
  const settings = await context.transport.request<WorkspaceSettingsAnswer>("workspace-settings", {
    action: "get",
    workspaceId: context.workspaceId,
  });
  if (values.name !== undefined && values.name !== settings.settings.operatorName) {
    await context.transport.request("workspace-settings", {
      action: "set",
      workspaceId: context.workspaceId,
      key: "operatorName",
      value: values.name,
    });
  }
  if (values.timezone !== undefined && values.timezone !== settings.effective.timezone) {
    await context.transport.request("workspace-settings", {
      action: "set",
      workspaceId: context.workspaceId,
      key: "timezone",
      value: values.timezone,
    });
  }
  if (values.activeHours !== undefined) {
    // Unread, the heartbeat counts as off here: nothing is written to it.
    const heartbeat = await context.transport
      .request<HeartbeatGetAnswer>("heartbeat", { action: "get", workspaceId: context.workspaceId })
      .catch(() => undefined);
    if (heartbeat?.config.enabled === true)
      await context.transport.request("heartbeat", {
        action: "set",
        workspaceId: context.workspaceId,
        revision: heartbeat.revision,
        changes: { activeHours: values.activeHours },
      });
    else ignored.push("--active-hours (the heartbeat is off)");
  }
  // Memory paused, or its plugin off: only the settings are written.
  const memoryOn = settings.effective.memory?.enabled !== false;
  if (memoryOn && (values.name !== undefined || values.timezone !== undefined)) {
    try {
      if (values.name !== undefined) await remember(context, "user.name", values.name, "Name");
      if (values.timezone !== undefined) await remember(context, "user.timezone", values.timezone, "Time zone");
    } catch (error) {
      const t = wordsOf(context);
      context.prompter.say(t("onboard.say.memoryRefused", { why: errorTextIn(error, t) }));
    }
  }
  await context.transport.request("onboarding", { action: "complete-step", workspaceId: context.workspaceId, step: "about" });
  return { ignored };
}

export async function aboutStep(context: StepContext): Promise<void> {
  const t = wordsOf(context);
  if (!(await begin(context, "about", t("cli.onboard.ask.about")))) return;
  const fields = context.flowStep?.about?.fields ?? ["name", "timezone", "activeHours"];
  const settings = await context.transport.request<WorkspaceSettingsAnswer>("workspace-settings", {
    action: "get",
    workspaceId: context.workspaceId,
  });
  const values: { name?: string; timezone?: string; activeHours?: { readonly start: string; readonly end: string } } = {};
  if (fields.includes("name")) {
    const name = await context.prompter.text({
      label: t("cli.onboard.ask.name"),
      ...(settings.settings.operatorName === undefined ? {} : { default: settings.settings.operatorName }),
      check: (value) => (value.length > 80 ? t("cli.onboard.ask.nameTooLong") : undefined),
    });
    if (name !== "") values.name = name;
  }
  if (fields.includes("timezone")) {
    values.timezone = await context.prompter.text({
      label: t("cli.onboard.ask.timezone"),
      default: settings.effective.timezone,
      check: (value) => (/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(value) ? undefined : t("cli.onboard.ask.timezoneWrong")),
    });
  }
  if (fields.includes("activeHours")) {
    // Unread, the heartbeat counts as off here: nothing is written to it.
    const heartbeat = await context.transport
      .request<HeartbeatGetAnswer>("heartbeat", { action: "get", workspaceId: context.workspaceId })
      .catch(() => undefined);
    if (heartbeat?.config.enabled === true) {
      const current = `${heartbeat.config.activeHours.start}-${heartbeat.config.activeHours.end}`;
      const typed = await context.prompter.text({
        label: t("cli.onboard.ask.hours"),
        default: current,
        check: (value) => (parseActiveHours(value) === undefined ? t("cli.onboard.ask.hoursWrong") : undefined),
      });
      const hours = parseActiveHours(typed);
      if (hours !== undefined && typed !== current) values.activeHours = hours;
    }
  }
  const memoryOn = settings.effective.memory?.enabled !== false;
  if (memoryOn && (values.name !== undefined || values.timezone !== undefined)) {
    const facts = [
      values.name === undefined ? undefined : t("onboard.say.yourName", { name: values.name }),
      values.timezone === undefined ? undefined : t("onboard.say.yourZone", { zone: values.timezone }),
    ].filter(Boolean);
    say(context, t("onboard.say.willRemember", { facts: facts.join(" · ") }));
  }
  try {
    await saveAbout(context, values);
    say(context, `${GLYPHS.done} ${t("onboard.say.aboutSaved")}`);
  } catch (error) {
    say(context, `${GLYPHS.failed} ${errorTextIn(error, t)}`);
  }
}

// ------------------------------------------------------------------ where tasks live

/** The commands that connect Todoist, the preset task app: its sign-in is in the browser, which this step cannot open. */
export const TODOIST_CONNECT_COMMANDS = [
  "tavi mcp add todoist --preset todoist",
  "tavi mcp probe mcp.todoist          # signs in through the browser",
  "tavi mcp approve mcp.todoist <version>",
  "tavi plugins enable mcp.todoist",
  "tavi config set tasks.home mcp:todoist",
] as const;

/**
 * Where to-dos go (`tasks.home`): Tavi's own list, which needs nothing set
 * (the step is marked done, and a home saved before is cleared), or
 * a task app already connected here, saved as `mcp:<server>`. With none
 * connected, the commands that connect Todoist; the step stays open.
 */
export async function tasksStep(context: StepContext): Promise<void> {
  const step = context.status.steps.find((candidate) => candidate.kind === "tasks");
  const connected = (step?.items ?? []).filter((item) => item.state === "connected");
  const settings = await context.transport.request<WorkspaceSettingsAnswer>("workspace-settings", {
    action: "get",
    workspaceId: context.workspaceId,
  });
  const current = settings.effective.tasksHome ?? settings.settings.tasksHome ?? "tavi";
  const t = wordsOf(context);
  const options: ChoiceOption[] = [
    { value: "tavi", label: t("cli.onboard.ask.tasksTavi"), hint: t("cli.onboard.ask.tasksTaviHint") },
    ...connected.map((item) => ({ value: item.id, label: printable(item.label), hint: t("cli.onboard.ask.tasksAppHint") })),
    ...(connected.some((item) => item.id === "mcp:todoist")
      ? []
      : [{ value: "connect", label: "Todoist", hint: t("cli.onboard.ask.todoistHint") }]),
    { value: "later", label: t("cli.onboard.ask.notNow") },
  ];
  const choice = await context.prompter.choose({
    label: t("cli.onboard.ask.tasks"),
    options,
    default: options.some((option) => option.value === current) ? current : "tavi",
  });
  if (choice === "later") return doneAlready(context, "tasks") ? undefined : await skip(context, "tasks");
  if (choice === "connect") {
    say(context, `${GLYPHS.todo} ${t("onboard.say.todoistBrowser")}\n${TODOIST_CONNECT_COMMANDS.map((line) => `  ${line}`).join("\n")}`);
    return;
  }
  try {
    // Tavi's own list is the default: choosing it clears a home saved before, as Settings does.
    if (choice !== current)
      await context.transport.request(
        "workspace-settings",
        choice === "tavi"
          ? { action: "unset", workspaceId: context.workspaceId, key: "tasksHome", expectedRevision: settings.revision }
          : { action: "set", workspaceId: context.workspaceId, key: "tasksHome", value: choice, expectedRevision: settings.revision },
      );
    if (choice === "tavi") {
      await context.transport.request("onboarding", { action: "complete-step", workspaceId: context.workspaceId, step: "tasks" });
      say(context, `${GLYPHS.done} ${t("onboard.say.todosTavi")}`);
    } else {
      const label = printable(connected.find((item) => item.id === choice)?.label ?? choice);
      say(context, `${GLYPHS.done} ${t("onboard.say.todosApp", { app: label })}`);
    }
  } catch (error) {
    say(context, `${GLYPHS.failed} ${errorTextIn(error, t)}`);
  }
}

// ------------------------------------------------------------------ channels

/** The channel offered when the flow features none: the first one the terminal has paired. */
const DEFAULT_FEATURED_CHANNEL = "telegram";

/** The channels the running owner has installed: each one's own words and fields. */
export async function channelCatalog(transport: OnboardTransport): Promise<readonly ChannelDescriptor[]> {
  // An owner answering without a catalog lists no channel.
  return (await transport.request<{ readonly channels?: readonly ChannelDescriptor[] }>("channels", { action: "catalog" })).channels ?? [];
}

/** The secrets a channel is added with: its `auth.fields`, none for one that signs in otherwise. */
export const channelSecretFields = (descriptor: ChannelDescriptor): readonly ChannelSecretField[] =>
  descriptor.auth.kind === "none" ? [] : (descriptor.auth.fields ?? []);

/**
 * The channel this terminal offers: the first of the flow's `featured`, else
 * the default, else the first installed, that is added with secrets alone (an
 * OAuth channel connects in the browser; one with a required setting in
 * Settings → Channels).
 */
function featuredChannel(channels: readonly ChannelDescriptor[], featured?: readonly string[]): ChannelDescriptor | undefined {
  const order = featured ?? [DEFAULT_FEATURED_CHANNEL, ...channels.map((channel) => channel.providerId)];
  return order
    .map((providerId) => channels.find((channel) => channel.providerId === providerId))
    .find(
      (channel) =>
        channel?.auth.kind === "secrets" && !channel.settings.some((field) => field.required === true && field.default === undefined),
    );
}

/**
 * Add a channel and test it: what headless setup does with
 * `--channel-secret`. `own` is the connection this flow created before (its
 * `createdRef`): a retry or a rerun saves the new secrets on it rather than
 * adding a second connection. A connection this call created that does not
 * answer is removed again, so a wrong secret leaves nothing behind.
 */
export async function addChannel(
  transport: OnboardTransport,
  workspaceId: string,
  descriptor: ChannelDescriptor,
  secrets: Readonly<Record<string, string>>,
  own?: string,
): Promise<{ readonly connectionId: string; readonly detail?: string; readonly setup?: MessagingSetup; readonly problem?: string }> {
  const { providerId } = descriptor;
  const listed = await transport.request<{
    readonly connections?: readonly { readonly connectionId: string; readonly providerId: string }[];
  }>("channels", { action: "list", workspaceId });
  const reuse =
    own !== undefined &&
    (listed.connections ?? []).some((connection) => connection.connectionId === own && connection.providerId === providerId)
      ? own
      : undefined;
  const saved = await transport.request<ChannelsSaveAnswer>("channels", {
    action: "save",
    workspaceId,
    ...(reuse === undefined ? {} : { connectionId: reuse }),
    providerId,
    enabled: true,
    settings: {},
    ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
  });
  if (reuse === undefined)
    await transport.request("onboarding", { action: "created", workspaceId, step: "channels", ref: saved.connectionId });
  const probed: ChannelsProbeAnswer =
    saved.notApplied !== undefined
      ? { ok: false, detail: saved.notApplied }
      : await transport.request<ChannelsProbeAnswer>("channels", { action: "probe", workspaceId, connectionId: saved.connectionId });
  // Best effort: a channel whose probe failed is removed; the answer names the problem either way.
  if (!probed.ok && reuse === undefined)
    await transport.request("channels", { action: "delete", workspaceId, connectionId: saved.connectionId }).catch(() => undefined);
  return {
    connectionId: saved.connectionId,
    ...(probed.ok && probed.detail !== undefined ? { detail: printable(probed.detail) } : {}),
    ...(probed.setup === undefined ? {} : { setup: probed.setup }),
    ...(probed.ok ? {} : { problem: probed.detail ?? `${descriptor.label} did not answer` }),
  };
}

/** A code for the operator to send, waited for, and confirmed: the binding is made only on yes. */
async function pairOn(
  context: StepContext,
  descriptor: ChannelDescriptor,
  connectionId: string,
  setup: MessagingSetup | undefined,
): Promise<boolean> {
  const singleLine = (text: string): string => printable(text).replace(/\s+/g, " ");
  const people = await context.transport.request<ChannelsPeopleAnswer>("channels", { action: "people", workspaceId: context.workspaceId });
  const principalId = people.operator ?? "operator";
  const settings = await context.transport.request<WorkspaceSettingsAnswer>("workspace-settings", {
    action: "get",
    workspaceId: context.workspaceId,
  });
  // Where the code goes, in the channel's words: its probe's link and the pairing's handle and deep link, when it gives them.
  const chat = setup?.link === undefined ? "" : ` (${singleLine(setup.link.url)})`;
  for (let round = 0; round < 3; round += 1) {
    const pairing = await context.transport.request<ChannelsPairAnswer>("channels", {
      action: "pair",
      workspaceId: context.workspaceId,
      connectionId,
      principalId,
      ...(settings.settings.operatorName === undefined ? {} : { name: settings.settings.operatorName }),
    });
    const code = singleLine(pairing.code.length === 8 ? `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}` : pairing.code);
    const t = wordsOf(context);
    const to =
      pairing.account === undefined
        ? t("onboard.say.taviOn", { channel: singleLine(descriptor.label) })
        : `@${singleLine(pairing.account)}`;
    const opens = singleLine(pairing.openLabel ?? descriptor.pairing?.openLabel ?? t("onboard.say.open"));
    const deepLink = pairing.linkUrl === undefined ? "" : `; ${opens}: ${singleLine(pairing.linkUrl)}`;
    say(context, t("onboard.say.sendCode", { code, to, chat, link: deepLink }));
    for (;;) {
      await context.system.sleep(2_000);
      const state = await context.transport.request<ChannelsPairingAnswer>("channels", {
        action: "pairing",
        workspaceId: context.workspaceId,
        pairingId: pairing.pairingId,
      });
      if (state.state === "claimed" && state.sender !== undefined) {
        const who =
          state.senderName === undefined ? singleLine(state.sender) : `${singleLine(state.senderName)} (${singleLine(state.sender)})`;
        let mine = false;
        try {
          mine = await context.prompter.confirm({ label: wordsOf(context)("cli.onboard.ask.isThisYou", { who }), default: false });
        } catch (error) {
          await context.transport
            .request("channels", {
              action: "cancel-pair",
              workspaceId: context.workspaceId,
              pairingId: pairing.pairingId,
            })
            .catch(() => undefined);
          throw error;
        }
        if (mine) {
          await context.transport.request("channels", {
            action: "confirm-pair",
            workspaceId: context.workspaceId,
            pairingId: pairing.pairingId,
          });
          say(context, `${GLYPHS.done} ${t("onboard.say.paired")}`);
          return true;
        }
        await context.transport.request("channels", {
          action: "cancel-pair",
          workspaceId: context.workspaceId,
          pairingId: pairing.pairingId,
        });
        say(context, t("onboard.say.notPaired"));
        return false;
      }
      // Expired, or the owner restarted and forgot it (codes live in its memory): a new one.
      if (state.state === "gone" || state.state === "expired") break;
    }
    if (!(await context.prompter.confirm({ label: wordsOf(context)("cli.onboard.ask.newCode"), default: true }))) return false;
  }
  return false;
}

export async function channelsStep(context: StepContext): Promise<void> {
  if (!context.transport.attached) {
    say(context, `${GLYPHS.todo} ${wordsOf(context)("onboard.say.channelsNeedOwner")}`);
    return;
  }
  // The terminal adds a channel set up with secrets alone; one featured otherwise (a company's Slack) is set up with its own command.
  const featured = context.flowStep?.featured;
  const descriptor = featuredChannel(await channelCatalog(context.transport), featured);
  if (descriptor === undefined) {
    const t = wordsOf(context);
    const title = context.flowStep?.title ?? t("cli.onboard.step.channels");
    say(
      context,
      featured === undefined || featured.length === 0
        ? `${GLYPHS.todo} ${t("onboard.say.noChannel", { title })}`
        : `${GLYPHS.todo} ${t("onboard.say.addChannel", {
            title,
            commands: featured.map((kind) => `\`tavi channels add ${kind}\``).join(t("onboard.say.or")),
            path: renderTextRef(navPath("nav.route.settings", "nav.settings.channels"), t) ?? "",
          })}`,
    );
    return;
  }
  const label = printable(descriptor.label);
  const t = wordsOf(context);
  if (!(await begin(context, "channels", t("cli.onboard.ask.channel", { channel: label })))) return;
  const fields = channelSecretFields(descriptor);
  if (descriptor.setupHelp !== undefined) say(context, descriptor.setupHelp);
  else for (const field of fields) if (field.help !== undefined) say(context, `${field.label}: ${field.help}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const secrets: Record<string, string> = {};
    for (const field of fields)
      secrets[field.key] = await context.prompter.text({
        label: t("cli.onboard.ask.hidden", { label: field.label }),
        secret: true,
        check: (value) => (value === "" ? t("cli.onboard.ask.pasteIt") : undefined),
      });
    const own = context.status.steps.find((step) => step.kind === "channels")?.createdRef;
    const added = await addChannel(context.transport, context.workspaceId, descriptor, secrets, own);
    if (added.problem === undefined) {
      say(
        context,
        `${GLYPHS.done} ${added.detail === undefined ? t("onboard.say.channelConnected", { label }) : t("onboard.say.channelConnectedDetail", { label, detail: added.detail })}`,
      );
      await pairOn(context, descriptor, added.connectionId, added.setup);
      return;
    }
    say(context, `${GLYPHS.failed} ${added.problem}`);
    if (!(await context.prompter.confirm({ label: t("cli.onboard.ask.tryAgain"), default: true }))) return;
  }
}

// ------------------------------------------------------------------ keeping it running

interface UnitPlace {
  readonly kind: "launchd" | "systemd";
  readonly path: string;
  readonly label: string;
  readonly load: readonly [string, readonly string[]][];
  readonly unload: readonly [string, readonly string[]][];
  readonly linger?: string;
}

/** The user-scope place and commands for this platform's unit: never a system path. */
export function unitPlace(
  system: Pick<StepSystem, "platform" | "home">,
  label: string,
  uid = process.getuid?.() ?? 0,
): UnitPlace | undefined {
  const path = serviceUnitPaths(system.platform, label, system.home)[0];
  if (path === undefined) return undefined;
  if (system.platform === "darwin") {
    return {
      kind: "launchd",
      path,
      label,
      load: [["launchctl", ["bootstrap", `gui/${String(uid)}`, path]]],
      unload: [["launchctl", ["bootout", `gui/${String(uid)}/${label}`]]],
    };
  }
  return {
    kind: "systemd",
    path,
    label,
    load: [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", label]],
    ],
    unload: [["systemctl", ["--user", "disable", "--now", label]]],
    linger: "loginctl enable-linger $USER",
  };
}

const commandLine = (steps: readonly [string, readonly string[]][]) =>
  steps.map(([command, args]) => [command, ...args].join(" ")).join(" && ");

export async function serviceStep(context: StepContext): Promise<void> {
  const system = context.system;
  const own = context.status.steps.find((step) => step.kind === "service")?.createdRef;
  const place = unitPlace(system, own ?? DEFAULT_SERVICE_LABEL);
  const said = wordsOf(context);
  if (place === undefined) {
    say(context, `${GLYPHS.unavailable} ${said(system.platform === "win32" ? "onboard.say.serviceWindows" : "onboard.say.serviceOther")}`);
    return;
  }
  // English is node-kit's own words for WSL, as the doctor and `tavi service` say them.
  if (system.wsl === 1) {
    say(
      context,
      `${GLYPHS.unavailable} ${said("onboard.say.serviceWsl1", { why: said === coreEnglish ? WSL1_UNSUPPORTED : said("onboard.say.wsl1") })}`,
    );
    return;
  }
  // However serve is kept running, WSL stops it with the distribution.
  if (system.wsl === 2) say(context, said === coreEnglish ? WSL_KEEP_RUNNING : said("onboard.say.wslKeepRunning"));
  const existing = await system.readText(place.path);
  const ours = existing !== undefined && own === place.label && unitNamesDataDirectory(existing, system.dataDirectory);
  if (ours && context.mode === "setup") {
    const t = wordsOf(context);
    const choice = await context.prompter.choose({
      label: t("cli.onboard.ask.runsFrom", { path: place.path }),
      options: [
        { value: "keep", label: t("cli.onboard.ask.keepIt") },
        { value: "remove", label: t("cli.onboard.ask.removeIt"), hint: t("cli.onboard.ask.removeItHint") },
      ],
      default: "keep",
    });
    if (choice === "remove" && (await context.prompter.confirm({ label: t("cli.onboard.ask.removeService"), default: false }))) {
      for (const [command, args] of place.unload) await system.run(command, args);
      await system.remove(place.path);
      say(context, `${GLYPHS.done} ${t("onboard.say.removed")}`);
    }
    return;
  }
  // A unit there already that this flow did not write for this data folder: replacing it is said, never a surprise.
  const another = existing !== undefined && !ours;
  const t = wordsOf(context);
  const options: ChoiceOption[] = [
    {
      value: "write",
      label: t("cli.onboard.ask.startWithComputer"),
      hint: t(another ? "cli.onboard.ask.unitThere" : "cli.onboard.ask.unitWrites", { path: place.path }),
    },
    { value: "self", label: t("cli.onboard.ask.runItMyself"), hint: t("cli.onboard.ask.runItMyselfHint") },
    { value: "later", label: t("cli.onboard.ask.notNow") },
  ];
  const choice = await context.prompter.choose({
    label: t("cli.onboard.ask.service"),
    options,
    default: "write",
  });
  if (choice === "later") return doneAlready(context, "service") ? undefined : await skip(context, "service");
  if (choice === "self") {
    await context.transport.request("onboarding", { action: "confirm-service", workspaceId: context.workspaceId, mode: "self-managed" });
    say(context, `${GLYPHS.done} ${t("onboard.say.runYourself")}`);
    return;
  }
  // Never over a unit this flow did not write: another data directory's, or one written by hand.
  if (existing !== undefined && !ours) {
    say(context, t("onboard.say.unitExists", { path: place.path, option: t("cli.onboard.ask.runItMyself") }));
    return;
  }
  await context.transport.request("onboarding", { action: "created", workspaceId: context.workspaceId, step: "service", ref: place.label });
  await system.writeText(
    place.path,
    renderServiceUnit({
      kind: place.kind,
      nodePath: system.nodePath,
      executablePath: system.entryPath,
      dataDirectory: system.dataDirectory,
      label: place.label,
      ...(place.kind === "systemd" ? { systemd: { scope: "user" } } : {}),
    }),
  );
  say(context, `${GLYPHS.done} ${t("onboard.say.wrote", { path: place.path })}`);
  const loadLine = commandLine(place.load);
  if (context.transport.attached) {
    // `serve` owns the data directory: a service started beside this one would fail and restart in a loop.
    say(
      context,
      `${t("onboard.say.stopServeFirst", { load: loadLine })}${place.linger === undefined ? "" : t("onboard.say.lingerNote", { command: place.linger })}`,
    );
    return;
  }
  if (!(await context.prompter.confirm({ label: t("cli.onboard.ask.startNow"), default: true }))) {
    say(context, `${t("onboard.say.startLater", { load: loadLine })}${place.linger === undefined ? "" : `\n  ${place.linger}`}`);
    return;
  }
  for (const [command, args] of place.load) {
    const ran = await system.run(command, args);
    if (ran.code !== 0) {
      say(
        context,
        `${GLYPHS.failed} ${t("onboard.say.commandFailed", { command: [command, ...args].join(" "), output: ran.output.trim().slice(0, 300) })}`,
      );
      return;
    }
  }
  // Up to 10 s for the owner it started to answer, told apart from one that is not the service.
  const linger = place.linger === undefined ? "" : t("onboard.say.lingerTail", { command: place.linger });
  if (system.ownerIsService === undefined) {
    say(context, `${GLYPHS.done} ${t("onboard.say.started", { linger })}`);
    return;
  }
  for (let waited = 0; waited <= 10_000; waited += 500) {
    // Unknown is not `true`: the step does not say it runs as a service.
    const answer = await system.ownerIsService().catch(() => undefined);
    if (answer === true) {
      say(context, `${GLYPHS.done} ${t("onboard.say.runningService", { linger })}`);
      return;
    }
    if (answer === false) {
      say(context, `${GLYPHS.todo} ${t("onboard.say.notService")}`);
      return;
    }
    await system.sleep(500);
  }
  const log = place.kind === "launchd" ? `launchctl print gui/$(id -u)/${place.label}` : `journalctl --user -u ${place.label}`;
  say(context, `${GLYPHS.failed} ${t("onboard.say.noOwnerAnswered", { log })}`);
}

// ------------------------------------------------------------------ web search

// ------------------------------------------------------------------ voice messages

/** How long the voice step waits on the owner's setup job: Homebrew's installs and the model's download together. */
const VOICE_SETUP_WAIT_MS = 45 * 60 * 1_000;

/** The voice job's progress as one line: its phase, and the download's share once it is known. */
function voiceProgress(job: NonNullable<VoiceSetupStatus["job"]>): string {
  if (job.phase === "download" && job.total !== undefined && job.total > 0)
    return `${job.message} ${String(Math.floor(((job.received ?? 0) / job.total) * 100))}%`;
  return job.message;
}

/**
 * Voice messages, on the running owner: what is missing, then, on a yes, the
 * owner's one job that adds it (Homebrew as the person's user, the pinned
 * model, `analyzers.json`), followed here until it ends. Offline, or where the
 * job cannot run (no Homebrew, Linux), the commands that do it by hand.
 */
export async function voiceStep(context: StepContext): Promise<void> {
  const step = context.status.steps.find((candidate) => candidate.kind === "voice");
  const t = wordsOf(context);
  if (step?.state === "unavailable")
    return say(context, `${GLYPHS.unavailable} ${t("onboard.say.voiceUnavailable", { detail: step.detail })}`);
  if (!context.transport.attached) return say(context, `${GLYPHS.todo} ${t("onboard.say.voiceNeedsOwner")}`);
  const voice = await context.transport.request<VoiceSetupStatus>("models", { action: "voice-status" });
  if (voice.ready) return say(context, `${GLYPHS.done} ${t("onboard.say.voiceReady")}`);
  const missing = voiceMissingWords(voice.missing, t);
  if (!voice.automatic) {
    // Asked all the same, so a no is a skip here as anywhere: the commands are what a yes gets.
    if (!(await begin(context, "voice", t("cli.onboard.ask.voiceByHand", { missing })))) return;
    say(context, t("onboard.say.runThese"));
    for (const command of voice.commands) say(context, `  ${command}`);
    return;
  }
  const question = t("cli.onboard.ask.voice", {
    missing,
    mb: String(voice.modelInfo.megabytes),
    licence: voice.modelInfo.licence,
  });
  if (!(await begin(context, "voice", question))) return;
  let current = await context.transport.request<VoiceSetupStatus>("models", { action: "voice-setup" });
  let said = "";
  const deadline = Date.now() + VOICE_SETUP_WAIT_MS;
  while (current.job?.state === "running" && Date.now() < deadline) {
    const line = voiceProgress(current.job);
    // A line per change of phase, and per tenth of the download: never a screen of repeats.
    const shown = line.replace(/\d+%$/u, (share) => `${String(Math.floor(Number.parseInt(share, 10) / 10) * 10)}%`);
    if (shown !== said) say(context, `  ${shown}`);
    said = shown;
    await context.system.sleep(1_000);
    current = await context.transport.request<VoiceSetupStatus>("models", { action: "voice-status" });
  }
  if (current.ready) return say(context, `${GLYPHS.done} ${t("onboard.say.voiceReady")}`);
  if (current.job?.state === "running") return say(context, `${GLYPHS.todo} ${t("onboard.say.voiceStill")}`);
  say(
    context,
    `${GLYPHS.failed} ${t("onboard.say.voiceFailed", { why: current.job?.message ?? t("onboard.say.stillMissing", { missing: current.missing.join(", ") }) })}`,
  );
  if (current.commands.length > 0) {
    say(context, `  ${t("onboard.say.byHand")}`);
    for (const command of current.commands) say(context, `  ${command}`);
  }
}

export async function searchStep(context: StepContext): Promise<void> {
  const t = wordsOf(context);
  if (!(await begin(context, "search", t("cli.onboard.ask.search")))) return;
  const kind = (await context.prompter.choose({
    label: t("cli.onboard.ask.searchProvider"),
    options: WEB_SEARCH_KINDS.map((candidate) => ({
      value: candidate,
      label: candidate,
      hint: t(
        candidate === "searxng"
          ? "cli.onboard.ask.searxngHint"
          : WEB_SEARCH_CAPABILITIES[candidate].supportsKeyless
            ? "cli.onboard.ask.noKeyNeeded"
            : "cli.onboard.ask.needsKey",
      ),
    })),
  })) as (typeof WEB_SEARCH_KINDS)[number];
  const key = searchNeedsKey(kind)
    ? await context.prompter.text({
        label: t("cli.onboard.ask.key", { provider: kind }),
        secret: true,
        check: (value) => (value === "" ? t("cli.onboard.ask.pasteKeyShort") : undefined),
      })
    : undefined;
  const baseUrl =
    kind === "searxng"
      ? await context.prompter.text({
          label: t("cli.onboard.ask.searxngUrl"),
          check: (value) => (/^https?:\/\/\S+$/u.test(value) ? undefined : t("cli.onboard.ask.baseUrlWrong")),
        })
      : undefined;
  try {
    await addSearch(context.transport, kind, key, baseUrl);
    say(context, `${GLYPHS.done} ${t("onboard.say.searchOn", { kind })}`);
    say(context, searchAllowedNotice(kind, t));
  } catch (error) {
    say(context, `${GLYPHS.failed} ${t("onboard.say.searchFailed", { kind, why: errorTextIn(error, t) })}`);
  }
}

/**
 * What the search step says once a provider is in: searches go to it without
 * asking, by the allow rule every workspace is seeded with
 * (`seeded-web-search`), and how to be asked each time or stop searching.
 */
export function searchAllowedNotice(kind: (typeof WEB_SEARCH_KINDS)[number], t: CoreT = coreEnglish): string {
  return [
    t("onboard.say.searchAllowed", { kind }),
    t("onboard.say.searchAsk", {
      kind,
      rule: WEB_SEARCH_ALLOW_RULE_ID,
      path: renderTextRef(navPath("nav.route.settings", "nav.settings.permissions"), t) ?? "",
    }),
  ].join("\n");
}

/** A key is needed by every kind but a keyless one and SearXNG, which is reached by its address instead. */
export function searchNeedsKey(kind: (typeof WEB_SEARCH_KINDS)[number]): boolean {
  return kind !== "searxng" && !WEB_SEARCH_CAPABILITIES[kind].supportsKeyless;
}

/** A search provider added, keyed and enabled through `search` and `credentials` (the search step). */
export async function addSearch(
  transport: OnboardTransport,
  kind: (typeof WEB_SEARCH_KINDS)[number],
  key: string | undefined,
  baseUrl?: string,
): Promise<void> {
  const providerId = kind;
  const credentialRef = key === undefined ? undefined : `search.${kind}`;
  if (credentialRef !== undefined && key !== undefined)
    await transport.request("credentials", { action: "set", reference: credentialRef, value: key });
  await transport.request("search", {
    action: "add",
    providerId,
    kind,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  await transport.request("search", { action: "enable", providerId });
}

// ------------------------------------------------------------------ a first idea

/**
 * First prompts: `ideas chips` at once — ideas, or chips for what
 * Tavi can do here — else the flow's own; a background `ideas refresh` on an
 * owner. The chosen one is handed back, to open in a new chat's composer,
 * unsent.
 */
export async function ideasStep(context: StepContext): Promise<string | undefined> {
  const chips = await context.transport
    .request<IdeasChipsAnswer>("ideas", { action: "chips", workspaceId: context.workspaceId, limit: 3 })
    .catch(() => ({ chips: [] }));
  const prompts =
    chips.chips.length > 0
      ? chips.chips.map((chip) => ({ label: chip.label, prompt: chip.prompt }))
      : [...(context.flowStep?.prompts ?? [])];
  // Never with Ideas switched off (onboarding never turns them on), nor while the fast model they run on failed verify.
  const settings = await context.transport
    .request<IdeasSettingsAnswer>("ideas", { action: "settings", workspaceId: context.workspaceId })
    .catch(() => undefined);
  const fastFailed = context.status.steps.find((step) => step.kind === "model")?.detail.includes(FAST_MODEL_FAILED) === true;
  if (context.transport.attached && settings?.settings.enabled === true && !fastFailed) {
    // Best effort: the refresh only brings the first ideas sooner.
    await context.transport.request("ideas", { action: "refresh", workspaceId: context.workspaceId }).catch(() => undefined);
    say(context, wordsOf(context)("onboard.say.ideasSoon"));
  } else if (!context.transport.attached && settings?.settings.enabled !== false && !fastFailed) {
    // Offline no run starts here: the owner's first scheduled run brings them.
    say(context, wordsOf(context)("onboard.say.ideasLater"));
  }
  if (prompts.length === 0) return undefined;
  const t = wordsOf(context);
  say(context, t("cli.onboard.ask.tryOne"));
  const options: ChoiceOption[] = [
    ...prompts.map((prompt, index) => ({ value: String(index), label: prompt.label, hint: prompt.prompt })),
    { value: "none", label: t("cli.onboard.ask.notNow") },
  ];
  const picked = await context.prompter.choose({ label: t("cli.onboard.ask.startChat"), options, default: "none" });
  return picked === "none" ? undefined : prompts[Number(picked)]?.prompt;
}
