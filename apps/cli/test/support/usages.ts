/**
 * Every command's usage text, as `[name, text]`: each parser's exported
 * `*_USAGE` string. The usage-text and CLI-reference tests read them here.
 */
import * as agents from "../../src/features/agents/parse.js";
import * as approvals from "../../src/features/approvals/parse.js";
import * as apps from "../../src/features/apps/parse.js";
import * as artifacts from "../../src/features/artifacts/parse.js";
import * as bindings from "../../src/features/bindings/parse.js";
import * as browser from "../../src/features/browser/parse.js";
import * as channels from "../../src/features/channels/parse.js";
import * as config from "../../src/features/config/parse.js";
import * as credentials from "../../src/features/credentials/parse.js";
import * as heartbeat from "../../src/features/heartbeat/parse.js";
import * as ideas from "../../src/features/ideas/parse.js";
import * as inbox from "../../src/features/inbox/parse.js";
import * as maintenance from "../../src/features/maintenance/parse.js";
import * as mcp from "../../src/features/mcp/parse.js";
import * as memory from "../../src/features/memory/parse.js";
import * as models from "../../src/features/models/parse.js";
import * as onboard from "../../src/features/onboard/parse.js";
import * as permissions from "../../src/features/permissions/parse.js";
import * as plugins from "../../src/features/plugins/parse.js";
import * as projects from "../../src/features/projects/parse.js";
import * as reminders from "../../src/features/reminders/parse.js";
import * as reports from "../../src/features/reports/parse.js";
import * as router from "../../src/features/router/parse.js";
import * as run from "../../src/features/run/parse.js";
import * as sandbox from "../../src/features/sandbox/parse.js";
import * as schedules from "../../src/features/schedules/parse.js";
import * as search from "../../src/features/search/parse.js";
import * as remote from "../../src/features/remote/parse.js";
import * as service from "../../src/features/service/parse.js";
import * as skills from "../../src/features/skills/parse.js";
import * as systemPrompt from "../../src/features/system-prompt/parse.js";
import * as tasks from "../../src/features/tasks/parse.js";
import * as todos from "../../src/features/todos/parse.js";
import * as ui from "../../src/features/ui/parse.js";
import * as serve from "../../src/server/parse.js";
import * as tui from "../../src/tui/parse.js";

export const usages: readonly [string, string][] = Object.entries({
  ...agents,
  ...approvals,
  ...apps,
  ...artifacts,
  ...bindings,
  ...browser,
  ...channels,
  ...config,
  ...credentials,
  ...heartbeat,
  ...ideas,
  ...inbox,
  ...maintenance,
  ...mcp,
  ...memory,
  ...models,
  ...onboard,
  ...permissions,
  ...plugins,
  ...projects,
  ...reminders,
  ...reports,
  ...router,
  ...run,
  ...sandbox,
  ...schedules,
  ...search,
  ...remote,
  ...service,
  ...skills,
  ...systemPrompt,
  ...tasks,
  ...todos,
  ...ui,
  ...serve,
  ...tui,
}).filter((entry): entry is [string, string] => entry[0].endsWith("USAGE") && typeof entry[1] === "string");
