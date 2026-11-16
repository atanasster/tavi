import {
  HEARTBEAT_TELL_ME,
  TOOL_LABEL_KEY,
  TaviError,
  defaultHeartbeatConfig,
  memoryProvenanceLabel,
  memoryProvenanceOf,
  memoryProvenanceUntrusted,
  heartbeatWatchedPages,
  withWatchedHosts,
  formatHeartbeatInterval,
  hostTimeZone,
  type CallAssessment,
  type HeartbeatConfig,
  type HeartbeatOptions,
  type InvocationContext,
  type PersistencePort,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";
import { z } from "zod";

import { nearestHeartbeatInterval } from "./text.js";
import { saveHeartbeatChange } from "./owner.js";

/**
 * Configuring the heartbeat by chat:
 * `heartbeat.status` reads it, and `heartbeat.propose` changes it — a
 * mutating call, so the gate asks and the card shows the change as a diff
 * against the revision the agent read. Both are the workspace operator's;
 * neither is ever offered to a heartbeat's own turn (its allowlist names
 * neither).
 */

export const HEARTBEAT_STATUS_TOOL_ID = "heartbeat.status";
export const HEARTBEAT_PROPOSE_TOOL_ID = "heartbeat.propose";

const StatusInputSchema = z.strictObject({});

/** What the agent may propose, in the shapes a model writes; turned into a settings change by the handler. */
const ProposeInputSchema = z.strictObject({
  revision: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "The revision heartbeat.status answered (0 when there is no heartbeat yet): a heartbeat changed since is refused, never overwritten",
    ),
  enabled: z.boolean().optional().describe("Turn it on or off"),
  every: z
    .string()
    .max(16)
    .optional()
    .describe("How often it checks, as a duration among heartbeat.status's everyChoices, such as 30m or 1h"),
  activeHours: z
    .strictObject({
      start: z.string().max(5).describe("24-hour HH:MM, such as 08:00"),
      end: z.string().max(5).describe("24-hour HH:MM, such as 22:00; may be earlier than start, crossing midnight"),
    })
    .optional()
    .describe("When it may check and message, in the workspace's timezone"),
  days: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe("The days it runs, as numbers: 0 = Sunday, 1 = Monday … 6 = Saturday"),
  tellMe: z
    .enum(HEARTBEAT_TELL_ME)
    .optional()
    .describe("urgent-now: urgent right away, the rest in a summary; everything-now; digest-only"),
  instructions: z
    .string()
    .max(8_192)
    .optional()
    .describe("The whole new instruction list, one concern per line: it replaces the current list, so keep the lines that stay"),
  reason: z.string().min(1).max(300).describe("Why, in a sentence the person reads on the approval card"),
});
type ProposeInput = z.infer<typeof ProposeInputSchema>;

