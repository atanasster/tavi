import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  hostTimeZone,
  instantForLocalTime,
  localDateTime,
  ROUTINE_MAX_TRIGGERS,
  routineProvenanceLine,
  routineTriggerSpec,
  type RoutineDetail,
  type RoutineStandingAnswer,
  type RoutineTrigger,
  type ScheduleSpec,
} from "@tavi/contracts";

import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import { Select } from "../../ui/Select.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions, FormFailure, LoadError } from "../settings/FormParts.js";
import { useFormSubmit } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { listDeliveryTargets, operationKey, requestList, routineRequest } from "./api.js";
import { BusyFieldset, Failure, Notice } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { cadenceProblems, sameCadence } from "../../ui/cadence.js";
import { CadenceField, type CadenceAllows } from "../../ui/CadenceField.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { andList } from "../apps/model.js";

/** A routine trigger is one cadence: a one-off runs once, at one time. */
const TRIGGER_ALLOWS: CadenceAllows = { once: "single" };

/** A trigger as the cadence field edits it: a one-off as a date and a time in `timezone`, the routine's. */
function triggerCadence(trigger: RoutineTrigger, timezone: string): ScheduleSpec {
  const recurring = routineTriggerSpec(trigger);
  if (recurring !== undefined) return recurring;
  const local = trigger.kind === "once" ? localDateTime(new Date(trigger.runAt), timezone) : undefined;
  const pad = (value: number | undefined) => String(value ?? 0).padStart(2, "0");
  return {
    at: `${pad(local?.hour)}:${pad(local?.minute)}`,
    timezone,
    once: `${String(local?.year ?? 1970).padStart(4, "0")}-${pad(local?.month)}-${pad(local?.day)}`,
  };
}

/** The trigger a cadence makes: once on a date at its time, or recurring. */
function cadenceTrigger(id: string, spec: ScheduleSpec): RoutineTrigger {
  if (spec.once === undefined) {
    const { once: _once, ...recurring } = spec;
    return { id, kind: "daily", ...recurring };
  }
  const [year = 1970, month = 1, day = 1] = spec.once.split("-").map(Number);
  const [hour = 0, minute = 0] = (spec.at ?? spec.times?.[0] ?? "00:00").split(":").map(Number);
  return { id, kind: "once", runAt: instantForLocalTime({ year, month, day, hour, minute }, spec.timezone).toISOString() };
}

/** Whether `spec` is the plain daily time a routine is set up with by its `at`. */
const plainDaily = (spec: ScheduleSpec): boolean => spec.at !== undefined && sameCadence(spec, { at: spec.at, timezone: spec.timezone });

/** What a new routine may start from (Duplicate): another one's setup, under a new name. */
export interface RoutineDraft {
  /** The routine it copies: the owner keeps that one's provenance on the copy. */
  readonly routineId: string;
  readonly provenance?: RoutineDetail["revision"]["provenance"];
  readonly name: string;
  readonly objective: string;
  readonly timezone: string;
  readonly triggers: readonly RoutineTrigger[];
  readonly instructions: string;
  readonly style: RoutineDetail["revision"]["snapshot"]["report"]["style"];
  readonly skills: RoutineDetail["revision"]["snapshot"]["skills"];
  readonly models: RoutineDetail["revision"]["snapshot"]["models"];
  readonly delivery?: { readonly targetId: string; readonly pdf: boolean };
  /** Destinations after the first, and whether a delivery window is set: neither can be set up on a new routine. */
  readonly otherTargets: number;
  readonly window: boolean;
}

/** What a new routine may start from besides a copy: a template's name, objective and cadence. */
export interface RoutineStart {
  readonly name: string;
  readonly objective: string;
  /** The cadence, without its zone: it runs in the workspace's. */
  readonly cadence: Omit<ScheduleSpec, "timezone">;
}

/** What a form repeated from a chat carries to the other when the person switches: the name, the prompt or objective, the cadence. */
export interface RepeatFields {
  readonly name: string;
  readonly text: string;
  readonly spec: ScheduleSpec;
}

