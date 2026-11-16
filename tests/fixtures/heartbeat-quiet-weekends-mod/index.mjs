/**
 * A mod over the built-in heartbeat (docs/HEARTBEAT-PLUGINS.md), for
 * tests: on a quiet day in the person's timezone, an urgent item waits for the
 * morning summary instead. An item whose key starts with its `hold` setting
 * is held back altogether, and an item another mod already held back stays
 * held back.
 */

export function quietDayHook(days, hold) {
  const quiet = new Set(days.split(",").map((day) => day.trim()).filter((day) => day !== ""));
  return async (e, next) => {
    const decided = await next(e);
    if (hold !== undefined && hold !== "" && e.key.startsWith(hold)) return { drop: `Held back: ${e.title}` };
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: e.timezone }).format(new Date(e.now));
    return !("drop" in decided) && e.urgency === "now" && quiet.has(day) ? { urgency: "later" } : decided;
  };
}

export function register({ hooks, config }) {
  hooks.on("heartbeat.item", quietDayHook(typeof config.days === "string" ? config.days : "Sat,Sun", typeof config.hold === "string" ? config.hold : undefined));
}
