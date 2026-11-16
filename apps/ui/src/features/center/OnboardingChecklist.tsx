import {
  IDEA_FRESH_AFTER_SETUP_MS,
  fastModelFailure,
  ONBOARDING_REQUIRED_STEPS,
  type OnboardingFlowAnswer,
  type OnboardingStatus,
  type OnboardingStepKind,
  SERVICE_SETUP_COMMAND,
  modelUnverified,
} from "@tavi/contracts";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Failure } from "../../ui/Parts.js";
import { listIdeas } from "../ideas/ideas-api.js";
import { dismissOnboarding, loadFlow, loadStatus, ONBOARDING_CHANGED_EVENT } from "../welcome/onboarding-api.js";
import { getHeartbeatOffer } from "./heartbeat-api.js";
import { Button } from "../../ui/Button.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Command } from "../../ui/Command.js";

/**
 * Setup's checklist card on Home, in
 * the heartbeat offer's slot: one proactive card at a time. It lists the open
 * steps, one action each (Welcome at that step), with *Continue setup* and
 * Dismiss, and goes when nothing is open or it was dismissed; a dismissed card
 * comes back once with only the steps a newer flow adds. While a
 * required step is open it comes first and a due heartbeat offer waits; with
 * only optional steps open, a due offer takes the slot, and the checklist
 * returns once it is answered. Status is read again after each action, when
 * the window regains focus, and when a connect sheet closes anywhere.
 * A card back for a newer flow's steps continues at the first of them; one
 * whose flow plugin was not used says why.
 *
 * Once setup is finished, and until the Ideas run it promised has looked, it
 * says when ideas will be ready: "Tomorrow morning I'll have ideas for
 * you". Nothing is pushed.
 */

/**
 * When the promised ideas come, in words, by the workspace's calendar days:
 * later today, tomorrow (morning when the run is before noon there), or soon.
 */
