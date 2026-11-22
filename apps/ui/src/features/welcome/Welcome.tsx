import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ONBOARDING_DONE_STEP_ID,
  onboardingStepDetail,
  SERVICE_SETUP_COMMAND,
  type OnboardingFlowAnswer,
  type OnboardingFlowStep,
  type OnboardingStatus,
} from "@tavi/contracts";

import { translateCore, useT } from "../../lib/i18n.js";
import { Icon } from "../../ui/Icon.js";
import { PluginFrame } from "../plugin-host/PluginFrame.js";
import { AppsStep, ChannelsStep } from "./ConnectSteps.js";
import { connectedApps, IdeasStep } from "./IdeasStep.js";
import { completeOnboarding, completeStep, dismissOnboarding, loadFlow, loadStatus, reachedStep, skipStep } from "./onboarding-api.js";
import { LanguageChoice } from "../settings/LanguageChoice.js";
import { AboutStep } from "./WelcomeAboutStep.js";
import { ModelStep } from "./WelcomeModelStep.js";
import { SearchStep } from "./WelcomeSearchStep.js";
import { TasksStep } from "./WelcomeTasksStep.js";
import { VoiceStep } from "./WelcomeVoiceStep.js";
import type { WelcomeProps, StepProps } from "./WelcomeStepParts.js";
import { withParts } from "../../ui/with-parts.js";
import { Failure, Notice, Pending } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";

/** The command that does a step only a terminal can (`elsewhere: "cli"`). */
const TERMINAL_COMMANDS: Partial<Record<OnboardingFlowStep["kind"], string>> = { service: SERVICE_SETUP_COMMAND };

/**
 * Welcome: the onboarding flow on the
 * canvas, one step at a time, each at `/welcome/<stepId>`. Only the model is
 * required; every other step can be skipped, and Do this later goes Home.
 * The stepper is an ordered list with `aria-current`; focus moves to each
 * step's heading; work in progress is announced in a polite live region.
 * The page writes through the owner's own commands, and a key goes to it
 * once, never shown again.
 */

