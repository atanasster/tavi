import type { CountPoint } from "../contracts.js";
import { MASTODON_INSTANCES, MASTODON_TRENDS } from "../records.js";
import { bucketStart } from "../store/store.js";
import { bucketsOf, drift, failureOf, isoOf, numberOf, objectOf, stringOf } from "./common.js";
import type { SourceCall, TrendsAdapter } from "./types.js";

/**
 * Mastodon's public trends: a hashtag's last seven days of
 * uses and accounts, and an instance's trending tags. Per instance, never a
 * global count: counts read one instance, since a post federated to two would
 * be counted on both. 300 requests in 5 minutes per instance.
 */
const DAY_MS = 86_400_000;

/** The instances the operator picked, among those the manifest reaches; mastodon.social by default. */
export function instancesOf(call: SourceCall): string[] {
  const named =
    typeof call.settings["mastodonInstances"] === "string"
      ? call.settings["mastodonInstances"].split(",").map((name) => name.trim().toLowerCase())
      : [];
  const known = named.filter((name): name is (typeof MASTODON_INSTANCES)[number] =>
    (MASTODON_INSTANCES as readonly string[]).includes(name),
  );
  return known.length > 0 ? known : ["mastodon.social"];
}

/** A term as a hashtag: its letters and digits, lower-cased; one too short to mean anything is none. */
export const hashtagOf = (term: string): string | undefined => {
  const tag = term
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .toLowerCase();
  return tag.length >= 3 && tag.length <= 100 ? tag : undefined;
};

export const mastodonTrends: TrendsAdapter = {
  record: MASTODON_TRENDS,
  counts: {
    // Daily only, and the first term that makes a hashtag.
    request: ({ topic, window }, call) => {
      const tag = topic.terms.map(hashtagOf).find((each) => each !== undefined);
      return window.bucket !== "day" || tag === undefined
        ? []
        : [{ url: `https://${instancesOf(call)[0] ?? "mastodon.social"}/api/v1/tags/${encodeURIComponent(tag)}`, expect: "json", tag }];
    },
    parse: (response, _request, { window }, call) => {
      // A tag nobody has used is not found: its week (today and the six days before) is quiet.
      const seen = bucketStart(new Date(Date.parse(call.now) - 6 * DAY_MS).toISOString(), "day");
      if (response.status === 404)
        return {
          kind: "ok",
          value: ["uses", "accounts"].map((metric) => ({
            metric,
            points: bucketsOf(window).map(
              (start): CountPoint => (start >= seen ? { start, value: 0, quality: "ok" } : { start, value: 0, quality: "missing" }),
            ),
          })),
        };
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const history = objectOf(response.body)?.["history"];
      if (!Array.isArray(history)) return drift("no history");
      const uses = new Map<string, number>();
      const accounts = new Map<string, number>();
      for (const entry of history) {
        const day = isoOf(numberOf(objectOf(entry)?.["day"]));
        if (day === undefined) continue;
        uses.set(day, numberOf(objectOf(entry)?.["uses"]) ?? 0);
        accounts.set(day, numberOf(objectOf(entry)?.["accounts"]) ?? 0);
      }
      // Its week only: before it, the instance said nothing.
      const series = (values: Map<string, number>): CountPoint[] =>
        bucketsOf(window).map((start) =>
          values.has(start) ? { start, value: values.get(start) ?? 0, quality: "ok" } : { start, value: 0, quality: "missing" },
        );
      return {
        kind: "ok",
        value: [
          { metric: "uses", points: series(uses) },
          { metric: "accounts", points: series(accounts) },
        ],
      };
    },
  },
  trending: {
    request: (_input, call) => [
      { url: `https://${instancesOf(call)[0] ?? "mastodon.social"}/api/v1/trends/tags?limit=20`, expect: "json" },
    ],
    parse: (response, _request, _input, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      if (!Array.isArray(response.body)) return drift("not a list");
      return {
        kind: "ok",
        value: response.body.flatMap((entry, index) => {
          const tag = objectOf(entry);
          const name = stringOf(tag?.["name"]);
          if (name === undefined) return [];
          const history = tag?.["history"];
          const today = Array.isArray(history) ? numberOf(objectOf(history[0])?.["uses"]) : undefined;
          const url = stringOf(tag?.["url"]);
          return [
            {
              title: `#${name}`,
              rank: index + 1,
              ...(url?.startsWith("https://") === true ? { url } : {}),
              ...(today === undefined ? {} : { volume: today, volumeLabel: `${String(today)} uses today` }),
            },
          ];
        }),
      };
    },
  },
};