export interface HeartbeatToolDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "heartbeats" | "workspaceSettings">;
  /** The operator a workspace is served for. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly options: HeartbeatOptions;
  readonly now: () => Date;
}

const keyOf = (context: Pick<InvocationContext, "workspaceId" | "principalId">): string =>
  `${context.workspaceId}\u0000${context.principalId}`;

/** The proposal as a settings change over `config`, with the hosts of pages it newly watches, as the save adds them. */
function proposed(config: HeartbeatConfig, input: ProposeInput, options: HeartbeatOptions): HeartbeatConfig {
  const everyMs = input.every === undefined ? undefined : intervalOf(input.every, options);
  return withWatchedHosts(config.instructions, {
    ...config,
    ...definedOnly({
      enabled: input.enabled,
      everyMs,
      activeHours: input.activeHours,
    }),
    ...(input.days === undefined ? {} : { daysOfWeek: [...new Set(input.days)].sort((a, b) => a - b) }),
    ...(input.tellMe === undefined ? {} : { tellMe: input.tellMe }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
  });
}

function intervalOf(every: string, options: HeartbeatOptions): number {
  const match = /^(\d+)(m|h)$/.exec(every.trim());
  const asked = match === null ? undefined : Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000);
  const snapped = asked === undefined ? undefined : nearestHeartbeatInterval(asked, options.every);
  if (snapped === undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `"${every}" is not one of the intervals: ${options.every.map(formatHeartbeatInterval).join(", ")}`,
    );
  return snapped;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const daysOf = (days: readonly number[] | undefined): string =>
  days === undefined ? "every day" : days.map((day) => DAY_NAMES[day] ?? String(day)).join(", ");

/** The approval card's lines: each setting that changes, before → after; the instructions line by line. */
export function heartbeatDiff(before: HeartbeatConfig, after: HeartbeatConfig): readonly string[] {
  const lines: string[] = [];
  // First, so a long card never cuts it off: a watched page's host is what it may read, unattended.
  for (const host of after.fetchHosts) if (!before.fetchHosts.includes(host)) lines.push(`Sites it may read: + ${host}`);
  const changed = (label: string, from: string, to: string): void => {
    if (from !== to) lines.push(`${label}: ${from} → ${to}`);
  };
  changed("On", before.enabled ? "on" : "off", after.enabled ? "on" : "off");
  changed("How often", formatHeartbeatInterval(before.everyMs), formatHeartbeatInterval(after.everyMs));
  changed("Active hours", `${before.activeHours.start}–${before.activeHours.end}`, `${after.activeHours.start}–${after.activeHours.end}`);
  changed("Days", daysOf(before.daysOfWeek), daysOf(after.daysOfWeek));
  changed("Tell me", before.tellMe, after.tellMe);
  if (before.instructions !== after.instructions) {
    const old = new Set(
      before.instructions
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    const next = new Set(
      after.instructions
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    for (const line of old) if (!next.has(line)) lines.push(`- ${line}`);
    for (const line of next) if (!old.has(line)) lines.push(`+ ${line}`);
  }
  return lines;
}

export function registerHeartbeatTools(tools: ToolRegistry, deps: HeartbeatToolDependencies): void {
  /** The config each person's last status read answered, by its revision: what the approval card diffs against. */
  const read = new Map<string, HeartbeatConfig>();
  const operatorOnly = (context: InvocationContext): void => {
    if (deps.principalOf(context.workspaceId) !== context.principalId)
      throw new TaviError("NOT_AUTHORIZED", "The heartbeat is the workspace operator's: only they can read or change it");
  };

  tools.register({
    id: HEARTBEAT_STATUS_TOOL_ID,
    sink: "none",
    version: "1.0.0",
    description:
      "The person's heartbeat: whether it is on or paused, how often and when it checks, how it tells them, its instructions (what it keeps an eye on), its next and last check, and the revision heartbeat.propose must name.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: StatusInputSchema,
    handler: async ({ context }) => {
      operatorOnly(context);
      const state = await deps.repositories.heartbeats.get(context.workspaceId, context.principalId);
      const timezone = (await deps.repositories.workspaceSettings.get(context.workspaceId)).settings.timezone ?? hostTimeZone();
      if (state === undefined) {
        // A first proposal is shown against the defaults it starts from.
        const defaults = defaultHeartbeatConfig();
        read.set(keyOf(context), { ...defaults, revision: 0 });
        return {
          configured: false,
          revision: 0,
          note: "No heartbeat yet: propose one with heartbeat.propose (revision 0). These are the defaults it starts from.",
          every: formatHeartbeatInterval(defaults.everyMs),
          everyChoices: deps.options.every.map(formatHeartbeatInterval),
          activeHours: defaults.activeHours,
          days: daysOf(defaults.daysOfWeek),
          timezone,
          tellMe: defaults.tellMe,
        };
      }
      read.set(keyOf(context), state.config);
      const config = state.config;
      return {
        configured: true,
        revision: config.revision,
        enabled: config.enabled,
        ...(config.paused === undefined ? {} : { paused: config.paused }),
        every: formatHeartbeatInterval(config.everyMs),
        everyChoices: deps.options.every.map(formatHeartbeatInterval),
        activeHours: config.activeHours,
        days: daysOf(config.daysOfWeek),
        timezone,
        tellMe: config.tellMe,
        instructions: config.instructions,
        targets: config.targets.length,
        ...(state.nextTickAt === undefined ? {} : { nextCheck: state.nextTickAt }),
        ...(state.lastTickAt === undefined ? {} : { lastCheck: state.lastTickAt }),
        // Instructions a chat proposed under taint are read with where they came from.
        ...(config.provenance !== undefined && memoryProvenanceUntrusted(config.provenance)
          ? { [TOOL_LABEL_KEY]: { stored: memoryProvenanceLabel(config.provenance) } }
          : {}),
      };
    },
  });

  tools.register({
    id: HEARTBEAT_PROPOSE_TOOL_ID,
    sink: "persist",
    version: "1.0.0",
    description:
      "Change the person's heartbeat — turn it on or off, how often, active hours and days, how it tells them, or its instruction list (send the whole new list). Read heartbeat.status first and name its revision. The person approves the change, shown as a diff.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ProposeInputSchema,
    assess: (input, context): CallAssessment => {
      const parsed = ProposeInputSchema.safeParse(input);
      // A first proposal (revision 0) is shown against the defaults, whether or not the status was read.
      const before =
        read.get(keyOf(context)) ??
        (parsed.success && parsed.data.revision === 0 ? { ...defaultHeartbeatConfig(), revision: 0 } : undefined);
      let lines: readonly string[] = [];
      try {
        if (parsed.success && before !== undefined && before.revision === parsed.data.revision)
          lines = heartbeatDiff(before, proposed(before, parsed.data, deps.options));
      } catch {
        // An interval outside the choices: the handler refuses it in words.
      }
      // With no diff to show, the sites its watch lines name are still named: saving may let it read them.
      const watched =
        !parsed.success || lines.length > 0 || parsed.data.instructions === undefined
          ? []
          : [...new Set(heartbeatWatchedPages(parsed.data.instructions).map((page) => page.host))];
      const sites = watched.length === 0 ? "" : `Sites its watch lines name, which it may then read: ${watched.join(", ")}\n\n`;
      const detail = !parsed.success
        ? "This change cannot be read."
        : lines.length > 0
          ? `${parsed.data.reason}\n\n${lines.join("\n")}`
          : `${sites}${parsed.data.reason}\n\n(Read the heartbeat again to see this change as a diff.)`;
      return {
        display: { title: "Change the heartbeat", detail: detail.slice(0, 2_000) },
        subjects: ["heartbeat"],
        risk: "medium",
        reasons: ["Changes what the heartbeat watches and when it may message you"],
        // Each change is approved on its own, never by a standing rule or grant.
        onceOnly: true,
        askWhenTainted: true,
      };
    },
    handler: async ({ input, context, contextLabel }) => {
      operatorOnly(context);
      const parsed = ProposeInputSchema.parse(input);
      // What the person approved was shown as a diff against the revision read: without that read, nothing was shown to approve.
      if (parsed.revision !== 0 && read.get(keyOf(context))?.revision !== parsed.revision)
        throw new TaviError(
          "CONFLICT",
          "Read the heartbeat (heartbeat.status) and propose against the revision it answers, so the change is shown as a diff",
        );
      const timezone = (await deps.repositories.workspaceSettings.get(context.workspaceId)).settings.timezone ?? hostTimeZone();
      const saved = await saveHeartbeatChange(
        { heartbeats: deps.repositories.heartbeats, options: deps.options, author: "chat", provenance: memoryProvenanceOf(contextLabel) },
        { workspaceId: context.workspaceId, principalId: context.principalId, timezone, now: deps.now() },
        (config) => proposed(config, parsed, deps.options),
        parsed.revision,
      );
      read.set(keyOf(context), saved.config);
      return {
        saved: true,
        revision: saved.config.revision,
        enabled: saved.config.enabled,
        ...(saved.nextTickAt === undefined ? {} : { nextCheck: saved.nextTickAt }),
      };
    },
  });
}
