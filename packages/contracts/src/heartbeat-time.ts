import type { HeartbeatConfig } from "./heartbeat.js";
import { instantForLocalTime, localDateTime, shiftLocalDate, type LocalDate } from "./schedule-time.js";

/**
 * When a heartbeat ticks. Ticks are
 * anchored to the start of each active window and spaced by the interval,
 * plus a jitter fixed per principal so heartbeats spread across owners
 * without unevening one heartbeat's own spacing. Windows are computed in the
 * heartbeat's timezone through `instantForLocalTime`, so DST and windows that
 * cross midnight (22:00–02:00) are a matter of which local day a window starts on.
 */

type WindowConfig = Pick<HeartbeatConfig, "activeHours" | "daysOfWeek">;

/** One occurrence of the active hours: `start` inclusive, `end` exclusive. */
export interface HeartbeatWindow {
  readonly start: Date;
  readonly end: Date;
}

const MAX_JITTER_MS = 3 * 60_000;

/** The principal's fixed jitter for an interval: at most 10% of it and at most 3 min (FNV-1a over the seed). */
export function heartbeatJitterMs(everyMs: number, seed: string): number {
  const bound = Math.min(Math.floor(everyMs / 10), MAX_JITTER_MS);
  if (bound <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % (bound + 1);
}

/** The active window that contains `instant`, or undefined outside active hours. */
export function heartbeatWindowAt(config: WindowConfig, timezone: string, instant: Date): HeartbeatWindow | undefined {
  const today = localDateTime(instant, timezone);
  // A window that crosses midnight began on the previous local day.
  for (const offset of [-1, 0]) {
    const window = windowStartingOn(config, timezone, shiftLocalDate(today, offset));
    if (window !== undefined && window.start.getTime() <= instant.getTime() && instant.getTime() < window.end.getTime()) return window;
  }
  return undefined;
}

/** The last window that starts strictly before `before`; undefined when none in the eight days before. */
export function previousHeartbeatWindow(config: WindowConfig, timezone: string, before: Date): HeartbeatWindow | undefined {
  const today = localDateTime(before, timezone);
  for (let offset = 0; offset >= -8; offset -= 1) {
    const window = windowStartingOn(config, timezone, shiftLocalDate(today, offset));
    if (window !== undefined && window.start.getTime() < before.getTime()) return window;
  }
  return undefined;
}

/** The first window that starts strictly after `after`; eight days covers any day mask. */
export function nextHeartbeatWindow(config: WindowConfig, timezone: string, after: Date): HeartbeatWindow {
  const today = localDateTime(after, timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const window = windowStartingOn(config, timezone, shiftLocalDate(today, offset));
    if (window !== undefined && window.start.getTime() > after.getTime()) return window;
  }
  // Unreachable for a valid config (at least one day, start ≠ end); a typed failure rather than a loop.
  throw new RangeError(`The active hours ${config.activeHours.start}–${config.activeHours.end} have no next window in ${timezone}`);
}

/**
 * The next tick strictly after `now`: inside the current window, the next
 * `start + jitter + k × every` before its end; otherwise the next window's
 * start plus the jitter (clamped inside a window shorter than the jitter).
 */
export function nextHeartbeatAt(config: WindowConfig & Pick<HeartbeatConfig, "everyMs">, timezone: string, now: Date, seed: string): Date {
  const jitter = heartbeatJitterMs(config.everyMs, seed);
  const current = heartbeatWindowAt(config, timezone, now);
  if (current !== undefined) {
    const first = current.start.getTime() + jitter;
    const steps = now.getTime() < first ? 0 : Math.floor((now.getTime() - first) / config.everyMs) + 1;
    const candidate = first + steps * config.everyMs;
    if (candidate < current.end.getTime()) return new Date(candidate);
  }
  const next = nextHeartbeatWindow(config, timezone, now);
  return new Date(Math.min(next.start.getTime() + jitter, next.end.getTime() - 1));
}

function windowStartingOn(config: WindowConfig, timezone: string, date: LocalDate): HeartbeatWindow | undefined {
  if (config.daysOfWeek !== undefined && !config.daysOfWeek.includes(date.weekday)) return undefined;
  const [startHour, startMinute] = hoursAndMinutes(config.activeHours.start);
  const [endHour, endMinute] = hoursAndMinutes(config.activeHours.end);
  const crossesMidnight = endHour * 60 + endMinute <= startHour * 60 + startMinute;
  const start = instantForLocalTime({ ...date, hour: startHour, minute: startMinute }, timezone);
  const end = instantForLocalTime({ ...(crossesMidnight ? shiftLocalDate(date, 1) : date), hour: endHour, minute: endMinute }, timezone);
  // A window wholly inside a skipped hour (02:30–03:00 on a spring-forward night) has no instants: no window that day.
  return end.getTime() <= start.getTime() ? undefined : { start, end };
}

function hoursAndMinutes(time: string): readonly [number, number] {
  const [hours, minutes] = time.split(":");
  return [Number.parseInt(hours ?? "0", 10), Number.parseInt(minutes ?? "0", 10)];
}

/** The first instant of `now`'s day in `timezone`: where a heartbeat's daily budget starts. */
export function startOfLocalDay(now: Date, timezone: string): Date {
  const today = localDateTime(now, timezone);
  return instantForLocalTime({ ...today, hour: 0, minute: 0 }, timezone);
}

/** The first instant of the next day in `timezone`: the budget's reset. */
export function startOfNextLocalDay(now: Date, timezone: string): Date {
  const today = localDateTime(now, timezone);
  return instantForLocalTime({ ...shiftLocalDate(today, 1), hour: 0, minute: 0 }, timezone);
}
