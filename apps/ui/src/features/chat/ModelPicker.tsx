import { useId, useRef, useState } from "react";

import { Icon } from "../../ui/Icon.js";
import { StatusNote } from "../../ui/Parts.js";
import { Popover } from "../../ui/Popover.js";
import { Select } from "../../ui/Select.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { lifecycleNotice, loadModels, type BrowsedModel } from "../settings/models-api.js";
import type { Outcome } from "../../lib/ipc.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { formatCount } from "../../lib/format.js";
import { MODEL_PICKER_EDGE_PX } from "../../lib/layout.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
import { reduceModelName } from "../../lib/model-name.js";

/** A model's state as a badge's tone: a usable one plain, a capable one primary, one gone the destructive tone. */
const STATE_BADGES: Readonly<Record<BrowsedModel["state"], string>> = {
  available: "",
  capable: "badge-capable",
  unavailable: "badge-bad",
};

function formatOptionLabel(model: BrowsedModel, models: readonly BrowsedModel[]): string {
  const reduced = reduceModelName(model.displayName ?? model.modelId);
  const duplicates = models.filter((m) => reduceModelName(m.displayName ?? m.modelId) === reduced);
  if (duplicates.length > 1) {
    return `${reduced} (${model.connectionLabel})`;
  }
  return reduced;
}

/** ` · Retiring` after a model whose lifecycle warns (not a mere notice); nothing otherwise. */
function lifecycleSuffix(model: BrowsedModel): string {
  const notice = lifecycleNotice(model);
  return notice === undefined || notice.level === "info" ? "" : ` · ${notice.label}`;
}

/**
 * The composer's model picker: the models every connection has discovered
 * (`models discover`, the catalog the Models view browses). What a pick does
 * is the caller's (`onPick`): the chat's own model, and the default for new
 * chats — its note shows beside the picker.
 */
