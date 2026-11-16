#!/usr/bin/env node
// dist-plugin/ for `tavi plugins install`: the bundle and its manifest, at most 1 MB.
import { assemblePlugin } from "@tavi/domain-kit/assemble-plugin";

assemblePlugin(new URL("..", import.meta.url), { budgetMegabytes: 1, ignoreComments: true });
