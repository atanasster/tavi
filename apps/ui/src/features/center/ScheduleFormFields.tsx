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

/** The form's words for each pre-check, and what its field asks for. */
const PRECHECK_LABELS: Readonly<Record<SchedulePrecheckKind, { readonly label: string; readonly target: string }>> = {
  "page-changed": { label: "A page changed", target: "https://example.com/page" },
  "feed-has-new": { label: "A feed has new items", target: "https://example.com/feed.xml" },
  "file-changed": { label: "A file changed", target: "/path/under/an/fs-root" },
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
  // A search only sends its query out, which its own line says: it changes nothing.
  const changing = writing.filter((tool) => tool !== "web_search");
  return (
    <>
      <label>
        Allowed tool
        <input
          aria-label="Allowed tool"
          value={tool}
          maxLength={128}
          list={toolListId}
          autoComplete="off"
          placeholder="web_search or reports.*"
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
      <Button onClick={addTool}>Add tool</Button>
      <div>
        {tools.map((value) => (
          <span className="chip" key={value}>
            {value}
            <Button
              variant="bare"
              aria-label={`Remove tool ${value}`}
              onClick={() => setTools((before) => before.filter((item) => item !== value))}
            >
              <Icon name="close" size="sm" />
            </Button>
          </span>
        ))}
      </div>
      {unpicked.length > 0 ? (
        <p>
          Used in this chat — add:{" "}
          {unpicked.map((value) => (
            <Button
              key={value}
              variant="link"
              aria-label={`Add tool ${value}`}
              onClick={() => setTools((before) => (before.includes(value) ? before : [...before, value]))}
            >
              {value}
            </Button>
          ))}
        </p>
      ) : null}
      {changing.length > 0 ? <p>{changing.join(", ")} can change or send things without asking.</p> : null}
      {writing.includes("web_search") ? <p>web_search sends its queries to your search provider.</p> : null}
      <p>The allowlist governs calls needing approval. Read-only tools still run.</p>
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
  return (
    <>
      <label>
        Run limit (minutes)
        <input
          aria-label="Schedule run limit"
          inputMode="numeric"
          placeholder={String(SCHEDULE_DEFAULT_MAX_RUN_MINUTES)}
          maxLength={4}
          value={runLimit}
          onChange={(event) => setRunLimit(event.target.value)}
        />
      </label>
      <p className="muted">
        A run still working after {runLimit.trim() === "" ? SCHEDULE_DEFAULT_MAX_RUN_MINUTES : runLimit.trim()} minutes is stopped, recorded
        failed and told once.
      </p>
      <label>
        Token ceiling
        <input
          aria-label="Schedule token ceiling"
          inputMode="numeric"
          placeholder="None"
          maxLength={13}
          value={maxTokens}
          onChange={(event) => setMaxTokens(event.target.value)}
        />
      </label>
      <p className="muted">
        {maxTokens.trim() === ""
          ? "No ceiling: a run uses what it needs, within its time limit."
          : "A run, its workers included, that uses more tokens than this is stopped, recorded failed and told once. The next run goes ahead. The ceiling is checked between model calls, so a run can go past it by one call."}
      </p>
      {belowOneCall(maxTokens) ? (
        <p className="schedule-ceiling-low" role="status">
          Below one model call: a run can go past it by one call (a run's first call alone takes about 25,000 tokens).
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
  return (
    <>
      <label>
        Only run when
        <Select
          aria-label="Schedule pre-check"
          value={precheckKind}
          onChange={(event) => setPrecheckKind(event.target.value as SchedulePrecheckKind | "none")}
        >
          <option value="none">Always: no pre-check</option>
          {SCHEDULE_PRECHECK_KINDS.map((value) => (
            <option key={value} value={value}>
              {PRECHECK_LABELS[value].label}
            </option>
          ))}
        </Select>
      </label>
      {precheckKind === "none" ? null : (
        <label>
          {precheckKind === "file-changed" ? "File" : "Address"}
          <input
            aria-label="Schedule pre-check target"
            placeholder={PRECHECK_LABELS[precheckKind].target}
            maxLength={2048}
            value={precheckTarget}
            onChange={(event) => setPrecheckTarget(event.target.value)}
          />
        </label>
      )}
      {precheckKind === "none" ? null : (
        <label>
          Watch it
          <Select
            aria-label="Schedule watch mode"
            value={watch ? String(spec.everyHours ?? 1) : "times"}
            onChange={(event) => {
              const value = event.target.value;
              setWatch(value !== "times");
              if (value !== "times") setSpec(everyHoursSpec(spec, Number(value)));
            }}
          >
            <option value="times">No: it runs at its times, when something changed</option>
            {WATCH_EVERY_HOURS.map((hours) => (
              <option key={hours} value={String(hours)}>
                {`Yes: check every ${hours === 1 ? "hour" : `${String(hours)} hours`}, run only on a change`}
              </option>
            ))}
          </Select>
        </label>
      )}
      <p className="muted">
        {precheckKind === "none"
          ? "Every run goes ahead."
          : precheckKind === "file-changed"
            ? "Before each run the file is read (it must be under one of the owner's --fs-root folders); when it has not changed, nothing runs and no model is called."
            : `Before each run the ${precheckKind === "page-changed" ? "page" : "feed"} is fetched from its own site, with no sign-in; when nothing is new, nothing runs and no model is called.`}{" "}
        A run is told what changed, never the content, and reads it itself.
        {watch && precheckKind === "file-changed"
          ? ` While the owner runs, the file is also checked about 30 seconds after it changes, at most once a minute and ${String(SCHEDULE_WATCH_MAX_PER_HOUR)} times an hour.`
          : ""}
      </p>
    </>
  );
}

/** Whether a typed ceiling ("2,000") is set and lower than one model call's worth (`SCHEDULE_ONE_CALL_TOKENS`). */
function belowOneCall(typed: string): boolean {
  const tokens = Number(typed.replace(/[,\s_]/g, ""));
  return typed.trim() !== "" && Number.isFinite(tokens) && tokens > 0 && tokens < SCHEDULE_ONE_CALL_TOKENS;
}