export function ModelPicker({
  target,
  onPick,
  onManage,
}: {
  /** The chat's model as the strip names it: `connection/model`. */
  readonly target: string | undefined;
  /** A model was picked: its note, or why it was not saved. */
  readonly onPick: (connectionId: string, model: string) => Promise<Outcome<string | undefined>>;
  readonly onManage: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const { data, error, reload } = useLoaded(() => loadModels(client, workspaceId));
  // A pick's note, with the model the chat had and the one picked: shown while the chat holds either (a refused
  // pick leaves the old one), never on another chat's model.
  const [picked, setPicked] = useState<{ readonly from: string | undefined; readonly to: string; readonly note: string | undefined }>();
  const note = picked !== undefined && (picked.from === target || picked.to === target) ? picked.note : undefined;
  const [saving, setSaving] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoButtonRef = useRef<HTMLButtonElement>(null);

  const models = data?.models ?? [];
  // Models from more than one place say where each is from: a local server's beside a gateway's hundreds.
  const connections = new Set(models.map((model) => model.connectionId));
  const known = models.some((model) => `${model.connectionId}/${model.modelId}` === target);
  // The chat's own model, when it warns: said under the picker until a pick's own note replaces it.
  const chosen = models.find((model) => `${model.connectionId}/${model.modelId}` === target);
  const chosenNotice = chosen === undefined ? undefined : lifecycleNotice(chosen);
  const chosenLifecycle = chosenNotice === undefined || chosenNotice.level === "info" ? undefined : `This model ${chosenNotice.text}.`;
  const selectedModel =
    models.find((entry) => `${entry.connectionId}/${entry.modelId}` === target) ??
    (target !== undefined ? models.find((entry) => entry.modelId === target) : undefined);

  const pick = async (value: string): Promise<void> => {
    const model = models.find((entry) => `${entry.connectionId}/${entry.modelId}` === value);
    if (model === undefined || saving) return;
    setSaving(true);
    const written = await onPick(model.connectionId, model.modelId);
    setSaving(false);
    // A pick of a model that warns says so with the pick's own note, announced together.
    const notice = written.ok ? lifecycleNotice(model) : undefined;
    const warns = notice !== undefined && notice.level !== "info" ? `This model ${notice.text}.` : undefined;
    const said = written.ok ? written.value : written.message;
    setPicked({ from: target, to: value, note: said === undefined ? warns : warns === undefined ? said : `${said} ${warns}` });
    reload();
  };

  const popoverId = useId();

  const infoButton = (
    <Button
      ref={infoButtonRef}
      variant="ghost"
      size={["icon", "sm"]}
      className={infoOpen ? "active" : undefined}
      aria-label="Model specifications"
      aria-expanded={infoOpen}
      aria-haspopup="dialog"
      aria-controls={infoOpen ? popoverId : undefined}
      onClick={() => setInfoOpen((open) => !open)}
    >
      <Icon name="info" size="sm" />
    </Button>
  );

  return (
    <div className="model-picker">
      <div className="model-picker-controls">
        {models.length === 0 ? (
          <Button variant="ghost" size="sm" className="model-selector truncate" title={target} onClick={onManage}>
            {/* The model's own name ("gemini-3.8-flash"); the whole `connection/model` is the title. */}
            {error !== undefined
              ? "Models unreadable"
              : data === undefined
                ? "Reading models…"
                : target === undefined
                  ? "Configure model"
                  : reduceModelName(target)}
            <Icon name="chevron-down" size="sm" />
          </Button>
        ) : (
          <Select
            aria-label="Chat model"
            className="model-select"
            contentClassName="compact"
            side="top"
            value={known ? (target ?? "") : ""}
            disabled={saving}
            onChange={(event) => void pick(event.target.value)}
            searchPlaceholder="Search models…"
          >
            {known ? null : <option value="">{target ?? "Choose a model"}</option>}
            {models.map((model) => (
              <option
                key={`${model.connectionId}/${model.modelId}`}
                value={`${model.connectionId}/${model.modelId}`}
                disabled={model.state === "unavailable"}
                {...(connections.size > 1 && !formatOptionLabel(model, models).endsWith(`(${model.connectionLabel})`)
                  ? { "data-detail": model.connectionLabel }
                  : {})}
              >
                {formatOptionLabel(model, models)}
                {/* A model that retires, is retired or redirected says so where it is picked. */}
                {lifecycleSuffix(model)}
              </option>
            ))}
          </Select>
        )}
        <Tooltip text="Model specifications" suppressed={infoOpen}>
          {infoButton}
        </Tooltip>
      </div>
      <StatusNote note={note} className="composer-hint model-note" />
      {/* The chat's model's lifecycle, when no pick's note already says it: a standing line, not an announcement. */}
      <StatusNote note={note === undefined ? chosenLifecycle : undefined} className="composer-hint model-note" announce={false} />
      {infoOpen ? (
        <Popover
          id={popoverId}
          className="model-info-popover surface-popover"
          label="Model specifications"
          anchor={infoButtonRef}
          anchoring={{ align: "end", edge: MODEL_PICKER_EDGE_PX }}
          deps={[target, selectedModel]}
          // Opened, and placed: focus goes into it, so its button is the next stop rather than the page's last.
          initialFocus="button"
          onClose={(by) => {
            setInfoOpen(false);
            if (by === "escape") infoButtonRef.current?.focus();
          }}
        >
          <div className="model-info-header">
            <div className="model-info-title-row">
              <span className="model-info-title truncate">
                {selectedModel?.displayName ??
                  selectedModel?.modelId ??
                  (target !== undefined ? reduceModelName(target) : "No model selected")}
              </span>
              {selectedModel !== undefined ? (
                <span className={`badge ${STATE_BADGES[selectedModel.state]}`}>{selectedModel.state}</span>
              ) : null}
            </div>
            {selectedModel?.displayName !== undefined && selectedModel.displayName !== selectedModel.modelId ? (
              <span className="model-info-id truncate">{selectedModel.modelId}</span>
            ) : null}
          </div>

          <dl className="model-info-specs">
            <div className="model-info-row">
              <dt>Connection</dt>
              <dd className="truncate">{selectedModel?.connectionLabel ?? (target !== undefined ? target.split("/")[0] : "—")}</dd>
            </div>
            <div className="model-info-row">
              <dt>Context Window</dt>
              <dd className="truncate">
                {selectedModel?.contextWindow !== undefined ? `${formatCount(selectedModel.contextWindow)} tokens` : "Not disclosed"}
              </dd>
            </div>
            <div className="model-info-row">
              <dt>Max Output</dt>
              <dd className="truncate">
                {selectedModel?.maxTokens !== undefined ? `${formatCount(selectedModel.maxTokens)} tokens` : "Not disclosed"}
              </dd>
            </div>
            {selectedModel?.capabilities !== undefined && selectedModel.capabilities.length > 0 ? (
              <div className="model-info-row">
                <dt>Capabilities</dt>
                <dd className="truncate">
                  <div className="model-info-chips">
                    {selectedModel.capabilities.map((cap) => (
                      <span key={cap} className="badge">
                        {cap}
                      </span>
                    ))}
                  </div>
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="model-info-footer">
            <Button
              variant="secondary"
              size="sm"
              className="model-info-manage-button"
              onClick={() => {
                setInfoOpen(false);
                onManage();
              }}
            >
              <Icon name="sliders" size="sm" />
              <span>Model settings</span>
            </Button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