/** A copy of a routine's latest revision to create a new routine from, named "<name> (copy)". */
export function routineDraft(detail: RoutineDetail): RoutineDraft {
  const snapshot = detail.revision.snapshot;
  const targetId = snapshot.delivery.targetIds[0];
  return {
    routineId: detail.routine.routineId,
    ...(detail.revision.provenance === undefined ? {} : { provenance: detail.revision.provenance }),
    name: translateNow("routines.create.copyName", { name: detail.routine.name }),
    objective: snapshot.objective,
    timezone: snapshot.execution.timezone,
    triggers: snapshot.triggers,
    instructions: snapshot.agent.instructions,
    style: snapshot.report.style,
    skills: snapshot.skills,
    models: snapshot.models,
    ...(targetId === undefined ? {} : { delivery: { targetId, pdf: snapshot.report.formats.includes("pdf") } }),
    otherTargets: Math.max(snapshot.delivery.targetIds.length - 1, 0),
    window: snapshot.delivery.window !== undefined,
  };
}

/**
 * A new routine from its name, objective and cadence; the owner fills in the
 * rest. Started from a `draft`, its first trigger is the cadence shown, any
 * others are copied as they are, its instructions are shown to read and edit,
 * and its report style, skills, models and first destination come along; what
 * a new routine cannot be set up with (other destinations, a delivery window)
 * is named as not copied.
 */
