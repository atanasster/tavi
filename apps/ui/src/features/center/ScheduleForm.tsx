import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  hostTimeZone,
  IPC_MAX_PROMPT_CHARS,
  MISSED_RUN_POLICIES,
  parseSchedulePrecheck,
  schedulePrecheckText,
  parseTokenCount,
  SCHEDULE_DEFAULT_MAX_RUN_MINUTES,
  SCHEDULE_NOTIFY_MODES,
  ScheduleMaxRunMinutesSchema,
  ScheduleMaxTokensSchema,
  ScheduleSpecSchema,
  ScheduleToolPatternSchema,
  type ScheduleAlertTarget,
  type ScheduleNotify,
  type SchedulePrecheckKind,
  type ScheduleRecord,
  type ScheduleSpec,
  type SchedulesPayload,
} from "@tavi/contracts";
import { BusyFieldset, Failure, LoadState } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { FormActions } from "../settings/FormParts.js";
import { Modal } from "../../ui/Modal.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { cadencePayload, cadenceProblems, sameCadence } from "../../ui/cadence.js";
import { CadenceField } from "../../ui/CadenceField.js";
import { listReminderTargets, type ReminderChatTarget } from "./reminders-api.js";
import type { RepeatFields } from "../routines/RoutineForms.js";
import { loadAgents, loadScheduleTools, scheduleRequest } from "./schedules-api.js";
import { ScheduleLimitFields, SchedulePrecheckFields, ScheduleToolsField } from "./ScheduleFormFields.js";
import type { ScheduleDraft } from "./PlainSchedules.js";

/** The form's words for each `notify` choice. */
const NOTIFY_LABELS: Readonly<Record<ScheduleNotify, UiKey>> = {
  always: "center.scheduleForm.notify.always",
  "when-sent": "center.scheduleForm.notify.whenSent",
  "if-changed": "center.scheduleForm.notify.ifChanged",
};

/** An alert target as one picker value. */
const alertKey = (alert: ScheduleAlertTarget | undefined): string =>
  alert === undefined ? "" : JSON.stringify([alert.connectionId, alert.destination]);

/** Whether `target` is the chat `alert` names. */
const isAlertTarget = (target: ReminderChatTarget, alert: ScheduleAlertTarget): boolean =>
  target.connectionId === alert.connectionId && target.chatId === alert.destination;

/**
 * A new schedule starts in `timeZone` (the workspace's; absent, this browser's); an edit keeps its own. With no alert
 * target the owner posts a failed or missed run's alert into Home (`sendAlert`), which Home off has none of.
 */
