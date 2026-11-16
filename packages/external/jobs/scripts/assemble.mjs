#!/usr/bin/env node
// dist-plugin/ for `tavi plugins install`: the bundle, its manifest and site
// profiles, and the skills dictionary the bundle reads at start, kept out of
// it under its own budget: at most 1.5 MB, the dictionary at most 2 MB.
import { assemblePlugin } from "@tavi/domain-kit/assemble-plugin";

import { KIT_DICTIONARY } from "./dictionary.mjs";

assemblePlugin(new URL("..", import.meta.url), {
  budgetMegabytes: 1.5,
  dictionary: { from: KIT_DICTIONARY, to: "assets/skills.json", label: "skills dictionary", budgetMegabytes: 2 },
});
