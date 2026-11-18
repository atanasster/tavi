import type { SystemPromptLayer } from "@tavi/contracts";

import { formatCount } from "../../lib/format.js";
import { layerSource } from "./memory-model.js";

/**
 * One layer of a task's instructions, as `system-prompt preview` lists it.
 * Its own module so the chat panel's Instructions tab draws it without
 * loading the Soul & memory page.
 */
export function LayerRow({ layer }: { readonly layer: SystemPromptLayer }) {
  return (
    <li className={layer.active ? "soul-layer" : "soul-layer off"}>
      <span className="soul-layer-bullet" aria-hidden="true" />
      <span className="soul-layer-name">
        <span className="soul-layer-label">{layer.label}</span>
        {layer.active ? null : <span className="visually-hidden"> (not sent)</span>}
        <small>{layerSource(layer)}</small>
        {layer.generated && layer.detail !== undefined ? (
          <details className="soul-layer-detail">
            <summary className="disclosure">{layer.sample ? "Sample facts" : "What it holds"}</summary>
            {layer.sample ? <pre>{layer.detail}</pre> : <p>{layer.detail}</p>}
          </details>
        ) : null}
      </span>
      <span className="soul-layer-len meta-sm">
        {layer.length === undefined ? (
          "per response"
        ) : (
          <>
            {/* The unit shows: a bare count reads as anything (tokens, bytes). */}
            {formatCount(layer.length)} characters
          </>
        )}
      </span>
    </li>
  );
}