export function ScheduleForm({
  client,
  workspaceId,
  initial,
  draft,
  notice,
  offered,
  timeZone,
  onEdit,
  onClose,
  onSaved,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  /** The schedule being edited; absent, a new one. */
  readonly initial: ScheduleRecord | undefined;
  /** What a new schedule starts from (Duplicate, or a chat repeated): its fields filled in, saved as a new schedule. */
  readonly draft?: ScheduleDraft | undefined;
  /** What to read before saving, above the fields: where a draft came from. */
  readonly notice?: ReactNode;
  /** Tools to add with one click (a chat's, repeated), and those of them that can change or send things, named once added. */
  readonly offered?: { readonly tools: readonly string[]; readonly writing: readonly string[] } | undefined;
  readonly timeZone?: string | undefined;
  /** Told the name, prompt and cadence as they are typed: what a switch to the routine form carries over. */
  readonly onEdit?: ((fields: RepeatFields) => void) | undefined;
  readonly onClose: () => void;
  /** Saved: the schedule's name. */
  readonly onSaved: (name: string) => void;
}) {
  const t = useT();
  const agents = useLoaded(() => loadAgents(client, workspaceId));
  // Alerts go to a chat the operator added as a delivery target, as a reminder's do.
  const targets = useLoaded(() => listReminderTargets(client, workspaceId));
  const toolChoices = useLoaded(() => loadScheduleTools(client, workspaceId));
  const toolListId = useId();
  const seed: ScheduleDraft | undefined = initial ?? draft;
  const [name, setName] = useState(seed?.name ?? "");
  const [prompt, setPrompt] = useState(seed?.prompt ?? "");
  const [spec, setSpec] = useState<ScheduleSpec>(() => seed?.spec ?? { at: "07:00", timezone: timeZone ?? hostTimeZone() });
  const edited = useRef(onEdit);
  edited.current = onEdit;
  useEffect(() => edited.current?.({ name, text: prompt, spec }), [name, prompt, spec]);
  const [missed, setMissed] = useState(seed?.missedRunPolicy ?? "run-once-if-missed-within-6h");
  const [tools, setTools] = useState<readonly string[]>(seed?.autoApproveTools ?? []);
  const [tool, setTool] = useState("");
  const [agentId, setAgent] = useState(seed?.agentId ?? "");
  const [alert, setAlert] = useState<ScheduleAlertTarget | undefined>(seed?.alert);
  const [checkpoints, setCheckpoints] = useState(seed?.humanCheckpoints ?? "off");
  const [notify, setNotify] = useState<ScheduleNotify>(seed?.notify ?? "always");
  const [deliverTo, setDeliverTo] = useState<"home" | "none">(seed?.deliverTo ?? "none");
  const [runLimit, setRunLimit] = useState(seed?.maxRunMinutes === undefined ? "" : String(seed.maxRunMinutes));
  const [maxTokens, setMaxTokens] = useState(seed?.maxTokens === undefined ? "" : String(seed.maxTokens));
  const [precheckKind, setPrecheckKind] = useState<SchedulePrecheckKind | "none">(seed?.precheck?.kind ?? "none");
  const [precheckTarget, setPrecheckTarget] = useState(seed?.precheck?.target ?? "");
  const [watch, setWatch] = useState(seed?.watch === true);
  const chats = targets.data ?? [];
  // An alert set where no target lists it (`tavi schedules --alert-*`) stays a choice, so saving another change keeps it.
  const seedAlert = seed?.alert;
  const kept = seedAlert !== undefined && !chats.some((target) => isAlertTarget(target, seedAlert)) ? seedAlert : undefined;
  const suggestions = [...(toolChoices.data?.tools ?? []), ...(toolChoices.data?.families ?? [])].filter((value) => !tools.includes(value));
  const unpicked = offered?.tools.filter((value) => !tools.includes(value)) ?? [];
  const writing = tools.filter((value) => offered?.writing.includes(value));
  // Asking needs somewhere to ask: the alert destination.
  const canAsk = alert !== undefined;
  const asking = canAsk ? checkpoints : "off";
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const addTool = () => {
    const value = tool.trim();
    if (!value || value === "*" || !ScheduleToolPatternSchema.safeParse(value).success) {
      setError(t("center.scheduleForm.badTool"));
      return;
    }
    if (tools.length >= 128) {
      setError(t("center.scheduleForm.tooManyTools", { max: 128 }));
      return;
    }
    setTools((before) => [...new Set([...before, value])]);
    setTool("");
    setError(undefined);
  };
  const submit = async () => {
    if (saving) return;
    if (!name.trim() || !prompt.trim()) {
      setError(t("center.scheduleForm.needNamePrompt"));
      return;
    }
    const problem = cadenceProblems(spec)[0];
    if (problem !== undefined || !ScheduleSpecSchema.safeParse(spec).success) {
      setError(t("center.scheduleForm.whenProblem", { problem: problem?.message ?? t("center.scheduleForm.incomplete") }));
      return;
    }
    if (tool.trim()) {
      setError(t("center.scheduleForm.unfinishedTool"));
      return;
    }
    const minutes = runLimit.trim() === "" ? undefined : /^\d+$/.test(runLimit.trim()) ? Number(runLimit.trim()) : Number.NaN;
    if (minutes !== undefined && !ScheduleMaxRunMinutesSchema.safeParse(minutes).success) {
      setError(t("center.scheduleForm.badRunLimit", { max: 1440, fallback: SCHEDULE_DEFAULT_MAX_RUN_MINUTES }));
      return;
    }
    if (agentId && !agents.data?.agents.some((agent) => agent.agentId === agentId && agent.enabled)) {
      setError(t("center.scheduleForm.badAgent"));
      return;
    }
    const tokens = maxTokens.trim() === "" ? null : parseTokenCount(maxTokens, ScheduleMaxTokensSchema);
    if (tokens === undefined) {
      setError(t("center.scheduleForm.badTokens", { min: 1000, max: 100_000_000 }));
      return;
    }
    const precheck = precheckKind === "none" ? undefined : parseSchedulePrecheck(`${precheckKind}:${precheckTarget.trim()}`);
    if (precheck !== undefined && !precheck.ok) {
      setError(t("center.scheduleForm.precheckProblem", { problem: precheck.message }));
      return;
    }
    const precheckText = precheck?.ok === true && precheck.precheck !== null ? schedulePrecheckText(precheck.precheck) : null;
    const initialPrecheck = initial?.precheck === undefined ? null : schedulePrecheckText(initial.precheck);
    setSaving(true);
    setError(undefined);
    // An edit names its cadence only when it changed, and then whole: an end date it no longer has is cleared.
    const cadence =
      initial === undefined
        ? cadencePayload(spec)
        : sameCadence(spec, initial.spec)
          ? {}
          : {
              ...cadencePayload(spec),
              ...(spec.until === undefined && spec.once === undefined && initial.spec.until !== undefined ? { untilDate: null } : {}),
            };
    const payload: SchedulesPayload = {
      action: initial ? "update" : "add",
      workspaceId,
      ...(initial ? { scheduleId: initial.scheduleId } : { name: name.trim() }),
      prompt: prompt.trim(),
      ...cadence,
      missed,
      allow: [...tools],
      agentId: agentId || null,
      alertConnection: alert?.connectionId ?? null,
      alertDestination: alert?.destination ?? null,
      humanCheckpoints: asking,
      notify,
      ...(tokens === null ? (initial?.maxTokens === undefined ? {} : { maxTokens: null }) : { maxTokens: tokens }),
      // A new schedule checks nothing first unless asked; an edit names its pre-check only when it changed.
      ...(precheckText === initialPrecheck ? {} : { precheck: precheckText }),
      // A watcher only with a pre-check; an edit says so only when it changed.
      ...(precheckText === null || watch === (initial?.watch === true) ? {} : { watch }),
      // A new schedule posts nowhere unless asked; an edit says "none" to stop posting.
      ...(initial === undefined && deliverTo === "none" ? {} : { deliverTo }),
      // A limit cannot be removed, only set: emptied, it is the default again.
      ...(minutes === undefined
        ? initial?.maxRunMinutes === undefined
          ? {}
          : { maxRunMinutes: SCHEDULE_DEFAULT_MAX_RUN_MINUTES }
        : { maxRunMinutes: minutes }),
    };
    if (initial) {
      const before: SchedulesPayload = {
        action: "update",
        prompt: initial.prompt,
        missed: initial.missedRunPolicy,
        allow: [...initial.autoApproveTools],
        agentId: initial.agentId ?? null,
        alertConnection: initial.alert?.connectionId ?? null,
        alertDestination: initial.alert?.destination ?? null,
      };
      for (const field of ["prompt", "missed", "allow", "agentId"] as const)
        if (JSON.stringify(payload[field]) === JSON.stringify(before[field])) delete payload[field];
      // Alert pairing is atomic: an actual change sends both halves.
      if (payload.alertConnection === before.alertConnection && payload.alertDestination === before.alertDestination) {
        delete payload.alertConnection;
        delete payload.alertDestination;
      }
      if (asking === (initial.humanCheckpoints ?? "off")) delete payload.humanCheckpoints;
      if (notify === (initial.notify ?? "always")) delete payload.notify;
      if (payload.maxTokens === initial.maxTokens) delete payload.maxTokens;
      if (deliverTo === (initial.deliverTo ?? "none")) delete payload.deliverTo;
      if (payload.maxRunMinutes === initial.maxRunMinutes) delete payload.maxRunMinutes;
    }
    const answer = await scheduleRequest(client, payload);
    setSaving(false);
    if (answer.ok) onSaved(initial?.name ?? name.trim());
    else setError(answer.message);
  };
  return (
    <Modal
      title={initial ? t("center.scheduleForm.editTitle", { name: initial.name }) : t("center.scheduleForm.createTitle")}
      busy={saving}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <BusyFieldset busy={saving} className="settings-fields">
          {notice}
          <label>
            {t("center.scheduleForm.name")}
            <input
              aria-label={t("center.scheduleForm.nameLabel")}
              required
              readOnly={!!initial}
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("center.scheduleForm.prompt")}
            <textarea
              aria-label={t("center.scheduleForm.promptLabel")}
              required
              maxLength={IPC_MAX_PROMPT_CHARS}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <CadenceField value={spec} onChange={setSpec} workspaceZone={timeZone} client={client} workspaceId={workspaceId} />
          <label>
            {t("center.scheduleForm.missed")}
            <Select
              aria-label={t("center.scheduleForm.missedLabel")}
              value={missed}
              onChange={(event) => setMissed(event.target.value as typeof missed)}
            >
              {MISSED_RUN_POLICIES.map((value) => (
                <option key={value} value={value}>
                  {value === "skip" ? t("center.scheduleForm.missedSkip") : t("center.scheduleForm.missedCatchUp")}
                </option>
              ))}
            </Select>
          </label>
          <ScheduleToolsField
            tool={tool}
            tools={tools}
            suggestions={suggestions}
            unpicked={unpicked}
            writing={writing}
            setTool={setTool}
            setTools={setTools}
            addTool={addTool}
            toolListId={toolListId}
          />
          <label>
            {t("center.scheduleForm.agent")}
            <Select aria-label={t("center.scheduleForm.agentLabel")} value={agentId} onChange={(event) => setAgent(event.target.value)}>
              <option value="">{t("center.scheduleForm.baseInstructions")}</option>
              {agentId && !agents.data?.agents.some((agent) => agent.agentId === agentId) ? (
                <option value={agentId} disabled>
                  {t("center.scheduleForm.agentUnavailable", { agent: agentId })}
                </option>
              ) : null}
              {agents.data?.agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId} disabled={!agent.enabled}>
                  {agent.enabled ? agent.name : t("center.scheduleForm.agentDisabled", { agent: agent.name })}
                </option>
              ))}
            </Select>
          </label>
          <LoadState
            error={agents.error || undefined}
            reload={agents.reload}
            loading={agents.loading}
            label={t("center.scheduleForm.loadingAgents")}
            className=""
          />
          {agents.data?.truncated ? <p>{t("center.scheduleForm.agentsTruncated", { count: agents.data.agents.length })}</p> : null}
          <label>
            {t("center.scheduleForm.alert")}
            <Select
              aria-label={t("center.scheduleForm.alert")}
              value={alertKey(alert)}
              onChange={(event) => {
                const picked = event.target.value;
                if (picked === "") return setAlert(undefined);
                if (picked === alertKey(kept)) return setAlert(kept);
                const target = chats.find((each) => alertKey({ connectionId: each.connectionId, destination: each.chatId }) === picked);
                if (target !== undefined) setAlert({ connectionId: target.connectionId, destination: target.chatId });
              }}
            >
              <option value="">{t("center.scheduleForm.noAlerts")}</option>
              {chats.map((target) => (
                <option key={target.targetId} value={alertKey({ connectionId: target.connectionId, destination: target.chatId })}>
                  {target.label}
                </option>
              ))}
              {kept === undefined ? null : (
                <option value={alertKey(kept)}>
                  {t("center.scheduleForm.keptAlert", { destination: kept.destination, connection: kept.connectionId })}
                </option>
              )}
            </Select>
          </label>
          <p className="muted">
            {targets.error
              ? t("center.scheduleForm.targetsUnread")
              : alert !== undefined
                ? t("center.scheduleForm.alertThere")
                : chats.length === 0 && targets.data !== undefined
                  ? t("center.scheduleForm.noAlertAddTarget")
                  : t("center.scheduleForm.noAlert")}
          </p>
          <label>
            {t("center.scheduleForm.questions")}
            <Select
              aria-label={t("center.scheduleForm.questionsLabel")}
              value={asking}
              disabled={!canAsk}
              onChange={(event) => setCheckpoints(event.target.value as typeof checkpoints)}
            >
              <option value="off">{t("center.scheduleForm.neverAsk")}</option>
              <option value="ask-with-default">{t("center.scheduleForm.askDefault")}</option>
            </Select>
          </label>
          <p className="muted">
            {!canAsk
              ? t("center.scheduleForm.askNeedsAlert")
              : asking === "ask-with-default"
                ? t("center.scheduleForm.askDefaultHint")
                : t("center.scheduleForm.neverAskHint")}
          </p>
          <label>
            {t("center.scheduleForm.deliver")}
            <Select
              aria-label={t("center.scheduleForm.deliver")}
              value={deliverTo}
              onChange={(event) => setDeliverTo(event.target.value as "home" | "none")}
            >
              <option value="home">{t("center.scheduleForm.home")}</option>
              <option value="none">{t("center.scheduleForm.nowhere")}</option>
            </Select>
          </label>
          <p className="muted">
            {deliverTo === "home" ? t("center.scheduleForm.deliverHomeHint") : t("center.scheduleForm.deliverNoneHint")}
          </p>
          <label>
            {t("center.scheduleForm.tellMe")}
            <Select
              aria-label={t("center.scheduleForm.tellMeLabel")}
              value={notify}
              onChange={(event) => setNotify(event.target.value as ScheduleNotify)}
            >
              {SCHEDULE_NOTIFY_MODES.map((value) => (
                <option key={value} value={value}>
                  {t(NOTIFY_LABELS[value])}
                </option>
              ))}
            </Select>
          </label>
          <p className="muted">
            {notify === "when-sent"
              ? t("center.scheduleForm.whenSentHint")
              : notify === "if-changed"
                ? t("center.scheduleForm.ifChangedHint")
                : t("center.scheduleForm.alwaysHint")}{" "}
            {t("center.scheduleForm.failuresTold")}
          </p>
          <ScheduleLimitFields runLimit={runLimit} maxTokens={maxTokens} setRunLimit={setRunLimit} setMaxTokens={setMaxTokens} />
          <SchedulePrecheckFields
            precheckKind={precheckKind}
            precheckTarget={precheckTarget}
            watch={watch}
            spec={spec}
            setPrecheckKind={setPrecheckKind}
            setPrecheckTarget={setPrecheckTarget}
            setWatch={setWatch}
            setSpec={setSpec}
          />
          <Failure message={error || undefined} />
          <FormActions saving={saving} label={t("center.scheduleForm.save")} onCancel={onClose} />
        </BusyFieldset>
      </form>
    </Modal>
  );
}
