import { randomUUID } from "node:crypto";

import {
  DEFAULT_WORKSPACE_ID,
  IDEA_CHIPS_MAX,
  IDEA_LABEL_MAX,
  IDEA_PREPARED_FRESH_MS,
  IDEA_PROMPT_MAX,
  IDEA_SNOOZE_MS,
  REMINDER_TEXT_MAX,
  TaviError,
  type Idea,
  type IdeaCapability,
  type IdeaLedger,
  type IdeasBriefAnswer,
  type IdeasChipsAnswer,
  type IdeasIdeaAnswer,
  type IdeasListAnswer,
  type IdeasPayload,
  type IdeasProviderView,
  type IdeasRecurAnswer,
  type IdeasRefreshAnswer,
  type IdeasRemindAnswer,
  type IdeasResetAnswer,
  type IdeasSettingsAnswer,
  type IdeasTryAnswer,
  type PersistencePort,
  keyedError,
  textRef,
} from "@tavi/contracts";
import { clip, definedOnly } from "@tavi/contracts/util";
import { DEFAULT_LOCALE, type Locale } from "@tavi/contracts/i18n";
import type { CoreKey, CoreT } from "@tavi/contracts/locales/core";

import { refusalFrom, type IpcAnswer } from "../../shared/ipc-decisions.js";
import { workspaceZone } from "../reminders/owner.js";
import { channelWords, workspaceLocaleOf } from "../channels/channel-words.js";

/**
 * `ideas`: a workspace's ideas — listed, tried,
 * given feedback, restored, pinned, turned into a routine draft or a
 * reminder, refreshed — and its provider, brief and settings. Nothing here
 * sends a message or starts a run: `try` hands back the prompt for the
 * composer, and `recur` hands back a draft for the routine's own approval.
 * Every rule about what is kept is the store's; this layer adds what
 * only the owner knows: the census, the providers installed, the host.
 */
export interface IdeasCommandDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "ideas" | "reminders" | "workspaceSettings">;
  /**
   * A built-in idea's words in `locale` (the catalogue's `ideaWordsIn`): one stored before a language change is shown
   * in the new one. Absent, ideas are shown as stored.
   */
  readonly ideaWords?: (idea: Idea, locale: Locale) => Pick<Idea, "title" | "label" | "pitch" | "prompt">;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly now: () => Date;
  /**
   * What Tavi can do here now: an idea using anything else is hidden
   * and `recur` needs `routines`. Absent offline, where nothing is checked.
   */
  readonly census?: (workspaceId: string) => Promise<readonly IdeaCapability[]>;
  /** The providers installed on this owner; absent offline, where only a choice already saved is kept. */
  readonly providers?: () => readonly IdeasProviderView[];
  /** Asks this owner's ideas host for a run now; absent while no host runs. */
  readonly refresh?: (workspaceId: string) => Promise<IdeasRefreshAnswer["status"]>;
  /** The person's latest chat whose summary is under three days old: the empty chat's "Continue" chip. */
  readonly continueChat?: (workspaceId: string) => Promise<{ readonly taskId: string; readonly title: string } | undefined>;
  /** Whether routine `routineId` is the operator's in the workspace: `made-recurring` names a routine that exists. */
  readonly routineExists?: (workspaceId: string, principalId: string, routineId: string) => Promise<boolean>;
  /** Whether the operator has a chat on a connection the digest can be sent to; absent offline, where it is not checked. */
  readonly digestReachable?: (workspaceId: string, principalId: string, connectionId: string) => Promise<boolean>;
  /** A chat's title, so a set-aside chat is named (Settings → Ideas); absent, it is named by id. */
  readonly chatTitle?: (workspaceId: string, taskId: string) => Promise<string | undefined>;
  /** Whether the workspace has a fast model, which words ideas for the person (the tab says when it has none). */
  readonly modelSet?: (workspaceId: string) => Promise<boolean>;
  /**
   * The request came from a page through the UI bridge: it may read
   * and steer, but not switch the provider or the digest, which send the
   * person's words somewhere new; those are the terminal's.
   */
  readonly fromBridge?: boolean;
  /** When the host's next scheduled run is due, if one runs. */
  readonly nextRunAt?: (workspaceId: string) => Promise<string | undefined>;
  /** A fresh id; a test pins it. */
  readonly newId?: () => string;
}

