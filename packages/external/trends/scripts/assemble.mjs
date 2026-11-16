#!/usr/bin/env node
// dist-plugin/ for `tavi plugins install`: the bundle, its manifest, the
// excluded sources, the per-country routing and the open-page lists' specs
// and site profiles, at most 1.5 MB.
import { assemblePlugin } from "@tavi/domain-kit/assemble-plugin";

assemblePlugin(new URL("..", import.meta.url), { budgetMegabytes: 1.5, files: ["excluded.json", "routing", "lists"] });
