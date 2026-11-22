import type { SystemPromptLayer } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";
import { layerSource } from "./memory-model.js";

/**
 * One layer of a task's instructions, as `system-prompt preview` lists it.
 * Its own module so the chat panel's Instructions tab draws it without
 * loading the Soul & memory page.
 */
export function LayerRow({ layer }: { readonly layer: SystemPromptLayer }) {
  const t = useT();
  return (
    <li className={layer.active ? "soul-layer" : "soul-layer off"}>
      <span className="soul-layer-bullet" aria-hidden="true" />
      <span className="soul-layer-name">
        <span className="soul-layer-label">{layer.label}</span>
        {layer.active ? null : <span className="visually-hidden">{t("center.layerRow.notSent")}</span>}
        <small>{layerSource(layer)}</small>
        {layer.generated && layer.detail !== undefined ? (
          <details className="soul-layer-detail">
            <summary className="disclosure">{layer.sample ? t("center.layerRow.sample") : t("center.layerRow.holds")}</summary>
            {layer.sample ? <pre>{layer.detail}</pre> : <p>{layer.detail}</p>}
          </details>
        ) : null}
      </span>
      <span className="soul-layer-len meta-sm">
        {layer.length === undefined
          ? t("center.layerRow.perResponse")
          : // The unit shows: a bare count reads as anything (tokens, bytes).
            t("center.layerRow.characters", { count: layer.length })}
      </span>
    </li>
  );
}
