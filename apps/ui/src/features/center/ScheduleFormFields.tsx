import type { Dispatch, SetStateAction } from "react";
import {
  SCHEDULE_DEFAULT_MAX_RUN_MINUTES,
  SCHEDULE_MAX_EVERY_HOURS,
  SCHEDULE_ONE_CALL_TOKENS,
  SCHEDULE_PRECHECK_KINDS,
  SCHEDULE_WATCH_MAX_PER_HOUR,
  type SchedulePrecheckKind,
  type ScheduleSpec,
} from "@tavi/contracts";

import { Icon } from "../../ui/Icon.js";
import { Select } from "../../ui/Select.js";
import { Button } from "../../ui/Button.js";
import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { withParts } from "../../ui/with-parts.js";

/** The form's words for each pre-check, and what its field asks for. */
const PRECHECK_LABELS: Readonly<Record<SchedulePrecheckKind, { readonly label: UiKey; readonly target: string }>> = {
  "page-changed": { label: "center.scheduleFields.precheck.page", target: "https://example.com/page" },
  "feed-has-new": { label: "center.scheduleFields.precheck.feed", target: "https://example.com/feed.xml" },
  "file-changed": { label: "center.scheduleFields.precheck.file", target: "/path/under/an/fs-root" },
};

/** How often a watcher made in the form checks: every hour up to every `SCHEDULE_MAX_EVERY_HOURS`. */
const WATCH_EVERY_HOURS: readonly number[] = [1, 2, 3, 4, 6, 8, 12].filter((hours) => hours <= SCHEDULE_MAX_EVERY_HOURS);

/** `spec` checking every `hours` instead of at its times, on the same days, window and zone. */
function everyHoursSpec(spec: ScheduleSpec, hours: number): ScheduleSpec {
  const { at: _at, times: _times, everyHours: _every, ...rest } = spec;
  return { ...rest, everyHours: hours };
}

