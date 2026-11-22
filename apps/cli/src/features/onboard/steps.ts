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
  englishOf,
  navPath,
} from "@tavi/contracts";
import { DEFAULT_LOCALE, LOCALE_NAMES, SUPPORTED_LOCALES, isLocale } from "@tavi/contracts/i18n";
import { errorMessage } from "@tavi/contracts/util";
import { sleep, WSL1_UNSUPPORTED, WSL_KEEP_RUNNING, wslVersion, type WslVersion } from "@tavi/node-kit";

import { FAST_MODEL_FAILED } from "@tavi/agent-host/onboarding-host";

import { serviceUnitPaths, unitNamesDataDirectory } from "./facts.js";
import { DEFAULT_SERVICE_LABEL, renderServiceUnit } from "../service/unit.js";
import { OnboardCancelled, type ChoiceOption, type Prompter } from "./prompter.js";
import { attachedTransport, type OnboardTransport } from "./transport.js";
import { connectLiveOwner } from "../../cli/owner-connection.js";
import { GLYPHS } from "../../tui/theme.js";

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
    if (!isLocale(chosen) || chosen === stored || (stored === undefined && chosen === DEFAULT_LOCALE)) return;
    await context.transport.request("workspace-settings", {
      action: "set",
      workspaceId: context.workspaceId,
      key: "locale",
      value: chosen,
    });
    context.prompter.say(`${GLYPHS.done} Language: ${LOCALE_NAMES[chosen]}`);
  } catch (error) {
    // Ctrl-C or the input ending stops the run, as at every other question.
    if (error instanceof OnboardCancelled) throw error;
    context.prompter.say(`${GLYPHS.failed} ${errorMessage(error)}`);
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
      context.prompter.say(`Memory did not take them (${errorMessage(error)}); they are saved in the workspace's settings.`);
    }
  }
  await context.transport.request("onboarding", { action: "complete-step", workspaceId: context.workspaceId, step: "about" });
  return { ignored };
}

export async function aboutStep(context: StepContext): Promise<void> {
  if (!(await begin(context, "about", "Tell Tavi your name and time zone?"))) return;
  const fields = context.flowStep?.about?.fields ?? ["name", "timezone", "activeHours"];
  const settings = await context.transport.request<WorkspaceSettingsAnswer>("workspace-settings", {
    action: "get",
    workspaceId: context.workspaceId,
  });
  const values: { name?: string; timezone?: string; activeHours?: { readonly start: string; readonly end: string } } = {};
  if (fields.includes("name")) {
    const name = await context.prompter.text({
      label: "Your name",
      ...(settings.settings.operatorName === undefined ? {} : { default: settings.settings.operatorName }),
      check: (value) => (value.length > 80 ? "at most 80 characters" : undefined),
    });
    if (name !== "") values.name = name;
  }
  if (fields.includes("timezone")) {
    values.timezone = await context.prompter.text({
      label: "Your time zone",
      default: settings.effective.timezone,
      check: (value) => (/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(value) ? undefined : "an IANA zone such as Europe/Berlin"),
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
        label: "Hours the heartbeat may check in (HH:MM-HH:MM)",
        default: current,
        check: (value) => (parseActiveHours(value) === undefined ? "a range such as 08:00-22:00" : undefined),
      });
      const hours = parseActiveHours(typed);
      if (hours !== undefined && typed !== current) values.activeHours = hours;
    }
  }
  const memoryOn = settings.effective.memory?.enabled !== false;
  if (memoryOn && (values.name !== undefined || values.timezone !== undefined)) {
    say(
      context,
      `Tavi will remember: ${[values.name === undefined ? undefined : `your name is ${values.name}`, values.timezone === undefined ? undefined : `you're in ${values.timezone}`].filter(Boolean).join(" · ")} (tavi memory list shows it; tavi memory forget removes it).`,
    );
  }
  try {
    await saveAbout(context, values);
    say(context, `${GLYPHS.done} About you saved`);
  } catch (error) {
    say(context, `${GLYPHS.failed} ${errorMessage(error)}`);
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
  const options: ChoiceOption[] = [
    { value: "tavi", label: "Tavi's own list", hint: "works in every chat and channel, nothing to set up" },
    ...connected.map((item) => ({ value: item.id, label: printable(item.label), hint: "your to-dos go there" })),
    ...(connected.some((item) => item.id === "mcp:todoist")
      ? []
      : [{ value: "connect", label: "Todoist", hint: "connect it first; the sign-in is in your browser" }]),
    { value: "later", label: "Not now" },
  ];
  const choice = await context.prompter.choose({
    label: "Where do you keep tasks?",
    options,
    default: options.some((option) => option.value === current) ? current : "tavi",
  });
  if (choice === "later") return doneAlready(context, "tasks") ? undefined : await skip(context, "tasks");
  if (choice === "connect") {
    say(
      context,
      `${GLYPHS.todo} Todoist signs in through your browser: connect it on the Welcome page in tavi ui, or with\n${TODOIST_CONNECT_COMMANDS.map((line) => `  ${line}`).join("\n")}`,
    );
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
      say(context, `${GLYPHS.done} To-dos: Tavi's own list (tavi todos shows it)`);
    } else {
      const label = printable(connected.find((item) => item.id === choice)?.label ?? choice);
      say(
        context,
        `${GLYPHS.done} To-dos go to ${label}. Tavi's own list keeps only its own follow-ups; nothing is synced (tavi todos export, or ask in a chat to move them).`,
      );
    }
  } catch (error) {
    say(context, `${GLYPHS.failed} ${errorMessage(error)}`);
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
    const to = pairing.account === undefined ? `Tavi on ${singleLine(descriptor.label)}` : `@${singleLine(pairing.account)}`;
    const opens = singleLine(pairing.openLabel ?? descriptor.pairing?.openLabel ?? "open");
    const deepLink = pairing.linkUrl === undefined ? "" : `; ${opens}: ${singleLine(pairing.linkUrl)}`;
    say(context, `Send ${code} to ${to}${chat} within 10 minutes (or \`/link ${code}\`${deepLink}). Waiting…`);
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
          mine = await context.prompter.confirm({ label: `A message from ${who} carried the code. Is this you?`, default: false });
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
          say(context, `${GLYPHS.done} Paired: messages from you on this chat reach Tavi. Strangers are never answered.`);
          return true;
        }
        await context.transport.request("channels", {
          action: "cancel-pair",
          workspaceId: context.workspaceId,
          pairingId: pairing.pairingId,
        });
        say(context, "Not paired. Nobody else's messages are answered.");
        return false;
      }
      // Expired, or the owner restarted and forgot it (codes live in its memory): a new one.
      if (state.state === "gone" || state.state === "expired") break;
    }
    if (!(await context.prompter.confirm({ label: "The code is no longer valid. Get a new one?", default: true }))) return false;
  }
  return false;
}

