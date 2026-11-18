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
    name: `${detail.routine.name} (copy)`,
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
  const provenance = routineProvenanceLine(draft?.provenance);
  const notCopied = [
    ...(draft !== undefined && draft.otherTargets > 0
      ? [draft.otherTargets === 1 ? "its other destination" : `its ${draft.otherTargets} other destinations`]
      : []),
    ...(draft?.window === true ? ["its delivery window"] : []),
  ];
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
      if (!name.trim() || !objective.trim()) return "Enter a name and an objective.";
      const problem = cadenceProblems(spec)[0];
      if (problem !== undefined) return `When it runs: ${problem.message}`;
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
    <Modal title="Create routine" busy={busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <BusyFieldset busy={busy} className="settings-fields">
          {notice}
          <label>
            Name
            <input required value={name} maxLength={200} placeholder="News watch" onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Objective
            <textarea
              required
              value={objective}
              placeholder="Find the latest news and material updates on a topic"
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
          {others.length === 0 ? null : (
            <p className="muted">
              {others.length === 1
                ? "Its other trigger is copied as it is."
                : `Its ${others.length} other triggers are copied as they are.`}
            </p>
          )}
          {draft === undefined ? null : (
            <>
              {provenance === undefined ? null : (
                <Notice className="routine-provenance">
                  {provenance}. Check its objective and instructions; editing them yourself clears this note on the copy.
                </Notice>
              )}
              <label>
                Researcher instructions
                <textarea required value={instructions} onChange={(event) => setInstructions(event.target.value)} />
              </label>
              <p className="muted">
                Its report style, skills, models and first destination are copied too.
                {notCopied.length === 0 ? null : ` Not copied: ${notCopied.join(" and ")}; add them once it is saved.`}
              </p>
            </>
          )}
          <p>Before it starts, Tavi checks that the routine works with your models; the next run shown waits for that check to pass.</p>
          {error ? <Failure>{error}</Failure> : null}
          <FormActions saving={busy} label="Save routine" onCancel={onClose} />
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
      if (problem !== undefined) return `When it runs: ${problem.message}`;
      const answer = await edit();
      return answer.ok ? undefined : answer.message;
    },
    saved,
  );

  return (
    <Modal title="Edit routine" busy={busy} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <BusyFieldset busy={busy} className="settings-fields">
          <label>
            Name
            <input required value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Objective
            <textarea required value={objective} maxLength={20_000} onChange={(event) => setObjective(event.target.value)} />
          </label>
          {triggers.map((trigger, index) => (
            <div key={trigger.id} className="cadence-trigger">
              <CadenceField
                legend={triggers.length === 1 ? "When" : `Trigger ${index + 1}`}
                value={trigger.spec}
                onChange={(spec) => setTriggers((before) => before.map((each) => (each.id === trigger.id ? { ...each, spec } : each)))}
                workspaceZone={workspaceZone}
                client={client}
                workspaceId={workspaceId}
                allows={TRIGGER_ALLOWS}
              />
              {triggers.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={() => setTriggers((before) => before.filter((each) => each.id !== trigger.id))}>
                  Remove trigger {index + 1}
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
                Add a trigger
              </Button>
            </div>
          ) : null}
          <label>
            Researcher instructions
            <textarea required value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </label>
          <label>
            Report style
            <Select aria-label="Report style" value={style} onChange={(event) => setStyle(event.target.value as typeof style)}>
              <option value="summary">Summary with links</option>
              <option value="detailed">Detailed with links</option>
            </Select>
          </label>
          <label>
            Maximum stories
            <input type="number" min={1} max={20} value={maxItems} onChange={(event) => setMaxItems(Number(event.target.value))} />
          </label>
          <label>
            <input type="checkbox" checked={pdf} onChange={(event) => setPdf(event.target.checked)} />
            Generate PDF
          </label>
          <fieldset>
            <legend>Authorized destinations</legend>
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
                  {target.authorized ? "" : " — unavailable"}
                </label>
              );
            })}
            {available.data !== undefined && choices.length === 0 ? (
              <p>No destination configured. Ask in chat to add an explicitly selected destination after configuring Messaging.</p>
            ) : null}
          </fieldset>
          {available.error ? <Failure>{available.error}</Failure> : null}
          <label>
            Questions while it runs
            <Select
              aria-label="Questions while it runs"
              value={asking}
              disabled={targets.length === 0}
              onChange={(event) => setCheckpoints(event.target.value as typeof checkpoints)}
            >
              <option value="off">Never ask — decide alone</option>
              <option value="ask-with-default">Ask the destination, with a default</option>
            </Select>
          </label>
          <p className="muted">
            {targets.length === 0
              ? "Choose a destination above to let a run ask you something."
              : asking === "ask-with-default"
                ? "A run may stop to ask you in the destination, always with the option it takes if you don't answer in time. It waits inside its time budget, then goes on."
                : "A run never stops to ask: it decides with what it has."}
          </p>
          <StandingAnswers routineId={value.routine.routineId} />
          <p>
            Name, objective, trigger, report and delivery changes preserve the researcher instructions. Instruction changes require
            evaluation; the previous active revision continues until it passes.
          </p>
          {error ? <Failure>{error}</Failure> : null}
          <FormActions saving={busy} label="Save revision" onCancel={onClose} />
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
  const loaded = useLoaded(() =>
    requestList<{ readonly answers: readonly RoutineStandingAnswer[] }>(
      client,
      workspaceId,
      { action: "answers", routineId },
      "answers",
      "standing answers",
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
      <legend>Answered without asking</legend>
      <ul className="standing-answers">
        {answers.map((answer) => (
          <li key={answer.questionKey}>
            <span>
              {answer.question} → <strong>{answer.answers.join(", ")}</strong>
            </span>{" "}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Forget the answer to ${answer.question}`}
              onClick={() => forget(answer.questionKey)}
            >
              Forget
            </Button>
          </li>
        ))}
      </ul>
      <FormFailure message={failure} />
    </fieldset>
  );
}
