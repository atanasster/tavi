import { useId, useState } from "react";

import { type MemoryKind, type MemoryScopeTarget, MAX_MEMORY_TITLE_CHARS } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import { Select } from "../../ui/Select.js";
import { FormActions, FormFailure } from "../settings/FormParts.js";
import { rememberMemory, type AgentSummary } from "./memory-api.js";
import { KIND_LABELS, MEMORY_GROUPS } from "./memory-model.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/** Remember: exact content the reader writes, in the scope they pick. */
export function RememberForm({
  id,
  agents,
  onDone,
}: {
  readonly id: string;
  readonly agents: readonly AgentSummary[];
  readonly onDone: (saved: boolean) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [scope, setScope] = useState<MemoryScopeTarget>("personal");
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const ids = useId();
  const preference = kind === "preference";
  const problem =
    body.trim() === "" ? t("center.remember.needsBody") : preference && key.trim() === "" ? t("center.remember.needsKey") : undefined;

  const submit = (): void => {
    if (problem !== undefined) {
      setFailure(problem);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    void rememberMemory(client, workspaceId, {
      kind,
      scope,
      title: title.trim() || undefined,
      body,
      sensitive,
      preferenceKey: preference ? key.trim() : undefined,
    }).then((outcome) => {
      setBusy(false);
      if (outcome.ok) onDone(true);
      else setFailure(outcome.message);
    });
  };

  return (
    <form
      id={id}
      className="memory-form memory-remember"
      aria-label={t("center.remember.label")}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="memory-form-row">
        <span>
          <Field id={`${ids}-kind`} label={t("center.remember.kind")}>
            <Select value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as MemoryKind)}>
              {MEMORY_GROUPS.map((group) => (
                <option key={group.kind} value={group.kind}>
                  {KIND_LABELS[group.kind]}
                </option>
              ))}
            </Select>
          </Field>
        </span>
        <span>
          <Field id={`${ids}-scope`} label={t("center.remember.where")}>
            <Select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as MemoryScopeTarget)}>
              <option value="personal">{t("center.memoryModel.scope.personal")}</option>
              <option value="workspace">{t("center.memoryModel.scope.workspace")}</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={`agent:${agent.agentId}`}>
                  {t("center.memoryModel.scope.agent", { agent: agent.name })}
                </option>
              ))}
            </Select>
          </Field>
        </span>
      </div>
      <p className="memory-hint meta-sm">
        {scope === "personal"
          ? t("center.remember.hintPersonal")
          : scope === "workspace"
            ? t("center.remember.hintWorkspace")
            : t("center.remember.hintAgent")}
      </p>
      {preference ? (
        <Field id={`${ids}-key`} label={t("center.remember.key")}>
          <input value={key} placeholder="reply.channel" disabled={busy} onChange={(event) => setKey(event.target.value)} />
        </Field>
      ) : null}
      <Field id={`${ids}-title`} label={t("center.remember.title")}>
        <input value={title} maxLength={MAX_MEMORY_TITLE_CHARS} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field id={`${ids}-body`} label={preference ? t("center.remember.value") : t("center.remember.body")}>
        <textarea rows={3} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <label className="memory-check">
        <input type="checkbox" checked={sensitive} disabled={busy} onChange={(event) => setSensitive(event.target.checked)} />
        {t("center.remember.sensitive")}
      </label>
      <FormFailure message={failure} />
      <FormActions
        small
        saving={busy}
        disabled={busy}
        cancelDisabled={busy}
        label={t("center.remember.label")}
        onCancel={() => onDone(false)}
      />
    </form>
  );
}