export type IdeasAnswer = IpcAnswer<
  | IdeasListAnswer
  | IdeasChipsAnswer
  | IdeasTryAnswer
  | IdeasIdeaAnswer
  | IdeasRecurAnswer
  | IdeasRemindAnswer
  | IdeasRefreshAnswer
  | IdeasBriefAnswer
  | IdeasSettingsAnswer
  | IdeasResetAnswer
>;

/**
 * The active ideas a person may still see: none whose key they dismissed or
 * snoozed, none resting on an excluded basis or in a muted section (the store
 * ends those as the signal lands; this also covers a row written meanwhile),
 * and none using what the census lacks. On the list (`keepPinnedMuted`), a
 * pinned idea in a muted section stays: the person pinned it, and must see it
 * to unpin it. Chips never offer one.
 */
function shown(
  listed: readonly Idea[],
  ledger: IdeaLedger,
  census: ReadonlySet<IdeaCapability> | undefined,
  keepPinnedMuted = false,
): Idea[] {
  return listed.filter(
    (idea) =>
      idea.status !== "active" ||
      (!ledger.dismissedKeys.includes(idea.key) &&
        !ledger.snoozedKeys.includes(idea.key) &&
        (!ledger.mutedCategories.includes(idea.category) || (keepPinnedMuted && idea.pinned)) &&
        !idea.basis.some((basis) => ledger.excludedBasis.includes(basis.ref)) &&
        (census === undefined || idea.uses.every((use) => census.has(use.capability)))),
  );
}

/**
 * The empty chat's chips when there are no ideas to offer: one per
 * capability the census has, never generic filler, in this order. Each
 * prompt's [part] is what the person fills in.
 */
const CAPABILITY_CHIPS: readonly { readonly capability: IdeaCapability; readonly label: CoreKey; readonly prompt: CoreKey }[] = [
  { capability: "web", label: "ideas.chip.web.label", prompt: "ideas.chip.web.prompt" },
  { capability: "calendar", label: "ideas.chip.calendar.label", prompt: "ideas.chip.calendar.prompt" },
  { capability: "mailbox", label: "ideas.chip.mailbox.label", prompt: "ideas.chip.mailbox.prompt" },
  { capability: "travel", label: "ideas.chip.travel.label", prompt: "ideas.chip.travel.prompt" },
  { capability: "places", label: "ideas.chip.places.label", prompt: "ideas.chip.places.prompt" },
  { capability: "reminders", label: "ideas.chip.reminders.label", prompt: "ideas.chip.reminders.prompt" },
  { capability: "pdf", label: "ideas.chip.pdf.label", prompt: "ideas.chip.pdf.prompt" },
  { capability: "browser", label: "ideas.chip.browser.label", prompt: "ideas.chip.browser.prompt" },
  { capability: "memory", label: "ideas.chip.memory.label", prompt: "ideas.chip.memory.prompt" },
];

/** The capability chips the census allows, in the workspace's language; offline (no census), none is claimed. */
function capabilityChips(
  census: ReadonlySet<IdeaCapability> | undefined,
  t: CoreT,
): readonly { readonly label: string; readonly prompt: string }[] {
  if (census === undefined) return [];
  return CAPABILITY_CHIPS.filter((chip) => census.has(chip.capability)).map((chip) => ({ label: t(chip.label), prompt: t(chip.prompt) }));
}

/**
 * A chat an idea's *Try it* started: linked to the idea with what was
 * sent. Ideas are the operator's: another person's message links
 * nothing.
 */