export function CreateRoutine({
  timeZone,
  draft,
  start,
  fromTaskId,
  notice,
  onEdit,
  onClose,
  saved,
}: {
  /** The zone the time starts in: the workspace's. Absent, this browser's. */
  readonly timeZone?: string | undefined;
  readonly draft?: RoutineDraft | undefined;
  /** A template to start from: its name, objective and cadence, filled in. */
  readonly start?: RoutineStart | undefined;
  /** The chat a start was repeated from: the owner stamps what that chat read. */
  readonly fromTaskId?: string | undefined;
  /** What to read before saving, above the fields: where a start came from. */
  readonly notice?: ReactNode;
  /** Told the name, objective and cadence as they are typed: what a switch to the schedule form carries over. */
  readonly onEdit?: ((fields: RepeatFields) => void) | undefined;
  readonly onClose: () => void;
  readonly saved: (routineId: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const [name, setName] = useState(draft?.name ?? start?.name ?? "");
  const [objective, setObjective] = useState(draft?.objective ?? start?.objective ?? "");
  const [first] = useState(() => {
    const trigger = draft?.triggers[0];
    return trigger === undefined || draft === undefined ? undefined : { trigger, spec: triggerCadence(trigger, draft.timezone) };
  });
  const [spec, setSpec] = useState<ScheduleSpec>(
    () => first?.spec ?? { ...(start?.cadence ?? { at: "09:00" }), timezone: timeZone ?? hostTimeZone() },
  );
  const edited = useRef(onEdit);
  edited.current = onEdit;
  useEffect(() => edited.current?.({ name, text: objective, spec }), [name, objective, spec]);
  const others = draft?.triggers.slice(1) ?? [];
  const [instructions, setInstructions] = useState(draft?.instructions ?? "");
  const provenance = routineProvenanceLine(draft?.provenance, translateCore);
  const notCopied = [
    ...(draft !== undefined && draft.otherTargets > 0 ? [t("routines.create.otherDestinations", { count: draft.otherTargets })] : []),
    ...(draft?.window === true ? [t("routines.create.window")] : []),
  ];
  const notCopiedItems = andList(notCopied);
  // One key per dialog: a retried save is the same create, not a second routine.
  const operation = useRef(operationKey());
  const created = useRef("");
  const {
    saving: busy,
    failure: error,
    submit,
  } = useFormSubmit(
    true,
    async () => {
      if (!name.trim() || !objective.trim()) return t("routines.create.emptyFields");
      const problem = cadenceProblems(spec)[0];
      if (problem !== undefined) return t("routines.create.cadenceProblem", { problem: problem.message });
      // A daily time is set up as before; any other cadence is the routine's one trigger. A copy keeps its other triggers.
      const shown =
        first !== undefined && sameCadence(spec, first.spec) ? first.trigger : cadenceTrigger(first?.trigger.id ?? "cadence", spec);
      const when = first === undefined && plainDaily(spec) ? { at: spec.at } : { triggers: [shown, ...others] satisfies RoutineTrigger[] };
      const copied =
        draft === undefined
          ? {}
          : {
              instructions,
              style: draft.style,
              skills: draft.skills,
              models: draft.models,
              ...(draft.delivery === undefined ? {} : { delivery: draft.delivery }),
            };
      const answer = await routineRequest<RoutineDetail>(client, workspaceId, {
        action: "create",
        operationKey: operation.current,
        setup: { name: name.trim(), objective: objective.trim(), ...when, timezone: spec.timezone, ...copied },
        ...(draft === undefined ? {} : { copyOf: draft.routineId }),
        ...(fromTaskId === undefined ? {} : { fromTaskId }),
      });
      if (!answer.ok) return answer.message;
      created.current = answer.value.routine.routineId;
      return undefined;
    },
    () => saved(created.current),
  );

  return (
    <Modal title={t("routines.create.title")} busy={busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <BusyFieldset busy={busy} className="settings-fields">
          {notice}
          <label>
            {t("routines.create.name")}
            <input
              required
              value={name}
              maxLength={200}
              placeholder={t("routines.create.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("routines.create.objective")}
            <textarea
              required
              value={objective}
              placeholder={t("routines.create.objectivePlaceholder")}
              onChange={(event) => setObjective(event.target.value)}
            />
          </label>
          <CadenceField
            value={spec}
            onChange={setSpec}
            workspaceZone={timeZone}
            client={client}
            workspaceId={workspaceId}
            allows={TRIGGER_ALLOWS}
          />
          {others.length === 0 ? null : <p className="muted">{t("routines.create.otherTriggers", { count: others.length })}</p>}
          {draft === undefined ? null : (
            <>
              {provenance === undefined ? null : (
                <Notice className="routine-provenance">{t("routines.create.provenance", { provenance })}</Notice>
              )}
              <label>
                {t("routines.create.instructions")}
                <textarea required value={instructions} onChange={(event) => setInstructions(event.target.value)} />
              </label>
              <p className="muted">
                {t("routines.create.copiedToo")}
                {notCopied.length === 0 ? null : ` ${t("routines.create.notCopied", { items: notCopiedItems })}`}
              </p>
            </>
          )}
          <p>{t("routines.create.beforeStart")}</p>
          {error ? <Failure>{error}</Failure> : null}
          <FormActions saving={busy} label={t("routines.create.save")} onCancel={onClose} />
        </BusyFieldset>
      </form>
    </Modal>
  );
}

/**
 * A new revision of the routine: its name, objective and triggers, report,
 * delivery and researcher instructions. A destination that has lost its
 * authorization can be unticked but not ticked again; the name, objective,
 * triggers and instructions are sent only when they changed, since a change
 * to the instructions is what triggers a new evaluation.
 */
export function EditRoutine({
  value,
  timeZone,
  onClose,
  saved,
}: {
  readonly value: RoutineDetail;
  /** The workspace's zone, offered beside the routine's own. Absent, the workspace's as the page knows it. */
  readonly timeZone?: string | undefined;
  readonly onClose: () => void;
  readonly saved: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const pageZone = useTimeZone();
  const workspaceZone = timeZone ?? pageZone;
  const snapshot = value.revision.snapshot;
  // The routine's own zone, which its triggers are read in: not necessarily the workspace's.
  const zone = snapshot.execution.timezone;
  const [name, setName] = useState(value.routine.name);
  const [objective, setObjective] = useState(snapshot.objective);
  const [initialTriggers] = useState(() => snapshot.triggers.map((trigger) => ({ id: trigger.id, spec: triggerCadence(trigger, zone) })));
  const [triggers, setTriggers] = useState(initialTriggers);
  // A trigger left as it was is sent as stored, so its instant is not re-encoded.
  const sentTrigger = (trigger: { readonly id: string; readonly spec: ScheduleSpec }): RoutineTrigger => {
    const initial = initialTriggers.find((each) => each.id === trigger.id);
    const stored = snapshot.triggers.find((each) => each.id === trigger.id);
    if (initial !== undefined && stored !== undefined && sameCadence(trigger.spec, initial.spec)) return stored;
    return cadenceTrigger(trigger.id, trigger.spec);
  };
  const triggersChanged =
    triggers.length !== initialTriggers.length ||
    triggers.some((trigger, index) => trigger.id !== initialTriggers[index]?.id || !sameCadence(trigger.spec, initialTriggers[index].spec));
  const [instructions, setInstructions] = useState(snapshot.agent.instructions);
  const [style, setStyle] = useState(snapshot.report.style);
  const [maxItems, setMaxItems] = useState(snapshot.report.maxItems);
  const [pdf, setPdf] = useState(snapshot.report.formats.includes("pdf"));
  const [targets, setTargets] = useState<readonly string[]>(snapshot.delivery.targetIds);
  const [checkpoints, setCheckpoints] = useState(snapshot.execution.humanCheckpoints ?? "off");
  // Off without a destination to ask in.
  const asking = targets.length === 0 ? "off" : checkpoints;
  // The routine's owner's destinations: a person's routine is delivered to their own.
  const available = useLoaded(() => listDeliveryTargets(client, workspaceId, value.routine.routineId));
  const operation = useRef(operationKey());
  const choices = available.data?.targets ?? [];

  const edit = () =>
    routineRequest(client, workspaceId, {
      action: "edit",
      routineId: value.routine.routineId,
      expectedRevision: value.routine.latestRevision,
      operationKey: operation.current,
      edit: {
        ...(name.trim() === value.routine.name ? {} : { name: name.trim() }),
        ...(objective.trim() === snapshot.objective ? {} : { objective: objective.trim() }),
        ...(triggersChanged ? { triggers: triggers.map(sentTrigger) } : {}),
        ...(instructions === snapshot.agent.instructions ? {} : { instructions }),
        report: { style, maxItems, formats: pdf ? ["in-app", "pdf"] : ["in-app"] },
        delivery: { targetIds: [...targets] },
        ...(asking === (snapshot.execution.humanCheckpoints ?? "off") ? {} : { humanCheckpoints: asking }),
      },
    });
  const {
    saving: busy,
    failure: error,
    submit,
  } = useFormSubmit(
    true,
    async () => {
      const problem = triggers.flatMap((trigger) => cadenceProblems(trigger.spec))[0];
      if (problem !== undefined) return t("routines.create.cadenceProblem", { problem: problem.message });
      const answer = await edit();
      return answer.ok ? undefined : answer.message;
    },
    saved,
  );

  return (
    <Modal title={t("routines.edit.title")} busy={busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <BusyFieldset busy={busy} className="settings-fields">
          <label>
            {t("routines.create.name")}
            <input required value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("routines.create.objective")}
            <textarea required value={objective} maxLength={20_000} onChange={(event) => setObjective(event.target.value)} />
          </label>
          {triggers.map((trigger, index) => (
            <div key={trigger.id} className="cadence-trigger">
              <CadenceField
                legend={triggers.length === 1 ? t("ui.cadence.legend") : t("routines.edit.trigger", { number: index + 1 })}
                value={trigger.spec}
                onChange={(spec) => setTriggers((before) => before.map((each) => (each.id === trigger.id ? { ...each, spec } : each)))}
                workspaceZone={workspaceZone}
                client={client}
                workspaceId={workspaceId}
                allows={TRIGGER_ALLOWS}
              />
              {triggers.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={() => setTriggers((before) => before.filter((each) => each.id !== trigger.id))}>
                  {t("routines.edit.removeTrigger", { number: index + 1 })}
                </Button>
              ) : null}
            </div>
          ))}
          {triggers.length < ROUTINE_MAX_TRIGGERS ? (
            <div>
              <Button
                size="sm"
                onClick={() =>
                  setTriggers((before) => [
                    ...before,
                    { id: freeTriggerId(before.map((each) => each.id)), spec: { at: "09:00", timezone: zone } },
                  ])
                }
              >
                {t("routines.edit.addTrigger")}
              </Button>
            </div>
          ) : null}
          <label>
            {t("routines.create.instructions")}
            <textarea required value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </label>
          <label>
            {t("routines.edit.reportStyle")}
            <Select
              aria-label={t("routines.edit.reportStyle")}
              value={style}
              onChange={(event) => setStyle(event.target.value as typeof style)}
            >
              <option value="summary">{t("routines.edit.styleSummary")}</option>
              <option value="detailed">{t("routines.edit.styleDetailed")}</option>
            </Select>
          </label>
          <label>
            {t("routines.edit.maxStories")}
            <input type="number" min={1} max={20} value={maxItems} onChange={(event) => setMaxItems(Number(event.target.value))} />
          </label>
          <label>
            <input type="checkbox" checked={pdf} onChange={(event) => setPdf(event.target.checked)} />
            {t("routines.edit.pdf")}
          </label>
          <fieldset>
            <legend>{t("routines.edit.destinations")}</legend>
            {choices.map((target) => {
              const chosen = targets.includes(target.targetId);
              return (
                <label key={target.targetId}>
                  <input
                    type="checkbox"
                    disabled={!target.authorized && !chosen}
                    checked={chosen}
                    onChange={(event) =>
                      setTargets((before) =>
                        event.target.checked ? [...before, target.targetId] : before.filter((id) => id !== target.targetId),
                      )
                    }
                  />
                  {target.label}
                  {target.authorized ? "" : ` — ${t("routines.edit.unavailable")}`}
                </label>
              );
            })}
            {available.data !== undefined && choices.length === 0 ? <p>{t("routines.edit.noDestination")}</p> : null}
          </fieldset>
          {available.error ? <Failure>{available.error}</Failure> : null}
          <label>
            {t("routines.edit.questions")}
            <Select
              aria-label={t("routines.edit.questions")}
              value={asking}
              disabled={targets.length === 0}
              onChange={(event) => setCheckpoints(event.target.value as typeof checkpoints)}
            >
              <option value="off">{t("routines.edit.neverAsk")}</option>
              <option value="ask-with-default">{t("routines.edit.askDefault")}</option>
            </Select>
          </label>
          <p className="muted">
            {targets.length === 0
              ? t("routines.edit.hintNoDestination")
              : asking === "ask-with-default"
                ? t("routines.edit.hintAsk")
                : t("routines.edit.hintNever")}
          </p>
          <StandingAnswers routineId={value.routine.routineId} />
          <p>{t("routines.edit.note")}</p>
          {error ? <Failure>{error}</Failure> : null}
          <FormActions saving={busy} label={t("routines.edit.save")} onCancel={onClose} />
        </BusyFieldset>
      </form>
    </Modal>
  );
}

/** A trigger id none of `taken` is. */
function freeTriggerId(taken: readonly string[]): string {
  for (let count = taken.length + 1; ; count += 1) if (!taken.includes(`trigger-${count}`)) return `trigger-${count}`;
}

/**
 * The answers this routine gives without asking, each kept from
 * a question it asked: forgotten here, at once, so the next run asks again.
 */
function StandingAnswers({ routineId }: { readonly routineId: string }) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const loaded = useLoaded(() =>
    requestList<{ readonly answers: readonly RoutineStandingAnswer[] }>(
      client,
      workspaceId,
      { action: "answers", routineId },
      "answers",
      t("routines.answers.what"),
    ),
  );
  const [forgotten, setForgotten] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string>();
  const answers = (loaded.data?.answers ?? []).filter((answer) => !forgotten.includes(answer.questionKey));
  // Not knowing them is not having none: a failed read says so, with a retry.
  if (loaded.error) return <LoadError error={loaded.error} reload={loaded.reload} />;
  if (answers.length === 0 && failure === undefined) return null;
  const forget = (questionKey: string) => {
    void routineRequest(client, workspaceId, { action: "forget_answer", routineId, questionKey }).then((outcome) => {
      if (outcome.ok) setForgotten((held) => [...held, questionKey]);
      else setFailure(outcome.message);
    });
  };
  return (
    <fieldset>
      <legend>{t("routines.answers.legend")}</legend>
      <ul className="standing-answers">
        {answers.map((answer) => (
          <li key={answer.questionKey}>
            <span>
              {answer.question} → <strong>{answer.answers.join(", ")}</strong>
            </span>{" "}
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("routines.answers.forgetLabel", { question: answer.question })}
              onClick={() => forget(answer.questionKey)}
            >
              {t("routines.answers.forget")}
            </Button>
          </li>
        ))}
      </ul>
      <FormFailure message={failure} />
    </fieldset>
  );
}
