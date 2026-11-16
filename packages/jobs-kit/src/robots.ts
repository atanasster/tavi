import { robotsAllows as robotsAllowsFor } from "@tavi/contracts";

/** Tavi's jobs plugin's robots.txt agent: its User-Agent's product token, `Tavi-jobs`; `tavi`'s group applies when it has none. */
export const ROBOTS_AGENT = "tavi-jobs";

/** Whether robots.txt `text` lets the jobs plugin read `path` (with its query). */
export const robotsAllows = (text: string, path: string, agent: string = ROBOTS_AGENT): boolean => robotsAllowsFor(text, path, agent);