export async function ideaChatSeeded(
  deps: {
    readonly repositories: Pick<PersistencePort["repositories"], "ideas">;
    readonly principalOf: (workspaceId: string) => string | undefined;
    readonly now: () => Date;
    readonly newId?: () => string;
    /** The new chat's memory mode: a private or memory-off chat is never read, so it is never linked either. */
    readonly memoryModeOf: (taskId: string) => Promise<string | null | undefined>;
  },
  seed: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly ideaId: string;
    readonly taskId: string;
    readonly sent: string;
  },
): Promise<void> {
  if (deps.principalOf(seed.workspaceId) !== seed.principalId) return;
  // Its words would be kept as an example: a chat whose memory is off or private keeps none.
  const mode = await deps.memoryModeOf(seed.taskId);
  if (mode !== null && mode !== undefined) return;
  const { principalId: _principalId, ...link } = seed;
  await deps.repositories.ideas.seedChat({ ...link, id: `ifb-${(deps.newId ?? randomUUID)()}`, now: deps.now().toISOString() });
}

/** An idea's fresh prepared answer, for the first turn of the chat its *Try it* starts: the operator's own, under a day old. */
export async function ideaPreparedAnswer(
  deps: {
    readonly repositories: Pick<PersistencePort["repositories"], "ideas">;
    readonly principalOf: (workspaceId: string) => string | undefined;
    readonly now: () => Date;
  },
  workspaceId: string,
  principalId: string,
  ideaId: string,
): Promise<{ readonly title: string; readonly text: string } | undefined> {
  if (deps.principalOf(workspaceId) !== principalId) return undefined;
  const idea = await deps.repositories.ideas.get(workspaceId, ideaId);
  const prepared = idea?.prepared;
  if (idea === undefined || prepared === undefined || deps.now().getTime() - Date.parse(prepared.at) >= IDEA_PREPARED_FRESH_MS)
    return undefined;
  return { title: idea.title, text: prepared.text };
}

/** A chat's turn ended: when it finished without failure, the idea that started it is done. */
export async function ideaChatEnded(
  repositories: Pick<PersistencePort["repositories"], "ideas" | "tasks">,
  taskId: string,
  id: string,
  now: string,
): Promise<void> {
  if ((await repositories.tasks.get(taskId))?.status !== "completed") return;
  await repositories.ideas.chatFinished(taskId, id, now);
}

/** The providers as the command shows them: what each receives and whether it is ready. */
export function ideasProviderViews(
  entries: readonly {
    readonly id: string;
    readonly kind: "builtin" | "plugin";
    readonly receives: readonly IdeasProviderView["receives"][number][];
    readonly ready: boolean;
    readonly disclosure?: string;
  }[],
): readonly IdeasProviderView[] {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    receives: [...entry.receives],
    ready: entry.ready,
    ...(entry.disclosure === undefined ? {} : { disclosure: entry.disclosure }),
  }));
}

