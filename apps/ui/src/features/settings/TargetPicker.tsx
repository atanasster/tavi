import { useDeferredValue, useId, useState, type FormEvent } from "react";

import { readsVideo } from "@tavi/contracts";

import { IconButton } from "../../ui/IconButton.js";
import { Select } from "../../ui/Select.js";
import { browse, capacityLabel, describeTarget, sameTarget, type BrowsedModel, type ModelsData, type TargetRef } from "./models-api.js";
import type { Outcome } from "../../lib/ipc.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions } from "./FormParts.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";

/** Rows a picker lists at once; a search narrows the rest. */
const SHOWN = 100;
/** The owner keeps at most three fallbacks (`ModelsPayloadSchema.fallback`). */
const MAX_FALLBACKS = 3;

const refOf = (model: BrowsedModel): TargetRef => ({ connectionId: model.connectionId, model: model.modelId });
const keyOf = (target: TargetRef): string => `${target.connectionId}/${target.model ?? ""}`;

/**
 * Choose what a role (or the workspace default) runs: one searchable list of
 * every discovered model, a pick for the primary and, for a role, up to three
 * fallbacks tried in order. A model can be tested from here before saving.
 */
export function TargetPicker({
  title,
  intro,
  data,
  loading,
  initial,
  initialConnection = "",
  allowFallbacks,
  onTest,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly intro: string;
  readonly data: ModelsData;
  /** The page is re-reading its models (a connection was just added). */
  readonly loading: boolean;
  readonly initial: { readonly primary?: TargetRef | undefined; readonly fallback: readonly TargetRef[] };
  readonly initialConnection?: string;
  readonly allowFallbacks: boolean;
  readonly onTest: (target: TargetRef) => Promise<Outcome<string | undefined>>;
  readonly onSave: (primary: TargetRef, fallback: readonly TargetRef[]) => Promise<Outcome<string | undefined>>;
  readonly onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [connectionId, setConnectionId] = useState(initialConnection);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [primary, setPrimary] = useState<TargetRef | undefined>(initial.primary);
  const [fallback, setFallback] = useState<readonly TargetRef[]>(initial.fallback);
  const [working, setWorking] = useState<"save" | "test" | undefined>();
  const [result, setResult] = useState<{ readonly ok: boolean; readonly message: string } | undefined>();
  const listId = useId();

  const matching = browse(data.models, { search: deferredSearch, connectionId, state: "", toolsOnly }, "state");
  const shown = matching.slice(0, SHOWN);
  const choose = (model: BrowsedModel): void => {
    const target = refOf(model);
    setPrimary(target);
    setFallback((chain) => chain.filter((entry) => !sameTarget(entry, target)));
    setResult(undefined);
  };
  const addFallback = (model: BrowsedModel): void => setFallback((chain) => [...chain, refOf(model)]);
  const move = (index: number, by: -1 | 1): void =>
    setFallback((chain) => {
      const next = [...chain];
      const [entry] = next.splice(index, 1);
      if (entry !== undefined) next.splice(index + by, 0, entry);
      return next;
    });
  const primaryModel = primary === undefined ? undefined : data.models.find((model) => sameTarget(refOf(model), primary));

  const test = async (): Promise<void> => {
    if (primary === undefined) return;
    setWorking("test");
    const outcome = await onTest(primary);
    setWorking(undefined);
    setResult(outcome.ok ? { ok: true, message: outcome.value ?? "Answered." } : { ok: false, message: outcome.message });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (primary === undefined || working !== undefined) return;
    setWorking("save");
    void onSave(primary, allowFallbacks ? fallback : []).then((outcome) => {
      setWorking(undefined);
      if (outcome.ok) onClose();
      else setResult({ ok: false, message: outcome.message });
    });
  };

  return (
    <Modal title={title} wide busy={working === "save"} onClose={onClose}>
      <form className="picker" onSubmit={submit}>
        <p className="picker-intro">{intro}</p>
        <section className="picker-chain" aria-label="Chosen models">
          <div className="picker-slot">
            <span className="picker-slot-label">Primary</span>
            {primary === undefined ? <span className="muted">Pick a model below</span> : <TargetName target={primary} data={data} />}
          </div>
          {allowFallbacks ? (
            <div className="picker-slot">
              <span className="picker-slot-label">Fallbacks</span>
              {fallback.length === 0 ? (
                <span className="muted">None: add up to {MAX_FALLBACKS}, tried in order if the primary fails</span>
              ) : (
                <ol className="picker-fallbacks">
                  {fallback.map((entry, index) => {
                    const { name } = describeTarget(entry, data);
                    return (
                      <li key={keyOf(entry)}>
                        <TargetName target={entry} data={data} />
                        <span className="picker-fallback-actions">
                          <IconButton
                            icon="chevron-up"
                            size="sm"
                            label={`Move ${name} earlier`}
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          />
                          <IconButton
                            icon="chevron-down"
                            size="sm"
                            label={`Move ${name} later`}
                            disabled={index === fallback.length - 1}
                            onClick={() => move(index, 1)}
                          />
                          <IconButton
                            icon="close"
                            size="sm"
                            label={`Remove ${name} from fallbacks`}
                            onClick={() => setFallback((chain) => chain.filter((_, slot) => slot !== index))}
                          />
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          ) : null}
        </section>

        <div className="picker-filters" role="search">
          <input
            aria-label="Search models"
            placeholder={`Search ${data.models.length} models`}
            value={search}
            autoComplete="off"
            onChange={(event) => setSearch(event.target.value)}
          />
          {data.connections.length > 1 ? (
            <Select aria-label="Connection" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              <option value="">All connections</option>
              {data.connections.map((connection) => (
                <option key={connection.connectionId} value={connection.connectionId}>
                  {connection.label}
                </option>
              ))}
            </Select>
          ) : null}
          <label className="toggle">
            <input type="checkbox" checked={toolsOnly} onChange={(event) => setToolsOnly(event.target.checked)} /> Tool calling only
          </label>
        </div>

        {matching.length === 0 ? (
          <Empty>
            {loading
              ? "Loading models…"
              : data.models.length === 0
                ? "No model is discovered yet. Rediscover the connection, then try again."
                : "No model matches."}
          </Empty>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the list is the radio group; each row in it is a radio
          <ul className="picker-list list-reset" id={listId} role="radiogroup" aria-label="Models">
            {shown.map((model) => {
              const target = refOf(model);
              const isPrimary = sameTarget(target, primary);
              const inChain = fallback.some((entry) => sameTarget(entry, target));
              const name = model.displayName ?? model.modelId;
              return (
                <li
                  key={keyOf(target)}
                  className={`picker-row${isPrimary ? " picker-row-chosen" : ""}${model.state === "unavailable" ? " picker-row-unavailable" : ""}`}
                >
                  <label className="picker-choice">
                    <input type="radio" name={listId} checked={isPrimary} onChange={() => choose(model)} />
                    <span className="picker-model">
                      <span className="picker-model-name truncate">{name}</span>
                      <span className="picker-model-meta meta-sm truncate">
                        {[model.connectionLabel, model.displayName === undefined ? undefined : model.modelId, capacityLabel(model)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="picker-badges">
                      {model.capabilities.includes("tools") ? <span className="badge">tools</span> : null}
                      {readsVideo(model.capabilities) ? <span className="badge">video</span> : null}
                      {model.state === "unavailable" ? <span className="badge badge-bad">unavailable</span> : null}
                      {model.stale ? <span className="badge badge-stale">stale</span> : null}
                    </span>
                  </label>
                  {allowFallbacks ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Add ${name} as a fallback`}
                      disabled={isPrimary || inChain || fallback.length >= MAX_FALLBACKS}
                      onClick={() => addFallback(model)}
                    >
                      {inChain ? "Fallback" : "+ Fallback"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {matching.length > SHOWN ? (
          <p className="muted picker-more">
            Showing {SHOWN} of {matching.length}. Search to narrow the list.
          </p>
        ) : null}
        {result !== undefined ? (
          <p className={result.ok ? "notice" : "failure"} role="status">
            {result.message}
          </p>
        ) : null}

        <FormActions
          saving={working === "save"}
          disabled={primary === undefined || working !== undefined}
          cancelDisabled={working === "save"}
          label="Save"
          onCancel={onClose}
        >
          <Button
            className="picker-test"
            disabled={primary === undefined || working !== undefined || primaryModel?.providerManaged === true}
            title={primaryModel?.providerManaged === true ? "Use an approved task to test a plugin model." : undefined}
            onClick={() => void test()}
          >
            {working === "test" ? "Testing…" : "Test primary"}
          </Button>
        </FormActions>
      </form>
    </Modal>
  );
}

/** A target as a row shows it: the model, then its connection. */
export function TargetName({ target, data }: { readonly target: TargetRef; readonly data: Pick<ModelsData, "models" | "connections"> }) {
  const { name, connection } = describeTarget(target, data);
  return (
    <span className="target-name">
      <span className="target-model">{name}</span> <span className="muted">{connection}</span>
    </span>
  );
}
