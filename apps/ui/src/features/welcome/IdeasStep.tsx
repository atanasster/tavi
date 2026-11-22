import {
  FAST_MODEL_FAILED,
  IDEA_CAPABILITY_LABELS,
  IDEA_PRESET_CAPABILITIES,
  type IdeaCapability,
  type IdeaChip,
  type OnboardingFlowStep,
  type OnboardingStatus,
} from "@tavi/contracts";
import { useEffect, useRef, useState } from "react";

import { ideaChips, ideasSettings, refreshIdeas, tryIdea } from "../ideas/ideas-api.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { Notice, Pending } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";

/**
 * Setup's ideas step: "Here's what I
 * can do now". The chips show at once from `ideas chips` (ideas when there
 * are any, else what the census proves); `ideas refresh` runs in the
 * background, skipped when the fast model failed its verify, and the chips
 * upgrade in place when new ones arrive, announced politely and never moving
 * focus. With Ideas off or not offered, the flow's own prompts show and
 * nothing is refreshed. A chip only fills a new chat's composer: nothing here
 * sends a message.
 */

/** How often the step reads the chips again while the refresh runs, and for how long. */
export const CHIPS_REREAD_MS = 3_000;
export const CHIPS_WATCH_MS = 120_000;
/** The top of the chips. */
const SHOWN = 3;

/** The capability each app brings, for "New with <app>": the census's presets, and a mailbox app's, by its own id. */
const APP_CAPABILITY: Readonly<Record<string, IdeaCapability>> = { ...IDEA_PRESET_CAPABILITIES, gmail: "mailbox" };

/** The ids of the apps the status's apps step lists as connected. */
export function connectedApps(status: OnboardingStatus): ReadonlySet<string> {
  return new Set(
    (status.steps.find((step) => step.kind === "apps")?.items ?? []).filter((item) => item.state === "connected").map((item) => item.id),
  );
}

/**
 * The apps connected during this setup — connected now and not in `before`,
 * what was connected when Welcome opened — by the capability each brings: what
 * a chip using one is new with. With `before` unknown, none is.
 */
export function newCapabilities(status: OnboardingStatus, before: ReadonlySet<string> | undefined): ReadonlyMap<IdeaCapability, string> {
  const unlocked = new Map<IdeaCapability, string>();
  if (before === undefined) return unlocked;
  for (const item of status.steps.find((step) => step.kind === "apps")?.items ?? []) {
    const capability = APP_CAPABILITY[item.id];
    if (item.state === "connected" && !before.has(item.id) && capability !== undefined) unlocked.set(capability, item.label);
  }
  return unlocked;
}

const sameChips = (a: readonly IdeaChip[], b: readonly IdeaChip[]): boolean =>
  a.length === b.length && a.every((chip, index) => chip.ideaId === b[index]?.ideaId && chip.label === b[index]?.label);

export interface IdeasStepProps {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly step: OnboardingFlowStep;
  readonly status: OnboardingStatus;
  /** The apps connected when setup opened (`connectedApps` then): only one connected since is "New with". */
  readonly connectedBefore: ReadonlySet<string> | undefined;
  /** A new chat with `prompt` in its composer, never sent; `ideaId` when the owner marked that idea tried. */
  readonly onTry: (prompt: string, ideaId?: string) => void;
}

export function IdeasStep(props: IdeasStepProps) {
  const { client, workspaceId } = props;
  const t = useT();
  const [chips, setChips] = useState<readonly IdeaChip[]>();
  const [announce, setAnnounce] = useState<string>();
  const [picking, setPicking] = useState(false);
  // Still on screen, for a pick that answers late.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The fast model failed its verify: a refresh would only fail too.
  const fastFailed = props.status.steps.find((step) => step.kind === "model")?.detail.includes(FAST_MODEL_FAILED) === true;
  const fallback = (props.step.prompts ?? []).map((prompt) => ({ label: prompt.label, prompt: prompt.prompt }));
  useEffect(() => {
    // Each run its own: a run StrictMode (or a new workspace) left behind sends nothing more.
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const [settings, first] = await Promise.all([ideasSettings(client, workspaceId), ideaChips(client, workspaceId)]);
      if (!live) return;
      // Ideas off or not offered: the flow's prompts, and onboarding never turns Ideas back on.
      if (!settings.ok || !settings.value.settings.enabled || !first.ok) return setChips(fallback);
      const shown = first.value.chips.filter((chip) => chip.taskId === undefined).slice(0, SHOWN);
      setChips(shown.length > 0 ? shown : fallback);
      if (fastFailed) return;
      const refreshed = await refreshIdeas(client, workspaceId);
      if (!live || !refreshed.ok) return;
      const until = Date.now() + CHIPS_WATCH_MS;
      // The refresh says nothing when it ends: the chips are read again until they change, or for two minutes.
      const reread = async (): Promise<void> => {
        const again = await ideaChips(client, workspaceId);
        if (!live) return;
        const next = again.ok ? again.value.chips.filter((chip) => chip.taskId === undefined).slice(0, SHOWN) : [];
        if (next.length > 0 && !sameChips(next, shown)) {
          setChips(next);
          setAnnounce(translateNow("welcome.ideas.newIdeas"));
          return;
        }
        if (Date.now() < until) timer = setTimeout(() => void reread(), CHIPS_REREAD_MS);
      };
      timer = setTimeout(() => void reread(), CHIPS_REREAD_MS);
    })();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // The fallback is the flow's, read once with it; the fast model's state is read once on arrival.
  }, [client, workspaceId]);
  if (chips === undefined) return <Pending label={t("welcome.ideas.loading")} className="notice" status />;
  const unlocked = newCapabilities(props.status, props.connectedBefore);
  const pick = async (chip: IdeaChip): Promise<void> => {
    if (picking) return;
    setPicking(true);
    // An idea's chip is its *Try it*: marked tried, linked only when the owner took it.
    const tried = chip.ideaId === undefined ? undefined : await tryIdea(client, workspaceId, chip.ideaId);
    if (!mounted.current) return;
    setPicking(false);
    props.onTry(chip.prompt, tried?.ok === true ? chip.ideaId : undefined);
  };
  return (
    <div className="welcome-ideas">
      {chips.length === 0 ? (
        <Notice>{t("welcome.ideas.none")}</Notice>
      ) : (
        <ul className="welcome-cards">
          {chips.map((chip) => {
            const uses = chip.uses ?? [];
            const fresh = uses.map((use) => unlocked.get(use.capability)).find((label) => label !== undefined);
            const capabilities = uses.map((use) => IDEA_CAPABILITY_LABELS[use.capability]).join(" · ");
            return (
              <li key={chip.ideaId ?? chip.label} className="welcome-card">
                <h2>
                  {chip.label}
                  {fresh === undefined ? null : <span className="badge">{t("welcome.ideas.newWith", { app: fresh })}</span>}
                </h2>
                <p className="settings-description">{chip.prompt}</p>
                {uses.length === 0 ? null : (
                  <p className="settings-description">
                    <strong>{t("welcome.ideas.uses")}</strong>{" "}
                    {uses.some((use) => use.approval) ? t("welcome.ideas.usesAsking", { capabilities }) : capabilities}
                  </p>
                )}
                <div className="actions">
                  <Button
                    size="sm"
                    disabled={picking}
                    aria-label={t("welcome.ideas.tryLabel", { idea: chip.label })}
                    onClick={() => void pick(chip)}
                  >
                    {t("welcome.ideas.try")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce ?? ""}
      </p>
    </div>
  );
}
