import { useId, useState } from "react";

import { BUILTIN_MEMORY_PROVIDER_ID, type MemoryEgressField } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { useLoaded } from "../../hooks/use-loaded.js";
import { Failure, InlineConfirm, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { LoadError } from "../settings/FormParts.js";
import { changeMemoryProvider, loadMemoryProvider } from "./memory-api.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/** What each egress switch says it lets the provider receive. */
const EGRESS_LABELS: Readonly<Record<MemoryEgressField, { readonly label: string; readonly hint: string }>> = {
  records: { label: "Records", hint: "Approved memories of this workspace, never sensitive ones" },
  personal: { label: "Personal memory too", hint: "Your own memory, shared by all your workspaces" },
  conversation: { label: "Conversation", hint: "Each recall's query and the chat spans it drafts proposals from" },
};
/**
 * *More → Provider*: the
 * workspace's memory provider, what choosing it means (its declaration's
 * disclosure), and the three egress switches, *Personal memory too* under
 * *Records* and off while *Records* is. Choosing an external provider or
 * turning a switch on asks first, with what the owner says it sends; the
 * provider's egress starts off. One that is not running falls back to the
 * built-in, said here. `onChanged` is told after each change it made.
 */
export function MemoryProviderSettings({ onChanged }: { readonly onChanged?: () => void }) {
  const { client, workspaceId } = useWorkspace();
  const {
    data: answer,
    error: loadError,
    reload,
    replace: setAnswer,
  } = useLoaded(() => loadMemoryProvider(client, workspaceId), [client, workspaceId]);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** A change waiting for the person's yes, with what the owner said it sends. */
  const [asking, setAsking] = useState<{
    readonly change: Parameters<typeof changeMemoryProvider>[2];
    readonly message: string;
    readonly done: string;
  }>();
  const id = useId();

  if (answer === undefined) {
    return loadError === undefined ? null : <LoadError error={loadError} reload={reload} />;
  }
  const change = async (wanted: Parameters<typeof changeMemoryProvider>[2], done: string, confirmed = false): Promise<void> => {
    setBusy(true);
    setNote(undefined);
    const outcome = await changeMemoryProvider(client, workspaceId, wanted, answer.revision, confirmed);
    setBusy(false);
    if (outcome.ok) {
      setAnswer(outcome.value);
      setError(undefined);
      setAsking(undefined);
      setNote(outcome.value.note === undefined ? done : `${done} ${outcome.value.note}`);
      onChanged?.();
    } else if (outcome.code === "APPROVAL_REQUIRED") {
      setError(undefined);
      setAsking({ change: wanted, message: outcome.message, done });
    } else {
      setError(outcome.message);
      if (outcome.code === "CONFLICT") reload();
    }
  };
  const selected = answer.providers.find((provider) => provider.id === answer.selected);
  const external = selected?.kind === "plugin" || (selected === undefined && answer.selected !== BUILTIN_MEMORY_PROVIDER_ID);
  const receives = new Set(selected?.receives ?? []);
  const switchOf = (field: MemoryEgressField): boolean => (field === "personal" ? answer.egress.includePersonal : answer.egress[field]);
  const unavailable = (field: MemoryEgressField): boolean =>
    busy ||
    asking !== undefined ||
    !external ||
    (!switchOf(field) && !receives.has(field === "conversation" ? "conversation" : "records")) ||
    (field === "personal" && !answer.egress.records);
  const egressSwitch = (field: MemoryEgressField) => (
    <label>
      <input
        type="checkbox"
        role="switch"
        aria-describedby={`${id}-${field}`}
        checked={switchOf(field)}
        disabled={unavailable(field)}
        onChange={(event) =>
          void change({ field, on: event.target.checked }, `${EGRESS_LABELS[field].label} ${event.target.checked ? "on" : "off"}.`)
        }
      />{" "}
      {EGRESS_LABELS[field].label}
    </label>
  );
  return (
    <section className="memory-provider" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>Provider</h4>
      <p>
        <Field
          id={`${id}-provider`}
          label="Memory provider"
          inline
          hintAs="span"
          hintClassName="meta-sm"
          hint={
            external
              ? (selected?.disclosure ?? "Its declaration cannot be read while it is not running.")
              : "The built-in: memory stays on this machine, ranked by Tavi itself."
          }
        >
          <Select
            value={answer.selected}
            disabled={busy || asking !== undefined}
            onChange={(event) => void change({ providerId: event.target.value }, `Memory provider: ${event.target.value}.`)}
          >
            {answer.providers.some((provider) => provider.id === answer.selected) ? null : (
              <option value={answer.selected}>{answer.selected} (not running)</option>
            )}
            {answer.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.kind === "builtin" ? "Built-in" : provider.id}
              </option>
            ))}
          </Select>
        </Field>
      </p>
      {answer.fallback === undefined ? null : <Failure role="status">{answer.fallback}</Failure>}
      <ul className="list-reset memory-provider-egress" aria-label="What the provider may receive">
        <li>
          {egressSwitch("records")}{" "}
          <span id={`${id}-records`} className="meta-sm">
            {EGRESS_LABELS.records.hint}
          </span>
          <ul className="list-reset memory-provider-nested">
            <li>
              {egressSwitch("personal")}{" "}
              <span id={`${id}-personal`} className="meta-sm">
                {answer.egress.records ? EGRESS_LABELS.personal.hint : `${EGRESS_LABELS.personal.hint}; needs Records on`}
              </span>
            </li>
          </ul>
        </li>
        <li>
          {egressSwitch("conversation")}{" "}
          <span id={`${id}-conversation`} className="meta-sm">
            {EGRESS_LABELS.conversation.hint}
          </span>
        </li>
      </ul>
      {external ? null : <p className="meta-sm">The built-in receives nothing: the switches apply to a provider plugin.</p>}
      {answer.pendingRemovals === 0 ? null : (
        <p className="meta-sm">
          {plural(answer.pendingRemovals, "forgotten memory", "forgotten memories")} still to be removed from a provider when it next runs.
        </p>
      )}
      {asking === undefined ? null : (
        <InlineConfirm
          className="memory-confirm"
          label="Send memory to the provider"
          message={asking.message}
          confirmLabel={busy ? "Saving…" : "Go on"}
          cancelLabel="Cancel"
          busy={busy}
          onConfirm={() => void change(asking.change, asking.done, true)}
          onCancel={() => setAsking(undefined)}
        />
      )}
      <StatusNote note={note} />
      {error === undefined ? null : <Failure>{error}</Failure>}
    </section>
  );
}
