import { useId, useState } from "react";

import { BUILTIN_MEMORY_PROVIDER_ID, type MemoryEgressField } from "@tavi/contracts";

import { currentLocale, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Failure, InlineConfirm, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { LoadError } from "../settings/FormParts.js";
import { changeMemoryProvider, loadMemoryProvider } from "./memory-api.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Field } from "../../ui/Field.js";

/** What each egress switch says it lets the provider receive. */
const EGRESS_LABELS: Readonly<Record<MemoryEgressField, { readonly label: UiKey; readonly hint: UiKey }>> = {
  records: { label: "center.memoryProvider.records", hint: "center.memoryProvider.recordsHint" },
  personal: { label: "center.memoryProvider.personal", hint: "center.memoryProvider.personalHint" },
  conversation: { label: "center.memoryProvider.conversation", hint: "center.memoryProvider.conversationHint" },
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
  const t = useT();
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
      // The owner says what it sends in the workspace's language beside its English message: a page not in English shows that.
      const disclosure = outcome.details?.["disclosure"];
      setAsking({
        change: wanted,
        message: currentLocale() !== "en" && typeof disclosure === "string" ? disclosure : outcome.message,
        done,
      });
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
          void change(
            { field, on: event.target.checked },
            t(event.target.checked ? "center.memoryProvider.switchOn" : "center.memoryProvider.switchOff", {
              label: t(EGRESS_LABELS[field].label),
            }),
          )
        }
      />{" "}
      {t(EGRESS_LABELS[field].label)}
    </label>
  );
  return (
    <section className="memory-provider" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{t("center.memoryProvider.title")}</h4>
      <p>
        <Field
          id={`${id}-provider`}
          label={t("center.memoryProvider.label")}
          inline
          hintAs="span"
          hintClassName="meta-sm"
          hint={external ? (selected?.disclosure ?? t("center.memoryProvider.unreadable")) : t("center.memoryProvider.builtinHint")}
        >
          <Select
            value={answer.selected}
            disabled={busy || asking !== undefined}
            onChange={(event) =>
              void change({ providerId: event.target.value }, t("center.memoryProvider.chosen", { provider: event.target.value }))
            }
          >
            {answer.providers.some((provider) => provider.id === answer.selected) ? null : (
              <option value={answer.selected}>{t("center.memoryProvider.notRunning", { provider: answer.selected })}</option>
            )}
            {answer.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.kind === "builtin" ? t("center.memoryProvider.builtin") : provider.id}
              </option>
            ))}
          </Select>
        </Field>
      </p>
      {answer.fallback === undefined ? null : <Failure role="status">{answer.fallback}</Failure>}
      <ul className="list-reset memory-provider-egress" aria-label={t("center.memoryProvider.receives")}>
        <li>
          {egressSwitch("records")}{" "}
          <span id={`${id}-records`} className="meta-sm">
            {t(EGRESS_LABELS.records.hint)}
          </span>
          <ul className="list-reset memory-provider-nested">
            <li>
              {egressSwitch("personal")}{" "}
              <span id={`${id}-personal`} className="meta-sm">
                {answer.egress.records ? t(EGRESS_LABELS.personal.hint) : t("center.memoryProvider.personalHintOff")}
              </span>
            </li>
          </ul>
        </li>
        <li>
          {egressSwitch("conversation")}{" "}
          <span id={`${id}-conversation`} className="meta-sm">
            {t(EGRESS_LABELS.conversation.hint)}
          </span>
        </li>
      </ul>
      {external ? null : <p className="meta-sm">{t("center.memoryProvider.builtinNothing")}</p>}
      {answer.pendingRemovals === 0 ? null : (
        <p className="meta-sm">{t("center.memoryProvider.pendingRemovals", { count: answer.pendingRemovals })}</p>
      )}
      {asking === undefined ? null : (
        <InlineConfirm
          className="memory-confirm"
          label={t("center.memoryProvider.ask")}
          message={asking.message}
          confirmLabel={busy ? t("ui.parts.saving") : t("center.memoryProvider.goOn")}
          cancelLabel={t("ui.confirm.cancel")}
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