export async function channelsStep(context: StepContext): Promise<void> {
  if (!context.transport.attached) {
    say(
      context,
      `${GLYPHS.todo} Channels — pairing needs a running owner: start \`tavi serve\` in another terminal, then run \`tavi onboard\` again.`,
    );
    return;
  }
  // The terminal adds a channel set up with secrets alone; one featured otherwise (a company's Slack) is set up with its own command.
  const featured = context.flowStep?.featured;
  const descriptor = featuredChannel(await channelCatalog(context.transport), featured);
  if (descriptor === undefined) {
    const title = context.flowStep?.title ?? "Channels";
    say(
      context,
      featured === undefined || featured.length === 0
        ? `${GLYPHS.todo} ${title} — none of the channels this setup offers is installed here.`
        : `${GLYPHS.todo} ${title} — ${featured.map((kind) => `\`tavi channels add ${kind}\``).join(" or ")}, then pair yourself in ${englishOf(navPath("nav.route.settings", "nav.settings.channels"))}.`,
    );
    return;
  }
  const label = printable(descriptor.label);
  if (!(await begin(context, "channels", `Message Tavi from ${label}?`))) return;
  const fields = channelSecretFields(descriptor);
  if (descriptor.setupHelp !== undefined) say(context, descriptor.setupHelp);
  else for (const field of fields) if (field.help !== undefined) say(context, `${field.label}: ${field.help}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const secrets: Record<string, string> = {};
    for (const field of fields)
      secrets[field.key] = await context.prompter.text({
        label: `${field.label} (hidden)`,
        secret: true,
        check: (value) => (value === "" ? "Paste it, or press Ctrl-C to stop (your progress is kept)" : undefined),
      });
    const own = context.status.steps.find((step) => step.kind === "channels")?.createdRef;
    const added = await addChannel(context.transport, context.workspaceId, descriptor, secrets, own);
    if (added.problem === undefined) {
      say(context, `${GLYPHS.done} ${label} connected${added.detail === undefined ? "" : `: ${added.detail}`}`);
      await pairOn(context, descriptor, added.connectionId, added.setup);
      return;
    }
    say(context, `${GLYPHS.failed} ${added.problem}`);
    if (!(await context.prompter.confirm({ label: "Try again?", default: true }))) return;
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
  if (place === undefined) {
    say(
      context,
      system.platform === "win32"
        ? `${GLYPHS.unavailable} Keep it running — tavi serve does not run on Windows yet: keep the owner running under WSL2. \`tavi service unit --kind task\` writes the logon task for when it does (docs/WINDOWS.md).`
        : `${GLYPHS.unavailable} Keep it running — a service unit is for macOS, Linux and Windows.`,
    );
    return;
  }
  if (system.wsl === 1) {
    say(context, `${GLYPHS.unavailable} Keep it running — ${WSL1_UNSUPPORTED}`);
    return;
  }
  // However serve is kept running, WSL stops it with the distribution.
  if (system.wsl === 2) say(context, WSL_KEEP_RUNNING);
  const existing = await system.readText(place.path);
  const ours = existing !== undefined && own === place.label && unitNamesDataDirectory(existing, system.dataDirectory);
  if (ours && context.mode === "setup") {
    const choice = await context.prompter.choose({
      label: `Tavi runs from ${place.path}.`,
      options: [
        { value: "keep", label: "Keep it" },
        { value: "remove", label: "Remove it", hint: "stops the service and deletes the unit this flow wrote" },
      ],
      default: "keep",
    });
    if (choice === "remove" && (await context.prompter.confirm({ label: "Stop the service and delete its unit?", default: false }))) {
      for (const [command, args] of place.unload) await system.run(command, args);
      await system.remove(place.path);
      say(context, `${GLYPHS.done} Removed. Start \`tavi serve\` yourself when you want channels and schedules.`);
    }
    return;
  }
  // A unit there already that this flow did not write for this data folder: replacing it is said, never a surprise.
  const another = existing !== undefined && !ours;
  const options: ChoiceOption[] = [
    another
      ? { value: "write", label: "Start Tavi with my computer", hint: `a unit not written by this setup is at ${place.path}; it is kept` }
      : { value: "write", label: "Start Tavi with my computer", hint: `writes ${place.path}, as your user` },
    { value: "self", label: "I run it myself", hint: "a terminal, tmux, my own unit" },
    { value: "later", label: "Not now" },
  ];
  const choice = await context.prompter.choose({
    label: "Channels, reminders and schedules work only while tavi serve runs. Keep it running?",
    options,
    default: "write",
  });
  if (choice === "later") return doneAlready(context, "service") ? undefined : await skip(context, "service");
  if (choice === "self") {
    await context.transport.request("onboarding", { action: "confirm-service", workspaceId: context.workspaceId, mode: "self-managed" });
    say(context, `${GLYPHS.done} You run it yourself`);
    return;
  }
  // Never over a unit this flow did not write: another data directory's, or one written by hand.
  if (existing !== undefined && !ours) {
    say(
      context,
      `${place.path} already exists and is not one this setup wrote. It is left as it is: choose "I run it myself", or remove it first.`,
    );
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
  say(context, `${GLYPHS.done} Wrote ${place.path}`);
  const loadLine = commandLine(place.load);
  if (context.transport.attached) {
    // `serve` owns the data directory: a service started beside this one would fail and restart in a loop.
    say(
      context,
      `Stop this tavi serve first (Ctrl-C in its terminal), then run:\n  ${loadLine}${place.linger === undefined ? "" : `\n  ${place.linger}   (so it keeps running after you log out)`}`,
    );
    return;
  }
  if (!(await context.prompter.confirm({ label: "Start it now?", default: true }))) {
    say(context, `Start it later with:\n  ${loadLine}${place.linger === undefined ? "" : `\n  ${place.linger}`}`);
    return;
  }
  for (const [command, args] of place.load) {
    const ran = await system.run(command, args);
    if (ran.code !== 0) {
      say(context, `${GLYPHS.failed} ${[command, ...args].join(" ")} failed: ${ran.output.trim().slice(0, 300)}`);
      return;
    }
  }
  // Up to 10 s for the owner it started to answer, told apart from one that is not the service.
  const linger = place.linger === undefined ? "" : `. To keep it running after you log out: ${place.linger}`;
  if (system.ownerIsService === undefined) {
    say(context, `${GLYPHS.done} Started${linger}`);
    return;
  }
  for (let waited = 0; waited <= 10_000; waited += 500) {
    // Unknown is not `true`: the step does not say it runs as a service.
    const answer = await system.ownerIsService().catch(() => undefined);
    if (answer === true) {
      say(context, `${GLYPHS.done} Running as a service${linger}`);
      return;
    }
    if (answer === false) {
      say(
        context,
        `${GLYPHS.todo} An owner answers, but not as the service: another tavi serve holds this data directory. Stop it, and the service takes over.`,
      );
      return;
    }
    await system.sleep(500);
  }
  const log = place.kind === "launchd" ? `launchctl print gui/$(id -u)/${place.label}` : `journalctl --user -u ${place.label}`;
  say(context, `${GLYPHS.failed} The service was started, but no owner answered within 10 seconds. Its log says why: ${log}`);
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
  if (step?.state === "unavailable") return say(context, `${GLYPHS.unavailable} Voice messages — ${step.detail}`);
  if (!context.transport.attached)
    return say(
      context,
      `${GLYPHS.todo} Voice messages — set up by the running owner: start tavi serve, then tavi setup voice (or by hand: brew install whisper-cpp ffmpeg)`,
    );
  const voice = await context.transport.request<VoiceSetupStatus>("models", { action: "voice-status" });
  if (voice.ready) return say(context, `${GLYPHS.done} Voice messages: transcribed on this computer`);
  const missing = `Missing: ${voice.missing.join(", ")}.`;
  if (!voice.automatic) {
    // Asked all the same, so a no is a skip here as anywhere: the commands are what a yes gets.
    if (!(await begin(context, "voice", `Set up voice messages? ${missing} Tavi cannot install them here: you run the commands it gives.`)))
      return;
    say(context, "Run these, then tavi setup voice again:");
    for (const command of voice.commands) say(context, `  ${command}`);
    return;
  }
  const question = `Set up voice messages? ${missing} Homebrew installs what is missing as your user, and Whisper's base model (${String(voice.modelInfo.megabytes)} MB, ${voice.modelInfo.licence}) downloads from Hugging Face.`;
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
  if (current.ready) return say(context, `${GLYPHS.done} Voice messages: transcribed on this computer`);
  if (current.job?.state === "running")
    return say(context, `${GLYPHS.todo} Voice messages — still setting up on the owner; tavi doctor says when it is ready`);
  say(context, `${GLYPHS.failed} Voice messages were not set up: ${current.job?.message ?? `still missing ${current.missing.join(", ")}`}`);
  if (current.commands.length > 0) {
    say(context, "  To set them up by hand:");
    for (const command of current.commands) say(context, `  ${command}`);
  }
}

export async function searchStep(context: StepContext): Promise<void> {
  if (!(await begin(context, "search", "Set up web search?"))) return;
  const kind = (await context.prompter.choose({
    label: "Which search provider?",
    options: WEB_SEARCH_KINDS.map((candidate) => ({
      value: candidate,
      label: candidate,
      hint:
        candidate === "searxng"
          ? "your own instance, by its address"
          : WEB_SEARCH_CAPABILITIES[candidate].supportsKeyless
            ? "no key needed"
            : "needs a key",
    })),
  })) as (typeof WEB_SEARCH_KINDS)[number];
  const key = searchNeedsKey(kind)
    ? await context.prompter.text({
        label: `${kind} key (hidden)`,
        secret: true,
        check: (value) => (value === "" ? "Paste the key" : undefined),
      })
    : undefined;
  const baseUrl =
    kind === "searxng"
      ? await context.prompter.text({
          label: "Your SearXNG address (https://…)",
          check: (value) => (/^https?:\/\/\S+$/u.test(value) ? undefined : "an http(s) URL"),
        })
      : undefined;
  try {
    await addSearch(context.transport, kind, key, baseUrl);
    say(context, `${GLYPHS.done} Web search: ${kind}`);
    say(context, searchAllowedNotice(kind));
  } catch (error) {
    say(context, `${GLYPHS.failed} ${kind} was not added: ${errorMessage(error)}`);
  }
}

/**
 * What the search step says once a provider is in: searches go to it without
 * asking, by the allow rule every workspace is seeded with
 * (`seeded-web-search`), and how to be asked each time or stop searching.
 */
export function searchAllowedNotice(kind: (typeof WEB_SEARCH_KINDS)[number]): string {
  return [
    `Searches go to ${kind} without asking; a query that looks like a key or token still asks first, and so does a chat that read a web page or an email before a search that could carry private data out.`,
    `To be asked before every search: tavi permissions rm ${WEB_SEARCH_ALLOW_RULE_ID} (or remove it in ${englishOf(navPath("nav.route.settings", "nav.settings.permissions"))}). To stop searching: tavi search disable ${kind}.`,
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
    say(context, "Personal ideas will be in `tavi ideas` in a minute.");
  } else if (!context.transport.attached && settings?.settings.enabled !== false && !fastFailed) {
    // Offline no run starts here: the owner's first scheduled run brings them.
    say(context, "Personal ideas start once `tavi serve` runs; `tavi ideas` shows them.");
  }
  if (prompts.length === 0) return undefined;
  say(context, "Try one:");
  const options: ChoiceOption[] = [
    ...prompts.map((prompt, index) => ({ value: String(index), label: prompt.label, hint: prompt.prompt })),
    { value: "none", label: "Not now" },
  ];
  const picked = await context.prompter.choose({ label: "Start a new chat with it", options, default: "none" });
  return picked === "none" ? undefined : prompts[Number(picked)]?.prompt;
}