export function promiseWords(nextAt: string, now: Date, timeZone?: string): string {
  const parts = (date: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  // A calendar day as a number of days, so "tomorrow" is the next date there whatever a clock change did.
  const dayNumber = (date: Date) => {
    const p = parts(date);
    return Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"])) / 86_400_000;
  };
  const next = new Date(nextAt);
  const days = dayNumber(next) - dayNumber(now);
  if (days <= 0) return "Later today I'll have new ideas for you.";
  if (days === 1)
    return Number(parts(next)["hour"]) < 12 ? "Tomorrow morning I'll have ideas for you." : "Tomorrow I'll have ideas for you.";
  return "Soon I'll have ideas for you.";
}

/** A row's words: the step's own detail, and where a step this canvas cannot do is done. */
function rowDetail(step: OnboardingStatus["steps"][number] | undefined): string {
  if (step === undefined) return "";
  if (step.elsewhere !== "cli") return step.detail;
  // Installing the service is a terminal's: channels and schedules stop with `tavi serve` until it is done.
  const where = `in a terminal: ${step.kind === "service" ? SERVICE_SETUP_COMMAND : "tavi onboard"}`;
  return step.detail === "" ? where : `${step.detail} · ${where}`;
}

interface Loaded {
  readonly flow: OnboardingFlowAnswer;
  readonly status: OnboardingStatus;
  readonly offerDue: boolean;
  /** The promised ideas' words, while they are still to come. */
  readonly promise?: string | undefined;
}

/** The clock, one function for every render: a new one each time would read setup again on every render. */
const CLOCK = (): Date => new Date();

export function OnboardingChecklist({
  offer,
  ideas = false,
  now = CLOCK,
  onOpenStep,
}: {
  /** The owner offers Ideas: after setup, Home says when the first ones come. */
  readonly ideas?: boolean;
  readonly now?: () => Date;
  /** The heartbeat's first-run offer, when Home may show it; it renders nothing unless due. */
  readonly offer?: ((onDone: () => void) => ReactNode) | undefined;
  /** Welcome at `stepId`, or at the first open step. */
  readonly onOpenStep: (stepId?: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded>();
  /** The onboarding reads failed: the slot is the offer's alone. */
  const [unread, setUnread] = useState<{ readonly offerDue: boolean }>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  /** The flow, read once: it changes with a release, not a focus. */
  const once = useRef<Promise<OnboardingFlowAnswer | undefined> | undefined>(undefined);
  const offers = offer !== undefined;
  const load = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    once.current ??= loadFlow(client, workspaceId).then((flow) => (flow.ok ? flow.value : undefined));
    const [flow, status, heartbeat] = await Promise.all([
      once.current,
      loadStatus(client, workspaceId),
      offers ? getHeartbeatOffer(client, workspaceId) : Promise.resolve(undefined),
    ]);
    if (mine !== generation.current) return;
    const offerDue = heartbeat?.ok === true && heartbeat.value.offer !== undefined;
    if (flow === undefined || !status.ok) {
      // A flow that cannot be read again later is read again on the next focus.
      if (flow === undefined) once.current = undefined;
      setUnread({ offerDue });
      return;
    }
    let promise: string | undefined;
    const completedAt = status.value.completedAt;
    if (ideas && completedAt !== undefined && now().getTime() - Date.parse(completedAt) < IDEA_FRESH_AFTER_SETUP_MS) {
      const listed = await listIdeas(client, workspaceId);
      if (mine !== generation.current) return;
      const answer = listed.ok ? listed.value : undefined;
      // Kept until a run that started after setup brought new ideas, as the ideas host keeps its side.
      const kept =
        answer?.lastRun !== undefined &&
        answer.lastRun.outcome === "generated" &&
        Date.parse(answer.lastRun.startedAt) > Date.parse(completedAt);
      if (answer !== undefined && answer.enabled !== false && answer.nextAt !== undefined && !kept)
        promise = promiseWords(answer.nextAt, now(), timeZone);
    }
    setUnread(undefined);
    setLoaded({ flow, status: status.value, offerDue, promise });
  }, [client, workspaceId, offers, ideas, timeZone, now]);
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    // An app connected or a connect sheet closed anywhere on the page.
    window.addEventListener(ONBOARDING_CHANGED_EVENT, onFocus);
    return () => {
      generation.current += 1;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ONBOARDING_CHANGED_EVENT, onFocus);
    };
  }, [load]);
  if (loaded === undefined && unread !== undefined) return offer !== undefined && unread.offerDue ? offer(() => void load()) : null;
  if (loaded === undefined) return null;
  const { flow, status } = loaded;
  const kinds: readonly OnboardingStepKind[] = status.returning ?? (status.dismissedAt === undefined ? status.open : []);
  const requiredOpen = kinds.some((kind) => ONBOARDING_REQUIRED_STEPS.includes(kind));
  // One proactive card: the offer has the slot unless a required step is open.
  if (offer !== undefined && loaded.offerDue && !requiredOpen) return <>{offer(() => void load())}</>;
  const listed = kinds
    .map((kind) => ({
      kind,
      step: flow.flow.steps.find((step) => step.kind === kind),
      title: undefined as string | undefined,
      detail: rowDetail(status.steps.find((step) => step.kind === kind)),
    }))
    .filter((row) => row.step !== undefined);
  // A failed fast model leaves the model step done, but Ideas and summaries run on it.
  const fastAdvice = status.dismissedAt === undefined ? fastModelFailure(status.steps.find((step) => step.kind === "model")) : undefined;
  const fastStep = flow.flow.steps.find((step) => step.kind === "model");
  // A model set up but not checked yet: done, with one row to check it.
  const modelStatus = status.dismissedAt === undefined ? status.steps.find((step) => step.kind === "model") : undefined;
  const verify =
    modelUnverified(modelStatus) && fastStep !== undefined
      ? [
          {
            kind: "model" as const,
            step: fastStep,
            title: "Verify the model",
            detail: modelStatus?.detail.split(" · ").slice(0, 2).join(" · ") ?? "",
          },
        ]
      : [];
  const rows = [
    ...(fastAdvice === undefined || fastStep === undefined
      ? []
      : [{ kind: "model" as const, step: fastStep, title: "Fix the fast model", detail: fastAdvice }]),
    ...verify,
    ...listed,
  ];
  if (rows.length === 0) {
    return loaded.promise === undefined ? null : (
      <section className="section-card onboarding-promise" aria-label="Ideas">
        <p>{loaded.promise}</p>
      </section>
    );
  }
  // Back for a newer flow, it continues at the first step it lists, not the first open one.
  const continueAt = status.returning === undefined ? undefined : listed[0]?.step?.id;
  const fallback = flow.fallback ?? status.flowFallback;
  const total = status.steps.filter((step) => step.state !== "unavailable").length;
  const done = status.steps.filter((step) => step.state === "done").length;
  const dismiss = async (): Promise<void> => {
    setBusy(true);
    // A read already on its way answers from before the dismissal: it is dropped.
    generation.current += 1;
    const answer = await dismissOnboarding(client, workspaceId);
    setBusy(false);
    if (!answer.ok) return setFailure(answer.message);
    setLoaded({ ...loaded, status: answer.value });
  };
  return (
    <section className="section-card onboarding-checklist" aria-labelledby={`${ids}-title`}>
      <h2 className="center-subhead" id={`${ids}-title`}>
        Setup checklist{" "}
        <span className="meta-sm">
          {done} of {total}
        </span>
      </h2>
      {loaded.promise === undefined ? null : <p>{loaded.promise}</p>}
      {fallback === undefined ? null : (
        <p className="meta-sm onboarding-fallback" role="status">
          Setup is showing Tavi's own steps: {fallback}
        </p>
      )}
      {status.returning === undefined ? null : <p className="meta-sm">New in this version of setup:</p>}
      {status.providerId === null ? (
        <p className="meta-sm">
          Guided setup is turned off here: run <Command>tavi onboard</Command> for the command for each step.
        </p>
      ) : null}
      <ul className="list-reset onboarding-checklist-rows">
        {rows.map((row) => (
          <li key={row.kind}>
            <Button variant="link" onClick={() => onOpenStep(row.step?.id)}>
              {row.title ?? row.step?.title}
            </Button>
            {row.detail === "" ? null : <span className="meta-sm"> — {row.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="heartbeat-actions cluster">
        <Button size="sm" onClick={() => onOpenStep(continueAt)}>
          Continue setup
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
      <Failure message={failure} />
    </section>
  );
}
