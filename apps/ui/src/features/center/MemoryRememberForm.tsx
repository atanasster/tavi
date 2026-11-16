import { useId, useState } from "react";

import { type MemoryKind, type MemoryScopeTarget, MAX_MEMORY_TITLE_CHARS } from "@tavi/contracts";

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
    body.trim() === ""
      ? "Write what to remember."
      : preference && key.trim() === ""
        ? "A preference needs a key, such as reply.channel."
        : undefined;

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
      aria-label="Remember"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="memory-form-row">
        <span>
          <Field id={`${ids}-kind`} label="Kind">
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
          <Field id={`${ids}-scope`} label="Where">
            <Select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as MemoryScopeTarget)}>
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={`agent:${agent.agentId}`}>
                  Agent: {agent.name}
                </option>
              ))}
            </Select>
          </Field>
        </span>
      </div>
      <p className="memory-hint meta-sm">
        {scope === "personal"
          ? "Yours, in every workspace."
          : scope === "workspace"
            ? "Yours, in this workspace only."
            : "Yours, for this agent only."}
      </p>
      {preference ? (
        <Field id={`${ids}-key`} label="Key">
          <input value={key} placeholder="reply.channel" disabled={busy} onChange={(event) => setKey(event.target.value)} />
        </Field>
      ) : null}
      <Field id={`${ids}-title`} label="Title (optional)">
        <input value={title} maxLength={MAX_MEMORY_TITLE_CHARS} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field id={`${ids}-body`} label={preference ? "Value" : "What to remember"}>
        <textarea rows={3} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <label className="memory-check">
        <input type="checkbox" checked={sensitive} disabled={busy} onChange={(event) => setSensitive(event.target.checked)} />
        Sensitive (hidden until revealed)
      </label>
      <FormFailure message={failure} />
      <FormActions small saving={busy} disabled={busy} cancelDisabled={busy} label="Remember" onCancel={() => onDone(false)} />
    </form>
  );
}
