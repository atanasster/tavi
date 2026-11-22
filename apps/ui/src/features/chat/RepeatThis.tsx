import {
  hostTimeZone,
  IPC_MAX_PROMPT_CHARS,
  provenanceSourcesPhrase,
  ROUTINE_MAX_OBJECTIVE_CHARS,
  type LabelSummary,
  type ScheduleSpec,
  type ScheduleToolsResult,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { useRef, useState } from "react";

import type { ScheduleDraft } from "../center/PlainSchedules.js";
import { ScheduleForm } from "../center/ScheduleForm.js";
import { loadScheduleTools } from "../center/schedules-api.js";
import { CreateRoutine, type RepeatFields } from "../routines/RoutineForms.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { translateCore, useT } from "../../lib/i18n.js";
import { Button } from "../../ui/Button.js";
import { Modal } from "../../ui/Modal.js";
import { Notice, Pending } from "../../ui/Parts.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { memoryRead, openingPrompt, repeatName, repeatPrompt, repeatTools, researchChat, toolsUsed } from "./repeat.js";
import { loadTaskLabel } from "./tasks-api.js";
import type { CanvasRun } from "./store/types.js";

/** What the chat read, as far as the owner says: clean, tainted (its label), or unknown (the label could not be read). */
type ChatTaint = { readonly kind: "clean" } | { readonly kind: "tainted"; readonly label: LabelSummary } | { readonly kind: "unknown" };

/**
 * The tools a schedule may list (none when the owner could not say, `toolsKnown`
 * false), and what the chat read: both read as the form opens.
 */
async function loadRepeat(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
): Promise<Outcome<{ readonly listable: ScheduleToolsResult; readonly toolsKnown: boolean; readonly taint: ChatTaint }>> {
  const [listed, label] = await Promise.all([loadScheduleTools(client, workspaceId), loadTaskLabel(client, workspaceId, taskId)]);
  const listable = listed.ok ? listed.value : { tools: [], families: [], readOnly: [] };
  const context = label.ok ? label.value.contextLabel : undefined;
  const taint: ChatTaint = !label.ok
    ? { kind: "unknown" }
    : context !== null && context !== undefined && context.integrity === "untrusted"
      ? { kind: "tainted", label: context }
      : { kind: "clean" };
  return { ok: true, value: { listable, toolsKnown: listed.ok, taint } };
}

/** A cadence without its zone, as a routine's start takes it: it runs in the workspace's. */
function cadenceOf(spec: ScheduleSpec): Omit<ScheduleSpec, "timezone"> {
  const { timezone: _zone, ...cadence } = spec;
  return cadence;
}

/** The chat's words and runs a repeat starts from: `prompt` is the message it was asked on, else the chat's opening one. */
interface RepeatSource {
  readonly taskId: string;
  readonly prompt?: string | undefined;
  readonly runs: readonly CanvasRun[];
}

/**
 * *Repeat this*: the schedule form filled with the chat's prompt and the
 * read-only tools it used that a schedule may list (the owner's `schedules
 * tools`), its other listable tools a click away, or, for a research chat,
 * the routine form filled with its objective — each able to switch to the
 * other. Nothing is created until the form is saved, through the same owner
 * checks as any new schedule or routine. A chat that read content Tavi does
 * not trust, or one whose label could not be read, says so in the form and
 * allows no tool ahead, since what is saved runs unattended; a routine names
 * the chat, so the owner stamps what it read. While what it is filled from
 * is read, the dialog says so; a read that fails says why, with Retry.
 */
export function RepeatForms({
  source,
  onClose,
  onDone,
}: {
  readonly source: RepeatSource;
  readonly onClose: () => void;
  /** Said once the schedule or routine exists. */
  readonly onDone: (note: string) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const zone = timeZone ?? hostTimeZone();
  // Read once as the form opens: later turns do not rewrite a form being filled in.
  const [asked] = useState(() => source.prompt?.trim() || openingPrompt(source.runs));
  const [used] = useState(() => toolsUsed(source.runs));
  const [memory] = useState(() => memoryRead(source.runs));
  const { data, error, reload } = useLoaded(
    () =>
      loadRepeat(client, workspaceId, source.taskId).catch(
        (failure: unknown): Outcome<never> => ({ ok: false, message: errorMessage(failure) }),
      ),
    [source.taskId],
  );
  const [picked, setPicked] = useState<"schedule" | "routine">();
  // What the person typed in the form shown, carried to the other when they switch.
  const typed = useRef<RepeatFields | undefined>(undefined);
  // The form opens at once: what it is filled from is said to be on its way, or why it could not be read.
  if (data === undefined)
    return (
      <Modal title={t("chat.repeat.title")} onClose={onClose}>
        <Pending error={error} reload={reload} label={t("chat.repeat.reading")} className="notice" status />
        <div className="actions">
          <Button onClick={onClose}>{t("chat.repeat.cancel")}</Button>
        </div>
      </Modal>
    );
  const { allowed, offered, leftOut } = repeatTools(used, data.listable, data.taint.kind === "clean");
  const research = researchChat(used, data.listable);
  const as = picked ?? (research ? "routine" : "schedule");
  const prompt = repeatPrompt(typed.current?.text ?? asked, as === "routine" ? ROUTINE_MAX_OBJECTIVE_CHARS : IPC_MAX_PROMPT_CHARS);
  const name = typed.current?.name ?? repeatName(prompt);
  // Text left as it was filled in is not the person's: the chat's whole message goes on, shortened only to fit.
  const edit = (fields: RepeatFields) => {
    typed.current = { ...fields, text: fields.text === prompt ? (typed.current?.text ?? asked) : fields.text };
  };
  const readOnly = new Set(data.listable.readOnly);
  const notice = (
    <Notice as="div">
      <p>{t("chat.repeat.filled")}</p>
      {prompt.length < (typed.current?.text ?? asked).length ? (
        <p>{t(as === "routine" ? "chat.repeat.shortened.routine" : "chat.repeat.shortened.schedule")}</p>
      ) : null}
      {as === "schedule" && !data.toolsKnown && used.length > 0 ? <p>{t("chat.repeat.toolsUnknown")}</p> : null}
      {as === "schedule" && data.toolsKnown && leftOut.length > 0 ? (
        <p>
          {leftOut.length > 8
            ? t("chat.repeat.leftOutMore", { tools: leftOut.slice(0, 8).join(", "), more: leftOut.length - 8 })
            : t("chat.repeat.leftOut", { count: leftOut.length, tools: leftOut.join(", ") })}
        </p>
      ) : null}
      {memory === undefined ? null : (
        <p>
          {as === "routine"
            ? t(memory === "read" ? "chat.repeat.memory.routineRead" : "chat.repeat.memory.routine")
            : t(memory === "read" ? "chat.repeat.memory.scheduleRead" : "chat.repeat.memory.schedule")}
        </p>
      )}
      {data.taint.kind === "clean" ? null : (
        <p>
          {data.taint.kind === "tainted"
            ? t("chat.repeat.tainted", { sources: provenanceSourcesPhrase(data.taint.label, undefined, translateCore) })
            : t("chat.repeat.taintUnknown")}{" "}
          {t(as === "routine" ? "chat.repeat.check.routine" : "chat.repeat.check.schedule")}
        </p>
      )}
      {research ? (
        <p>
          <Button variant="link" onClick={() => setPicked(as === "routine" ? "schedule" : "routine")}>
            {as === "routine" ? t("chat.repeat.asSchedule") : t("chat.repeat.asRoutine")}
          </Button>
        </p>
      ) : null}
    </Notice>
  );
  if (as === "routine")
    return (
      <CreateRoutine
        timeZone={timeZone}
        start={{ name, objective: prompt, cadence: typed.current === undefined ? { at: "09:00" } : cadenceOf(typed.current.spec) }}
        fromTaskId={source.taskId}
        notice={notice}
        onEdit={edit}
        onClose={onClose}
        saved={() => onDone(t("chat.repeat.routineCreated"))}
      />
    );
  const draft: ScheduleDraft = {
    name,
    prompt,
    spec: typed.current?.spec ?? { at: "07:00", timezone: zone },
    missedRunPolicy: "run-once-if-missed-within-6h",
    autoApproveTools: allowed,
    // Its result goes into Home, as a schedule made in a chat's does; Nowhere is one choice away.
    deliverTo: "home",
  };
  return (
    <ScheduleForm
      client={client}
      workspaceId={workspaceId}
      initial={undefined}
      draft={draft}
      notice={notice}
      onEdit={edit}
      offered={{ tools: offered, writing: offered.filter((tool) => !readOnly.has(tool)) }}
      timeZone={timeZone}
      onClose={onClose}
      onSaved={(saved) => onDone(t("chat.repeat.created", { name: saved }))}
    />
  );
}