export async function ideasCommand(deps: IdeasCommandDependencies, payload: IdeasPayload): Promise<IdeasAnswer> {
  try {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const operator = deps.principalOf(workspaceId);
    if (operator === undefined) {
      throw keyedError("NOT_FOUND", "error.workspace.notConfigured", { workspaceId }, { details: { workspaceId } });
    }
    const ideas = deps.repositories.ideas;
    const now = deps.now();
    const stamp = now.toISOString();
    const newId = deps.newId ?? (() => randomUUID());
    const census = async (): Promise<ReadonlySet<IdeaCapability> | undefined> =>
      deps.census === undefined ? undefined : new Set(await deps.census(workspaceId));
    /** An idea of this workspace, or `NOT_FOUND` — another workspace's is not said to exist. */
    const inWorkspace = async (ideaId: string): Promise<Idea> => {
      const idea = await ideas.get(workspaceId, ideaId);
      if (idea === undefined) throw keyedError("NOT_FOUND", "error.idea.notFound", { ideaId });
      return idea;
    };
    const feedback = async (fields: Omit<Parameters<typeof ideas.feedback>[0], "id" | "workspaceId" | "now">) =>
      await ideas.feedback({ id: `ifb-${newId()}`, workspaceId, now: stamp, ...fields });

    /**
     * A built-in idea in the workspace's language: one stored before a language change still has the catalogue's words
     * in the old one. One a provider wrote or reworded is shown as written.
     */
    const inLanguage = async (): Promise<(idea: Idea) => Idea> => {
      const wordsOf = deps.ideaWords;
      if (wordsOf === undefined) return (idea) => idea;
      const locale = await workspaceLocaleOf(deps.repositories.workspaceSettings)(workspaceId).catch(() => DEFAULT_LOCALE);
      return (idea) => ({ ...idea, ...wordsOf(idea, locale) });
    };

    switch (payload.action) {
      case "list": {
        const [listed, ledger, lastRun, { settings }, checked, excludedSources] = await Promise.all([
          ideas.list({
            workspaceId,
            now: stamp,
            ...(payload.category === undefined ? {} : { category: payload.category }),
            ...(payload.includeInactive === undefined ? {} : { includeInactive: payload.includeInactive }),
          }),
          ideas.ledger(workspaceId, stamp),
          ideas.lastRun(workspaceId),
          ideas.settings(workspaceId),
          census(),
          ideas.excludedSources(workspaceId, stamp),
        ]);
        const [nextAt, modelSet] = await Promise.all([deps.nextRunAt?.(workspaceId), deps.modelSet?.(workspaceId)]);
        return {
          ok: true,
          result: {
            ideas: shown(listed, ledger, checked, true).map(await inLanguage()),
            mutedCategories: [...ledger.mutedCategories],
            excludedBasis: [...ledger.excludedBasis],
            excludedSources: await Promise.all(
              excludedSources.map(async (source) => {
                const title = source.kind === "task" ? await deps.chatTitle?.(workspaceId, source.ref) : undefined;
                return title === undefined ? source : { ...source, title: title.slice(0, 200) };
              }),
            ),
            enabled: settings.enabled,
            ...definedOnly({
              lastRun,
              nextAt,
              modelSet,
            }),
            provider: settings.provider,
            providers: [...(deps.providers?.() ?? [])],
          },
        };
      }
      case "chips": {
        // Off in Settings → Ideas: no chips at all. Ideas off, or none to offer: chips for what Tavi can do here.
        const { settings } = await ideas.settings(workspaceId);
        if (!settings.chips) return { ok: true, result: { chips: [] } };
        const limit = payload.limit ?? IDEA_CHIPS_MAX;
        const [listed, ledger, checked, latest] = await Promise.all([
          settings.enabled ? ideas.list({ workspaceId, now: stamp }) : [],
          ideas.ledger(workspaceId, stamp),
          census(),
          // A chat is read for Continue only while ideas may read chats, as the host reads them.
          settings.sources.tasks ? deps.continueChat?.(workspaceId) : undefined,
        ]);
        const offered = shown(listed, ledger, checked)
          .slice(0, limit)
          .map(await inLanguage())
          .map((idea) => ({ ideaId: idea.id, label: idea.label, prompt: idea.prompt, uses: idea.uses }));
        // Tavi's own chips speak the workspace's language: the label, and the prompt the person sends as their own.
        const t = await channelWords(workspaceLocaleOf(deps.repositories.workspaceSettings), workspaceId);
        const chips = offered.length > 0 ? offered : capabilityChips(checked, t).slice(0, limit);
        // The Continue chip comes first and counts toward the three.
        const continuing =
          latest === undefined || ledger.excludedBasis.includes(latest.taskId)
            ? []
            : [
                {
                  taskId: latest.taskId,
                  label: clip(t("ideas.chip.continue.label", { title: latest.title }), IDEA_LABEL_MAX),
                  prompt: clip(t("ideas.chip.continue.prompt", { title: latest.title }), IDEA_PROMPT_MAX),
                },
              ];
        return { ok: true, result: { chips: [...continuing, ...chips].slice(0, limit) } };
      }
      case "try": {
        const idea = await inWorkspace(payload.id);
        const tried = (await inLanguage())((await feedback({ ideaId: idea.id, signal: "tried" })) ?? idea);
        return { ok: true, result: { prompt: tried.prompt, idea: tried } };
      }
      case "feedback": {
        const idea = payload.id === undefined ? undefined : await inWorkspace(payload.id);
        const current = await feedback({
          signal: payload.signal,
          ...(idea === undefined ? {} : { ideaId: idea.id }),
          ...(payload.category === undefined ? {} : { category: payload.category }),
          ...(payload.basisRef === undefined ? {} : { basisRef: payload.basisRef }),
          ...(payload.signal === "not-now" ? { snoozedUntil: new Date(now.getTime() + IDEA_SNOOZE_MS).toISOString() } : {}),
        });
        return { ok: true, result: current === undefined ? {} : { idea: current } };
      }
      case "restore":
        return { ok: true, result: { idea: await ideas.restore(workspaceId, (await inWorkspace(payload.id)).id, stamp) } };
      case "pin":
      case "unpin": {
        const idea = await inWorkspace(payload.id);
        return { ok: true, result: { idea: await ideas.setPinned(workspaceId, idea.id, payload.action === "pin", stamp) } };
      }
      case "recur": {
        const idea = await inWorkspace(payload.id);
        if (idea.recurring === undefined) throw keyedError("INVALID_INPUT", "error.idea.notRepeatingTryOnce", { ideaId: idea.id });
        // Routines repeat daily or on chosen weekdays: a monthly idea is not drafted as something it is not.
        if (idea.recurring.cadence === "monthly") throw keyedError("UNAVAILABLE", "error.idea.routineNotMonthly");
        if (idea.status !== "active" && idea.status !== "tried")
          throw keyedError("CONFLICT", "error.idea.wrongStatus", { ideaId: idea.id, status: textRef(`error.idea.status.${idea.status}`) });
        const checked = await census();
        if (checked !== undefined && !checked.has("routines")) throw keyedError("UNAVAILABLE", "error.idea.routinesUnavailable");
        return { ok: true, result: { draft: { name: idea.label, prompt: idea.prompt, cadence: idea.recurring.cadence } } };
      }
      case "made-recurring": {
        const idea = await inWorkspace(payload.id);
        if (idea.recurring === undefined) throw keyedError("INVALID_INPUT", "error.idea.notRepeating", { ideaId: idea.id });
        // Done only for a routine that exists: a page cannot close an idea by naming one it did not make.
        if (deps.routineExists === undefined) throw new TaviError("UNAVAILABLE", "Routines are not checked on this owner");
        if (!(await deps.routineExists(workspaceId, operator, payload.routineId)))
          throw keyedError("NOT_FOUND", "error.routine.notFound", { routineId: payload.routineId });
        const done = await feedback({ ideaId: idea.id, signal: "done" });
        return { ok: true, result: done === undefined ? {} : { idea: done } };
      }
      case "remind": {
        const idea = (await inLanguage())(await inWorkspace(payload.id));
        if (idea.status !== "active" && idea.status !== "tried")
          throw keyedError("CONFLICT", "error.idea.wrongStatus", { ideaId: idea.id, status: textRef(`error.idea.status.${idea.status}`) });
        const checked = await census();
        if (checked !== undefined && !checked.has("reminders")) throw keyedError("UNAVAILABLE", "error.idea.remindersUnavailable");
        // Said, never run: the reminder carries the idea's words, and the person starts it from the chat if they want.
        const said = `${idea.label}: ${idea.prompt}`;
        const created = await deps.repositories.reminders.create({
          reminderId: `rem-${newId()}`,
          workspaceId,
          principalId: operator,
          text: clip(said, REMINDER_TEXT_MAX),
          when: { kind: "once", at: payload.at },
          timezone: await workspaceZone(deps, workspaceId),
          deliverTo: { kind: "app" },
          createdBy: "user",
          operationKey: `idea:${idea.id}:${payload.at}`,
          now: stamp,
        });
        return { ok: true, result: { reminderId: created.reminder.reminderId } };
      }
      case "refresh":
        // At most `IDEA_REFRESH_PER_HOUR` an hour: counted by the store in the transaction that starts the run (QUOTA_EXCEEDED).
        if (deps.refresh === undefined) throw keyedError("UNAVAILABLE", "error.idea.noHost");
        return { ok: true, result: { status: await deps.refresh(workspaceId) } };
      case "brief":
        return { ok: true, result: { text: (await ideas.settings(workspaceId)).brief } };
      case "set-brief": {
        const before = (await ideas.settings(workspaceId)).brief;
        const saved = await ideas.saveSettings({ workspaceId, brief: payload.text, now: stamp });
        // Ideas quoting the old brief stop quoting it: what they quoted is no longer what the person asks for.
        if (saved.brief !== before) await ideas.unquote({ workspaceId, ref: "brief", now: stamp });
        return { ok: true, result: { text: saved.brief } };
      }
      case "settings":
        return { ok: true, result: { settings: (await ideas.settings(workspaceId)).settings } };
      case "set-settings": {
        const { settings: current } = await ideas.settings(workspaceId);
        const { changes } = payload;
        // A page steers; it does not change where ideas go or what they may spend: those are the terminal's.
        if (
          deps.fromBridge === true &&
          ((changes.provider !== undefined && changes.provider !== current.provider) ||
            changes.digest !== undefined ||
            changes.dailyTokens !== undefined ||
            changes.prepareExternal !== undefined ||
            changes.hours !== undefined)
        ) {
          throw keyedError("NOT_AUTHORIZED", "error.idea.pageCannotChange");
        }
        // The digest goes only to the operator's own chat on a connection of this workspace: one with none is refused now, not skipped each week.
        if (
          changes.digest !== undefined &&
          changes.digest !== null &&
          deps.digestReachable !== undefined &&
          !(await deps.digestReachable(workspaceId, operator, changes.digest.channel))
        ) {
          throw keyedError("NOT_FOUND", "error.idea.digestUnreachable", { channel: changes.digest.channel });
        }
        if (changes.provider !== undefined && changes.provider !== current.provider) {
          const installed = deps.providers?.();
          if (installed === undefined)
            throw new TaviError("UNAVAILABLE", "The ideas provider is chosen on a running owner, which knows what is installed");
          if (!installed.some((provider) => provider.id === changes.provider)) {
            throw new TaviError(
              "NOT_FOUND",
              `No ideas provider ${changes.provider} is installed here; installed: ${installed.map((provider) => provider.id).join(", ") || "none"}`,
            );
          }
        }
        // A patch, merged in the store's transaction: the host's own notes (volume, the digest sent) are never written back stale.
        const patch = {
          ...definedOnly({
            enabled: changes.enabled,
            provider: changes.provider,
            chips: changes.chips,
            prepareExternal: changes.prepareExternal,
            dailyTokens: changes.dailyTokens,
            hours: changes.hours,
          }),
          ...(changes.sources === undefined
            ? {}
            : {
                sources: Object.fromEntries(
                  Object.entries(changes.sources).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
                ),
              }),
          ...(changes.digest === undefined || changes.digest === null ? {} : { digest: changes.digest }),
          // A switch to another provider turns prepareExternal off, unless set with it: it was granted to the last one.
          ...(changes.provider !== undefined && changes.provider !== current.provider && changes.prepareExternal === undefined
            ? { prepareExternal: false }
            : {}),
        };
        // The last send stays recorded whatever is set: it keeps the digest to once a week, and a reply picks
        // from it only while the digest still goes to its connection, so turned off or moved, it picks nothing.
        const clear = changes.digest === null ? (["digest"] as const) : [];
        const saved = await ideas.saveSettings({ workspaceId, patch, ...(clear.length === 0 ? {} : { clear }), now: stamp });
        const next = saved.settings;
        // A source switched off is no longer quoted: ideas citing it end, and the rest drop its words.
        const kinds = { memory: "memory", tasks: "task", brief: "brief" } as const;
        for (const source of ["memory", "tasks", "brief"] as const) {
          if (current.sources[source] && !next.sources[source]) await ideas.unquote({ workspaceId, kind: kinds[source], now: stamp });
        }
        // A new provider's ideas replace the old one's: what the person pinned stays.
        if (next.provider !== current.provider) await ideas.retireProvider(workspaceId, next.provider, stamp);
        return { ok: true, result: { settings: saved.settings } };
      }
      case "reset":
        return { ok: true, result: { cleared: await ideas.reset({ workspaceId, what: payload.what, now: stamp }) } };
    }
  } catch (error) {
    return refusalFrom(error);
  }
}