export function Welcome(props: WelcomeProps) {
  const { client, workspaceId } = props;
  const t = useT();
  const [flow, setFlow] = useState<OnboardingFlowAnswer>();
  const [status, setStatus] = useState<OnboardingStatus>();
  const [failure, setFailure] = useState<string>();
  /**
   * The apps connected when this page first read the status: the ideas step's
   * "New with <app>" names only one connected since, during this setup.
   */
  const [appsAtStart, setAppsAtStart] = useState<ReadonlySet<string>>();
  const take = useCallback((read: OnboardingStatus): void => {
    setStatus(read);
    setAppsAtStart((before) => before ?? connectedApps(read));
  }, []);
  const refresh = useCallback(async () => {
    const read = await loadStatus(client, workspaceId);
    if (read.ok) take(read.value);
    else setFailure(read.message);
  }, [client, workspaceId, take]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [flowRead, statusRead] = await Promise.all([loadFlow(client, workspaceId), loadStatus(client, workspaceId)]);
      if (!live) return;
      if (!flowRead.ok) setFailure(flowRead.message);
      else setFlow(flowRead.value);
      if (statusRead.ok) take(statusRead.value);
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, take]);
  // Status is read again when the window regains focus: a step done in another tab or a terminal shows.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const steps = useMemo(() => {
    if (flow === undefined || status === undefined) return [];
    const stateOf = (kind: OnboardingFlowStep["kind"]) => status.steps.find((step) => step.kind === kind)?.state;
    // Every step that applies here, done ones too, checked in the rail: the count is over the whole flow.
    return flow.flow.steps.filter((step) => {
      const state = stateOf(step.kind);
      return state !== undefined && state !== "unavailable";
    });
  }, [flow, status]);
  const isDone = (candidate: OnboardingFlowStep): boolean => status?.steps.find((entry) => entry.kind === candidate.kind)?.state === "done";
  /** The first step after `from` still to do; -1 when none is (the closing words). */
  const openAfter = (from: number): number => steps.findIndex((candidate, at) => at > from && !isDone(candidate));
  // `done`: past the last step, the flow's closing words (no step may take the id). No step named: the first
  // still to do (`?all=1`: the first of all), or the closing words when every one is done.
  const named = steps.findIndex((step) => step.id === props.stepId);
  const index = props.stepId === ONBOARDING_DONE_STEP_ID ? -1 : named >= 0 ? named : props.all === true ? 0 : openAfter(-1);
  const step = index < 0 ? undefined : steps[index];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step?.id]);
  // The funnel's "reached", once a step is on screen; the owner counts a visit once.
  const shownKind = step?.kind;
  useEffect(() => {
    if (shownKind !== undefined) void reachedStep(client, workspaceId, shownKind);
  }, [client, workspaceId, shownKind]);
  // Opened on no step (the first-run redirect): the address names the one shown, so it stays shown once done.
  const onStep = props.onStep;
  useEffect(() => {
    if (props.stepId === undefined && step !== undefined) onStep(step.id, { replace: true });
  }, [props.stepId, step, onStep]);

  if (failure !== undefined && flow === undefined) return <Failure>{failure}</Failure>;
  if (flow === undefined || status === undefined) return <Pending label={t("welcome.page.loading")} className="notice" status />;
  const leave = (): void => props.onLeave();
  const neverAgain = async (): Promise<void> => {
    const dismissed = await dismissOnboarding(client, workspaceId);
    if (!dismissed.ok) return setFailure(t("welcome.page.notTurnedOff", { message: dismissed.message }));
    leave();
  };
  const refused = failure === undefined ? null : <Failure>{failure}</Failure>;
  // No flow is installed: no steps to walk here, only where setup goes on.
  if (status.providerId === null) {
    return (
      <div className="welcome-page">
        <section className="welcome welcome-solo" aria-labelledby="welcome-off">
          <h1 id="welcome-off" ref={heading} tabIndex={-1}>
            {t("welcome.off.title")}
          </h1>
          <p>{withParts(t("welcome.off.body"), { command: <Command>tavi onboard</Command> })}</p>
          <div className="actions">
            <Button variant="primary" onClick={leave}>
              {t("welcome.action.home")}
            </Button>
          </div>
        </section>
      </div>
    );
  }
  if (step === undefined) {
    return (
      <div className="welcome-page">
        <section className="welcome welcome-solo" aria-labelledby="welcome-done">
          <h1 id="welcome-done" ref={heading} tabIndex={-1}>
            {flow.flow.done.title}
          </h1>
          <p>{flow.flow.done.body}</p>
          <div className="actions">
            <Button
              variant="primary"
              onClick={() => void completeOnboarding(client, workspaceId).then((done) => (done.ok ? leave() : setFailure(done.message)))}
            >
              {t("welcome.action.home")}
            </Button>
          </div>
          {refused}
        </section>
      </div>
    );
  }
  const stepStatus = status.steps.find((candidate) => candidate.kind === step.kind);
  // On to the next step still to do — a done one is there to revisit, never forced — or, walking every step
  // (`?all=1`), the next one.
  const onward = (): string => steps[props.all === true ? index + 1 : openAfter(index)]?.id ?? ONBOARDING_DONE_STEP_ID;
  const next = (): void => {
    void refresh();
    props.onStep(onward());
  };
  const skip = async (): Promise<void> => {
    const skipped = await skipStep(client, workspaceId, step.kind);
    if (!skipped.ok) return setFailure(t("welcome.page.notSkipped", { message: skipped.message }));
    setFailure(undefined);
    setStatus(skipped.value);
    props.onStep(onward());
  };
  const modelOpen = status.steps.find((candidate) => candidate.kind === "model")?.state !== "done";
  // Why the selected flow plugin's steps are not the ones shown: said politely, never blocking.
  const fallback = flow.fallback ?? status.flowFallback;
  const canBack = index > 0;
  // Skip until the step's own action is done, Continue once it is: never both, so neither means the other.
  const canSkip = step.optional && stepStatus?.state !== "done";
  const canContinue = stepStatus?.state === "done";
  return (
    <div className="welcome-page">
      <section className="welcome" aria-labelledby="welcome-step">
        <header className="welcome-rail">
          <p className="welcome-title">{flow.flow.title}</p>
          <p className="welcome-progress meta-sm">
            {t("welcome.rail.progress", { done: steps.filter(isDone).length, total: steps.length })}
          </p>
          <ol className="welcome-stepper list-reset" aria-label={t("welcome.rail.steps")}>
            {steps.map((candidate, at) => (
              <li key={candidate.id} aria-current={at === index ? "step" : undefined} className={at === index ? "current" : undefined}>
                <Button
                  className={isDone(candidate) ? "welcome-step done" : "welcome-step"}
                  disabled={candidate.kind !== "model" && modelOpen}
                  onClick={() => props.onStep(candidate.id)}
                >
                  <span className="welcome-step-mark" aria-hidden="true">
                    {isDone(candidate) ? <Icon name="check" size="sm" /> : String(at + 1)}
                  </span>{" "}
                  <span className="welcome-step-label">{candidate.title}</span>
                  {isDone(candidate) ? <span className="visually-hidden"> {t("welcome.rail.done")}</span> : null}
                </Button>
              </li>
            ))}
          </ol>
          <LanguageChoice client={client} workspaceId={workspaceId} compact suggest />
        </header>
        <div className="welcome-main">
          {fallback === undefined ? null : (
            <Notice className="welcome-fallback" role="status">
              {t("welcome.panel.fallback", { reason: fallback })}
            </Notice>
          )}
          <div className="welcome-panel">
            <p className="eyebrow">
              {t(step.optional ? "welcome.panel.stepOptional" : "welcome.panel.step", { step: index + 1, total: steps.length })}
            </p>
            <h1 id="welcome-step" ref={heading} tabIndex={-1}>
              {step.title}
            </h1>
            {/* Each line of the owner's text is a paragraph of its own, the panel's gap apart, not a bare line break. */}
            {step.body
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((line) => (
                <p key={line} className="welcome-body">
                  {line}
                </p>
              ))}
            {stepStatus !== undefined && stepStatus.detail !== "" && stepStatus.state !== "todo" ? (
              <p className={stepStatus.state === "done" ? "welcome-state done" : "welcome-state"}>
                {stepStatus.state === "done" ? <Icon name="check" size="sm" /> : null}
                <span>{onboardingStepDetail(stepStatus, translateCore)}</span>
              </p>
            ) : null}
            {stepStatus?.elsewhere === "cli" ? (
              // Only a terminal can do it (installing the service): listed and counted here, with where it is done.
              <p className="welcome-body">
                {withParts(t("welcome.panel.terminal"), { command: <code>{TERMINAL_COMMANDS[step.kind] ?? "tavi onboard"}</code> })}
              </p>
            ) : (
              <StepBody
                {...props}
                step={step}
                status={status}
                providerId={flow.providerId}
                appsBefore={appsAtStart}
                onDone={next}
                onStatus={setStatus}
              />
            )}
            {canBack || canSkip || canContinue ? (
              <div className="welcome-nav">
                {canBack ? (
                  <Button variant="ghost" onClick={() => props.onStep(steps[index - 1]?.id)}>
                    {t("welcome.action.back")}
                  </Button>
                ) : null}
                <span className="welcome-nav-spacer" />
                {canSkip ? (
                  <Button variant="ghost" onClick={() => void skip()}>
                    {t("welcome.nav.skip")}
                  </Button>
                ) : null}
                {canContinue ? (
                  <Button variant="primary" onClick={next}>
                    {t("welcome.action.continue")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          {refused}
          <div className="welcome-later">
            <Button variant="link" onClick={leave}>
              {t("welcome.later.later")}
            </Button>
            <Button variant="link" onClick={() => void neverAgain()}>
              {t("welcome.later.never")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function StepBody(props: StepProps) {
  switch (props.step.kind) {
    case "model":
      return <ModelStep {...props} />;
    case "about":
      return <AboutStep {...props} />;
    case "search":
      return <SearchStep {...props} />;
    case "apps":
      return <AppsStep {...props} />;
    case "tasks":
      return <TasksStep {...props} />;
    case "channels":
      return <ChannelsStep {...props} />;
    case "voice":
      return <VoiceStep {...props} />;
    case "ideas":
      return <IdeasStep {...props} connectedBefore={props.appsBefore} onTry={(prompt, ideaId) => props.onTry?.(prompt, ideaId)} />;
    case "info":
      return <InfoStep {...props} />;
    // The service is the terminal's.
    default:
      return null;
  }
}

/**
 * An info step: the flow's words, the flow plugin's own frame under
 * them when it has one — sandboxed, no network, no channel — and *Got it*,
 * which marks the step seen. Another plugin's contribution is never shown.
 */
function InfoStep(props: StepProps) {
  const t = useT();
  const [problem, setProblem] = useState<string>();
  // The flow's own plugin's, and one that receives nothing, whatever a placement said.
  const item =
    props.step.frame === undefined
      ? undefined
      : props.frames?.items.find(
          (candidate) =>
            candidate.pluginId === props.providerId &&
            candidate.contribution.id === props.step.frame &&
            candidate.contribution.channels.length === 0,
        );
  const bounds = item?.placement.height ?? { min: 120, default: 320, max: 640 };
  const [height, setHeight] = useState(bounds.default);
  const seen = props.status.steps.find((step) => step.kind === "info")?.state === "done";
  const read = async (): Promise<void> => {
    const marked = await completeStep(props.client, props.workspaceId, "info");
    if (!marked.ok) return setProblem(marked.message);
    props.onStatus(marked.value);
    props.onDone();
  };
  return (
    <div className="welcome-info">
      {item === undefined || props.frames === undefined ? null : (
        <PluginFrame
          key={`${item.pluginId}/${item.contribution.id}@${item.contentHash}`}
          className="welcome-frame"
          style={{ height }}
          resolved={item}
          slot="onboarding.step"
          placement={item.placement}
          context={{ workspaceId: props.workspaceId }}
          client={props.frames.client}
          visible
          onRequestHeight={(px) => setHeight(Math.min(bounds.max, Math.max(bounds.min, px)))}
        />
      )}
      {seen ? null : (
        <div className="actions">
          <Button variant="primary" onClick={() => void read()}>
            {t("welcome.info.gotIt")}
          </Button>
        </div>
      )}
      {problem === undefined ? null : <Failure>{problem}</Failure>}
    </div>
  );
}
