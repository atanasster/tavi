/**
 * The `core` words for notices posted to a chat or Home, and for a schedule's fire outcomes, in English. Stored by
 * key beside their English (`TextRef`) and said in the reader's language when read; what a person wrote (a routine's
 * name, a chat's title) and what a run said are only ever parameters.
 */
export const notices = {
  /** A notice's summary with the generated summary of the task it is about joined after it. */
  "notice.summary.joined": "{summary} — {detail}",
  /** A task's ending, as a notice's status line. */
  "notice.status.completed": "Completed",
  "notice.status.failed": "Failed",
  "notice.status.failedWithCode": "Failed ({code})",
  "notice.status.cancelled": "Cancelled",
  "notice.status.stopped": "Stopped",
  "notice.status.waiting": "Waiting on a person",
  "notice.status.ended": "Ended ({status})",
  /** A schedule's result in Home: its status line, then the run's own words. */
  "notice.schedule.result.title": "Scheduled run “{name}”",
  "notice.schedule.result.summary": "{status}\n{text}",
  /** A conversation Home's notice: its channel and kind, never a word of the chat. */
  "notice.conversation.title.group": "{channel} group {id}",
  "notice.conversation.title.direct": "{channel} DM",
  "notice.conversation.title.thread": "{channel} thread",
  "notice.conversation.title.other": "{channel} conversation",
  "notice.conversation.channel.fallback": "Messaging",
  "notice.conversation.summary": {
    one: "{n} new message, the last at {time} UTC",
    other: "{n} new messages, the last at {time} UTC",
  },
  "notice.conversation.summaryCapped": "{n}+ new messages, the last at {time} UTC",
  "notice.sideChat.title.named": "Side chat “{name}” finished",
  "notice.sideChat.title.id": "Side chat {id} finished",
  "notice.reminderTask.title": "A reminder's task finished",
  "notice.run.title": "Run {id} finished",
  "notice.reminder.title": "Reminder",
  "notice.reminder.summary.taskStarted": "{text} (its task started)",
  "notice.earlierChats.title": "Earlier chats",
  "notice.epoch.title": "Epoch {epoch} began",
  "notice.epoch.summary.lossy": {
    one: "{n} earlier message(s) were summarized; no archive could keep them.",
    other: "{n} earlier message(s) were summarized; no archive could keep them.",
  },
  "notice.epoch.summary.archived": {
    one: "{n} earlier message(s) were summarized and archived as {artifact}.",
    other: "{n} earlier message(s) were summarized and archived as {artifact}.",
  },
  "notice.folder.title": "This chat's folder is nearly full",
  /** Where a routine is resumed, as a menu path. */
  "notice.nav.centerSchedule": "Center → Schedule",
  "notice.routine.resumeHint": "Resume it in {path}, or ask Tavi in chat to resume it.",
  "notice.routine.expired.title": "Routine “{name}” run expired",
  "notice.routine.paused.title": "Routine “{name}” paused",
  "notice.routine.expired.text":
    "Routine “{name}”: its run due {due} expired before it could finish (the owner was asleep, stopped or busy), so it made no report. The next scheduled run tries again.",
  "notice.routine.credentialGrace.text":
    "Routine “{name}” paused: its model or search credential has been rejected for over {hours} hours. Fix the key in Settings, then resume it. {resume}",
  "notice.routine.failures.text": "Routine “{name}” paused after {n} failed runs in a row; its run history says why. {resume}",
  "notice.routine.delivery.title": "Routine “{name}” delivery paused",
  "notice.routine.delivery.text":
    "Routine “{name}”: delivery to “{label}” paused because {why}. Research keeps running and reports stay in the app. {fix}.",
  "notice.routine.delivery.why.credentials": "its channel's credentials have been missing for over {hours} hours",
  "notice.routine.delivery.why.failures": "{n} sends failed in a row",
  "notice.routine.delivery.fix.credentials": "Reconnect the channel and delivery resumes on its own",
  "notice.routine.delivery.fix.failures": "Fix the channel, then resume delivery on the run's deliveries in {path}, or resume the routine",
  "notice.scheduledBudget.title": "Scheduled work",
  "notice.scheduledBudget.summary":
    "Your schedules and routines have used {usage} for {month}. Nothing is stopped. Change the budget with `tavi config set scheduled.monthlyTokenBudget <tokens>`, or give a schedule its own ceiling with `tavi schedules update <name> --max-tokens <n>`.",
  /** An MCP server's notice: what happened and what to do, never the server's own words. */
  "notice.mcp.drift.title": "{plugin}: its tools changed",
  "notice.mcp.drift.withheld": "{n} changed and withheld ({names})",
  "notice.mcp.drift.added": "{n} new, waiting for review",
  "notice.mcp.drift.removed": "{n} removed",
  "notice.mcp.drift.instructions": "its instructions changed (nothing withheld; read them in the review)",
  "notice.mcp.drift.list": "{first}; {rest}",
  "notice.mcp.drift.summary": "{parts}. Review with `tavi mcp review {plugin}`.",
  "notice.mcp.drift.summaryRules": "{parts}. Allow rules still cover {rules}. Review with `tavi mcp review {plugin}`.",
  "notice.mcp.failed.title": "{plugin} stopped after repeated failures",
  "notice.mcp.failed.summary": "Its tools are withdrawn. See `tavi mcp logs {plugin}`, then probe it again once it is fixed.",
  "notice.mcp.budget.title": "{plugin}'s tools do not fit",
  "notice.mcp.budget.summary":
    "A workspace lists more MCP tools than fit beside the others. Set its exposure to search, or disable another server.",
  "notice.mcp.login.title": "{plugin} needs you to sign in again",
  "notice.mcp.login.summary": "Its tools fail until you do: `tavi mcp login {plugin}`.",
  "notice.mcp.login.summaryCause": "{cause}. Its tools fail until you do: `tavi mcp login {plugin}`.",
  "notice.mcp.scope.title": "{plugin} asks for more access",
  "notice.mcp.scope.summary":
    "A call needed a permission its sign-in was not granted. Nothing was asked for: sign in again with `tavi mcp login {plugin}` to grant it.",
  /** `/new` in a chat app, said in the chat it ended. */
  "notice.conversationReset.title": "Conversation started over",
  "notice.conversationReset.summary":
    "/new on {channel} started a new conversation. Writing here goes on with this chat in Tavi; {channel} goes on in the new conversation.",
  "notice.conversationReset.summaryCancelled":
    "/new on {channel} started a new conversation, and what this one was still doing was cancelled. Writing here goes on with this chat in Tavi; {channel} goes on in the new conversation.",
  "notice.conversationReset.chatApp": "the chat app",
  /** A schedule's alert posted to Home. */
  "notice.schedule.alert.title": "Schedule “{name}”",
  "notice.schedule.paused.text":
    'Schedule "{name}" was paused: its last {n} runs failed, so it will not run again until it is resumed. Resume it from its page, by asking in chat, or with `tavi schedules enable {name}`.',
  /** The heartbeat's notices. */
  "notice.heartbeat.digest.title": { one: "{n} thing from your heartbeat", other: "{n} things from your heartbeat" },
  "notice.heartbeat.summary.heldBack": "Held back (hourly limit) · {rest}",
  "notice.heartbeat.summary.instruction": "{sources} · instruction line {line}",
  "notice.heartbeat.resolved.title": "Resolved · {time} — {title}",
  "notice.heartbeat.paused.title": "Your heartbeat paused",
  /** A fire's outcome in the ledger: a run asked for now starts with what asked for it. */
  "schedule.outcome.labelled": "{label}{said}",
  "schedule.outcome.label.manual": "manual run: ",
  "schedule.outcome.label.watch": "file-watch run: ",
  "schedule.outcome.label.webhook": "webhook run ({facts}): ",
  "schedule.outcome.label.email": "email run ({facts}): ",
  /** What a webhook's call or an email carried, by size and hash only. */
  "schedule.outcome.facts.noPayload": "no payload",
  "schedule.outcome.facts.payload": "payload {bytes} bytes, sha256 {hash}",
  "schedule.outcome.facts.email": "from {sender}, {bytes} bytes, sha256 {hash}",
  "schedule.outcome.notPosted.noHome": "completed, but its result was not posted: there is no Home to post it in (Home is off)",
  "schedule.outcome.notPosted.failed": "completed, but its result was not posted: posting it into Home failed",
  "schedule.outcome.cutShort": {
    one: "completed with nothing to report, but {n} of its calls was refused, so it may have missed something",
    other: "completed with nothing to report, but {n} of its calls were refused, so it may have missed something",
  },
  "schedule.outcome.webhookRefused": {
    one: "webhook refused {n} call this hour ({causes})",
    other: "webhook refused {n} calls this hour ({causes})",
  },
  "schedule.outcome.emailRefused": {
    one: "email trigger refused {n} email this hour ({causes})",
    other: "email trigger refused {n} emails this hour ({causes})",
  },
} as const;