/** The tools a schedule may call without asking: typed (with the owner's tools suggested) or added from a chat's, each removable. */
export function ScheduleToolsField({
  tool,
  tools,
  suggestions,
  unpicked,
  writing,
  setTool,
  setTools,
  addTool,
  toolListId,
}: {
  /** The pattern being typed. */
  readonly tool: string;
  readonly tools: readonly string[];
  /** The owner's tools and families not yet added. */
  readonly suggestions: readonly string[];
  /** The offered tools not yet added. */
  readonly unpicked: readonly string[];
  /** The added tools that can change or send things. */
  readonly writing: readonly string[];
  readonly setTool: (tool: string) => void;
  readonly setTools: Dispatch<SetStateAction<readonly string[]>>;
  readonly addTool: () => void;
  /** The suggestions' datalist id (the form's own). */
  readonly toolListId: string;
}) {
  const t = useT();
  // A search only sends its query out, which its own line says: it changes nothing.
  const changing = writing.filter((tool) => tool !== "web_search");
  return (
    <>
      <label>
        {t("center.scheduleFields.allowedTool")}
        <input
          aria-label={t("center.scheduleFields.allowedTool")}
          value={tool}
          maxLength={128}
          list={toolListId}
          autoComplete="off"
          placeholder={t("center.scheduleFields.toolPlaceholder")}
          onChange={(event) => setTool(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the tool rather than saving the whole form with it unfinished.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (tool.trim()) addTool();
          }}
        />
      </label>
      <datalist id={toolListId}>
        {suggestions.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <Button onClick={addTool}>{t("center.scheduleFields.addTool")}</Button>
      <div>
        {tools.map((value) => (
          <span className="chip" key={value}>
            {value}
            <Button
              variant="bare"
              aria-label={t("center.scheduleFields.removeTool", { tool: value })}
              onClick={() => setTools((before) => before.filter((item) => item !== value))}
            >
              <Icon name="close" size="sm" />
            </Button>
          </span>
        ))}
      </div>
      {unpicked.length > 0 ? (
        <p>
          {withParts(t("center.scheduleFields.usedInChat"), {
            tools: unpicked.map((value) => (
              <Button
                key={value}
                variant="link"
                aria-label={t("center.scheduleFields.addToolNamed", { tool: value })}
                onClick={() => setTools((before) => (before.includes(value) ? before : [...before, value]))}
              >
                {value}
              </Button>
            )),
          })}
        </p>
      ) : null}
      {changing.length > 0 ? <p>{t("center.scheduleFields.changing", { tools: changing.join(", ") })}</p> : null}
      {writing.includes("web_search") ? <p>{t("center.scheduleFields.webSearch")}</p> : null}
      <p>{t("center.scheduleFields.allowlist")}</p>
    </>
  );
}

/** How long a run may take, and how many tokens it may use. */
export function ScheduleLimitFields({
  runLimit,
  maxTokens,
  setRunLimit,
  setMaxTokens,
}: {
  readonly runLimit: string;
  readonly maxTokens: string;
  readonly setRunLimit: (value: string) => void;
  readonly setMaxTokens: (value: string) => void;
}) {
  const t = useT();
  return (
    <>
      <label>
        {t("center.scheduleFields.runLimit")}
        <input
          aria-label={t("center.scheduleFields.runLimitLabel")}
          inputMode="numeric"
          placeholder={String(SCHEDULE_DEFAULT_MAX_RUN_MINUTES)}
          maxLength={4}
          value={runLimit}
          onChange={(event) => setRunLimit(event.target.value)}
        />
      </label>
      <p className="muted">
        {t("center.scheduleFields.runLimitHint", {
          minutes: runLimit.trim() === "" ? SCHEDULE_DEFAULT_MAX_RUN_MINUTES : runLimit.trim(),
        })}
      </p>
      <label>
        {t("center.scheduleFields.tokenCeiling")}
        <input
          aria-label={t("center.scheduleFields.tokenCeilingLabel")}
          inputMode="numeric"
          placeholder={t("center.scheduleFields.none")}
          maxLength={13}
          value={maxTokens}
          onChange={(event) => setMaxTokens(event.target.value)}
        />
      </label>
      <p className="muted">{maxTokens.trim() === "" ? t("center.scheduleFields.noCeiling") : t("center.scheduleFields.ceilingHint")}</p>
      {belowOneCall(maxTokens) ? (
        <p className="schedule-ceiling-low" role="status">
          {t("center.scheduleFields.belowOneCall", { tokens: 25_000 })}
        </p>
      ) : null}
    </>
  );
}

/** What is checked before each run, and whether the schedule watches for it every few hours instead of at its times. */
export function SchedulePrecheckFields({
  precheckKind,
  precheckTarget,
  watch,
  spec,
  setPrecheckKind,
  setPrecheckTarget,
  setWatch,
  setSpec,
}: {
  readonly precheckKind: SchedulePrecheckKind | "none";
  readonly precheckTarget: string;
  readonly watch: boolean;
  readonly spec: ScheduleSpec;
  readonly setPrecheckKind: (kind: SchedulePrecheckKind | "none") => void;
  readonly setPrecheckTarget: (target: string) => void;
  readonly setWatch: (watch: boolean) => void;
  readonly setSpec: (spec: ScheduleSpec) => void;
}) {
  const t = useT();
  return (
    <>
      <label>
        {t("center.scheduleFields.onlyRunWhen")}
        <Select
          aria-label={t("center.scheduleFields.precheckLabel")}
          value={precheckKind}
          onChange={(event) => setPrecheckKind(event.target.value as SchedulePrecheckKind | "none")}
        >
          <option value="none">{t("center.scheduleFields.always")}</option>
          {SCHEDULE_PRECHECK_KINDS.map((value) => (
            <option key={value} value={value}>
              {t(PRECHECK_LABELS[value].label)}
            </option>
          ))}
        </Select>
      </label>
      {precheckKind === "none" ? null : (
        <label>
          {precheckKind === "file-changed" ? t("center.scheduleFields.file") : t("center.scheduleFields.address")}
          <input
            aria-label={t("center.scheduleFields.targetLabel")}
            placeholder={PRECHECK_LABELS[precheckKind].target}
            maxLength={2048}
            value={precheckTarget}
            onChange={(event) => setPrecheckTarget(event.target.value)}
          />
        </label>
      )}
      {precheckKind === "none" ? null : (
        <label>
          {t("center.scheduleFields.watch")}
          <Select
            aria-label={t("center.scheduleFields.watchLabel")}
            value={watch ? String(spec.everyHours ?? 1) : "times"}
            onChange={(event) => {
              const value = event.target.value;
              setWatch(value !== "times");
              if (value !== "times") setSpec(everyHoursSpec(spec, Number(value)));
            }}
          >
            <option value="times">{t("center.scheduleFields.watchNo")}</option>
            {WATCH_EVERY_HOURS.map((hours) => (
              <option key={hours} value={String(hours)}>
                {t("center.scheduleFields.watchEvery", { count: hours })}
              </option>
            ))}
          </Select>
        </label>
      )}
      <p className="muted">
        {precheckKind === "none"
          ? t("center.scheduleFields.everyRun")
          : precheckKind === "file-changed"
            ? t("center.scheduleFields.fileHint")
            : precheckKind === "page-changed"
              ? t("center.scheduleFields.pageHint")
              : t("center.scheduleFields.feedHint")}{" "}
        {t("center.scheduleFields.toldWhatChanged")}
        {watch && precheckKind === "file-changed" ? (
          <> {t("center.scheduleFields.fileWatch", { count: SCHEDULE_WATCH_MAX_PER_HOUR })}</>
        ) : (
          ""
        )}
      </p>
    </>
  );
}

/** Whether a typed ceiling ("2,000") is set and lower than one model call's worth (`SCHEDULE_ONE_CALL_TOKENS`). */
function belowOneCall(typed: string): boolean {
  const tokens = Number(typed.replace(/[,\s_]/g, ""));
  return typed.trim() !== "" && Number.isFinite(tokens) && tokens > 0 && tokens < SCHEDULE_ONE_CALL_TOKENS;
}
