#!/usr/bin/env node
// dist-plugin/ for `tavi plugins install`: the bundle, its manifest and site profiles, at most 3 MB.
import { assemblePlugin } from "@tavi/domain-kit/assemble-plugin";

assemblePlugin(new URL("..", import.meta.url), { budgetMegabytes: 3, ignoreComments: true });
