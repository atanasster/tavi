import { useId } from "react";

import type { AppPermissionTarget, AppToolView } from "@tavi/contracts";

import { usePhone } from "../../hooks/page.js";
import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { Select } from "../../ui/Select.js";
import { ACCESS_TITLES, ceilingOf, toolsByAccess } from "./model.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";

/**
 * What an app can do, tool by tool, with Allow / Ask / Block. A choice the page may not make
 * is shown, disabled, with why; the owner decides what each pick changes.
 */

const TARGETS: readonly { readonly value: AppPermissionTarget; readonly labelKey: UiKey }[] = [
  { value: "allow", labelKey: "apps.tools.allow" },
  { value: "ask", labelKey: "apps.tools.ask" },
  { value: "block", labelKey: "apps.tools.block" },
];

export function ToolDecisions({
  tools,
  busy,
  onPick,
  onReview,
}: {
  readonly tools: readonly AppToolView[];
  readonly busy: boolean;
  readonly onPick: (
    tool: AppToolView,
    target: AppPermissionTarget,
  ) => void /** Opens the review a tool waits for, when there is one to open. */;
  readonly onReview?: ((tool: AppToolView) => void) | undefined;
}) {
  const t = useT();
  if (tools.length === 0) return <Empty>{t("apps.tools.none")}</Empty>;
  return (
    <div className="apps-tools">
      {toolsByAccess(tools).map(({ access, tools: group }) => (
        <div key={access} className="apps-tool-group">
          <h4>{t(ACCESS_TITLES[access])}</h4>
          <ul className="rows">
            {group.map((tool) => (
              <li key={tool.toolId} className="row apps-tool">
                <ToolChoice
                  tool={tool}
                  busy={busy}
                  onPick={(target) => onPick(tool, target)}
                  {...(onReview === undefined ? {} : { onReview: () => onReview(tool) })}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Whose words a tool's sentence is: Tavi's own carry no note. */
const SAYS_SOURCE_NOTE: Readonly<Record<NonNullable<AppToolView["saysSource"]>, UiKey | undefined>> = {
  tavi: undefined,
  author: "apps.tools.authorsWords",
  "server-approved": "apps.tools.serversWords",
};

function ToolChoice({
  tool,
  busy,
  onPick,
  onReview,
}: {
  readonly tool: AppToolView;
  readonly busy: boolean;
  readonly onPick: (target: AppPermissionTarget) => void;
  readonly onReview?: () => void;
}) {
  const t = useT();
  const id = useId();
  const phone = usePhone();
  const ceiling = ceilingOf(tool);
  // A tool waiting for its review, or left out by it, is decided there: nothing is set here until it is offered.
  const settable = tool.state === "offered" ? tool.canSetHere : [];
  const reasonId = ceiling === undefined ? undefined : `${id}-why`;
  const label = (
    <span className="apps-tool-name">
      <strong>{tool.title}</strong>
      {tool.says === undefined ? null : (
        <span className="muted">
          {" "}
          {(() => {
            const note = tool.saysSource === undefined ? undefined : SAYS_SOURCE_NOTE[tool.saysSource];
            return note === undefined ? tool.says : t(note, { says: tool.says });
          })()}
        </span>
      )}
    </span>
  );
  return (
    <fieldset className="apps-tool-choice" aria-describedby={reasonId}>
      <legend className="visually-hidden">{tool.title}</legend>
      {label}
      {phone ? (
        <Select
          aria-label={t("apps.tools.whatTaviDoes", { tool: tool.title })}
          value={tool.decision}
          disabled={busy || settable.length === 0}
          onChange={(event) => onPick(event.target.value as AppPermissionTarget)}
        >
          {TARGETS.map((target) => (
            <option key={target.value} value={target.value} disabled={!settable.includes(target.value)}>
              {t(target.labelKey)}
            </option>
          ))}
        </Select>
      ) : (
        <span className="apps-tool-targets">
          {TARGETS.map((target) => {
            const allowed = settable.includes(target.value);
            return (
              <label key={target.value} className={allowed ? undefined : "muted"}>
                <input
                  type="radio"
                  name={id}
                  value={target.value}
                  checked={tool.decision === target.value}
                  disabled={busy || !allowed}
                  aria-describedby={allowed ? undefined : reasonId}
                  onChange={() => onPick(target.value)}
                />{" "}
                {t(target.labelKey)}
              </label>
            );
          })}
        </span>
      )}
      {ceiling === undefined ? null : (
        <span id={reasonId} className="meta-sm">
          {ceiling}
          {tool.state !== "offered" && onReview !== undefined ? (
            <>
              {" "}
              <Button variant="link" onClick={onReview}>
                {t("apps.tools.reviewIt")}
              </Button>
            </>
          ) : null}
        </span>
      )}
    </fieldset>
  );
}
