import type { CatalogFor } from "../../i18n.js";

import type { notices as en } from "../en/notices.js";

/** The `core` words for notices posted to a chat or Home, and for a schedule's fire outcomes, in Bulgarian. */
export const notices = {
  "notice.summary.joined": "{summary} — {detail}",
  "notice.status.completed": "Завършено",
  "notice.status.failed": "Неуспешно",
  "notice.status.failedWithCode": "Неуспешно ({code})",
  "notice.status.cancelled": "Отменено",
  "notice.status.stopped": "Спряно",
  "notice.status.waiting": "Чака отговор от човек",
  "notice.status.ended": "Приключено ({status})",
  "notice.schedule.result.title": "Пускане по график „{name}“",
  "notice.schedule.result.summary": "{status}\n{text}",
  "notice.conversation.title.group": "{channel}, група {id}",
  "notice.conversation.title.direct": "{channel}, лични съобщения",
  "notice.conversation.title.thread": "{channel}, нишка",
  "notice.conversation.title.other": "{channel}, разговор",
  "notice.conversation.channel.fallback": "Съобщения",
  "notice.conversation.summary": {
    one: "{n} ново съобщение, последното в {time} UTC",
    other: "{n} нови съобщения, последното в {time} UTC",
  },
  "notice.conversation.summaryCapped": "{n}+ нови съобщения, последното в {time} UTC",
  "notice.sideChat.title.named": "Страничният чат „{name}“ приключи",
  "notice.sideChat.title.id": "Страничният чат {id} приключи",
  "notice.reminderTask.title": "Задачата на едно напомняне приключи",
  "notice.run.title": "Изпълнението {id} приключи",
  "notice.reminder.title": "Напомняне",
  "notice.reminder.summary.taskStarted": "{text} (задачата му започна)",
  "notice.earlierChats.title": "По-ранни чатове",
  "notice.epoch.title": "Започна епоха {epoch}",
  "notice.epoch.summary.lossy": {
    one: "{n} по-ранно съобщение е обобщено; не можа да се запази в архив.",
    other: "{n} по-ранни съобщения са обобщени; не можаха да се запазят в архив.",
  },
  "notice.epoch.summary.archived": {
    one: "{n} по-ранно съобщение е обобщено и архивирано като {artifact}.",
    other: "{n} по-ранни съобщения са обобщени и архивирани като {artifact}.",
  },
  "notice.folder.title": "Папката на този чат е почти пълна",
  "notice.routine.resumeHint": "Пусни я отново от {path} или помоли Tavi в чата да я пусне отново.",
  "notice.routine.expired.title": "Пускането на рутината „{name}“ изтече",
  "notice.routine.paused.title": "Рутината „{name}“ е на пауза",
  "notice.routine.expired.text":
    "Рутина „{name}“: пускането ѝ за {due} изтече, преди да завърши (сървърът на Tavi беше заспал, спрян или зает), затова няма доклад. Следващото пускане по график ще опита пак.",
  "notice.routine.credentialGrace.text":
    "Рутината „{name}“ е на пауза: ключът ѝ за модела или търсенето се отхвърля от над {hours} ч. Поправи ключа в настройките и я пусни отново. {resume}",
  "notice.routine.failures.text": {
    one: "Рутината „{name}“ е на пауза след {n} неуспешно пускане; историята на пусканията ѝ казва защо. {resume}",
    other: "Рутината „{name}“ е на пауза след {n} неуспешни пускания поред; историята на пусканията ѝ казва защо. {resume}",
  },
  "notice.routine.delivery.title": "Доставката на рутината „{name}“ е на пауза",
  "notice.routine.delivery.text":
    "Рутина „{name}“: доставката до „{label}“ е на пауза, защото {why}. Проучването продължава, а докладите остават в приложението. {fix}.",
  "notice.routine.delivery.why.credentials": "данните за достъп на канала ѝ липсват от над {hours} ч",
  "notice.routine.delivery.why.failures": { one: "{n} изпращане не успя", other: "{n} изпращания поред не успяха" },
  "notice.routine.delivery.fix.credentials": "Свържи канала отново и доставката ще продължи сама",
  "notice.routine.delivery.fix.failures":
    "Поправи канала, после пусни доставката отново от доставките на пускането в {path} или пусни рутината отново",
  "notice.scheduledBudget.title": "Работа по график",
  "notice.scheduledBudget.summary":
    "Графиците и рутините ти са използвали {usage} за {month}. Нищо не е спряно. Промени бюджета с `tavi config set scheduled.monthlyTokenBudget <tokens>` или дай на един график собствен таван с `tavi schedules update <name> --max-tokens <n>`.",
  "notice.mcp.drift.title": "{plugin}: инструментите му се промениха",
  "notice.mcp.drift.withheld": { one: "{n} променен и задържан ({names})", other: "{n} променени и задържани ({names})" },
  "notice.mcp.drift.added": { one: "{n} нов, чака преглед", other: "{n} нови, чакат преглед" },
  "notice.mcp.drift.removed": { one: "{n} премахнат", other: "{n} премахнати" },
  "notice.mcp.drift.instructions": "инструкциите му се промениха (нищо не е задържано; прочети ги при прегледа)",
  "notice.mcp.drift.list": "{first}; {rest}",
  "notice.mcp.drift.summary": "{parts}. Прегледай ги с `tavi mcp review {plugin}`.",
  "notice.mcp.drift.summaryRules": "{parts}. Правилата за разрешение още покриват {rules}. Прегледай ги с `tavi mcp review {plugin}`.",
  "notice.mcp.failed.title": "{plugin} спря след повтарящи се грешки",
  "notice.mcp.failed.summary": "Инструментите му са оттеглени. Виж `tavi mcp logs {plugin}` и го провери отново, щом бъде поправен.",
  "notice.mcp.budget.title": "Инструментите на {plugin} не се побират",
  "notice.mcp.budget.summary":
    "В едно работно пространство има повече MCP инструменти, отколкото могат да се поберат заедно с останалите. Направи сървъра достъпен само през търсене или изключи друг сървър.",
  "notice.mcp.login.title": "{plugin} иска да влезеш отново",
  "notice.mcp.login.summary": "Инструментите му не работят, докато не влезеш: `tavi mcp login {plugin}`.",
  "notice.mcp.login.summaryCause": "{cause}. Инструментите му не работят, докато не влезеш: `tavi mcp login {plugin}`.",
  "notice.mcp.scope.title": "{plugin} иска повече достъп",
  "notice.mcp.scope.summary":
    "Едно извикване имаше нужда от разрешение, което не е дадено при влизането. Нищо не е поискано: влез отново с `tavi mcp login {plugin}`, за да го дадеш.",
  "notice.conversationReset.title": "Разговорът започна отначало",
  "notice.conversationReset.summary":
    "/new в {channel} започна нов разговор. Ако пишеш тук, продължаваш този чат в Tavi; {channel} продължава в новия разговор.",
  "notice.conversationReset.summaryCancelled":
    "/new в {channel} започна нов разговор, а това, което този още вършеше, е отменено. Ако пишеш тук, продължаваш този чат в Tavi; {channel} продължава в новия разговор.",
  "notice.conversationReset.chatApp": "приложението за чат",
  "notice.schedule.alert.title": "График „{name}“",
  "notice.schedule.paused.text":
    "Графикът „{name}“ е на пауза: последните му {n} пускания не успяха, затова няма да тръгне, докато не го възобновиш. Възобнови го с „Продължи“ на страницата му, с молба в чата или с `tavi schedules enable {name}`.",
  "notice.heartbeat.digest.title": { one: "{n} нещо от пулса ти", other: "{n} неща от пулса ти" },
  "notice.heartbeat.summary.heldBack": "Задържано (лимит на час) · {rest}",
  "notice.heartbeat.summary.instruction": "{sources} · ред {line} от инструкциите",
  "notice.heartbeat.resolved.title": "Решено · {time} — {title}",
  "notice.heartbeat.paused.title": "Пулсът ти е на пауза",
  "schedule.outcome.labelled": "{label}{said}",
  "schedule.outcome.label.manual": "ръчно пускане: ",
  "schedule.outcome.label.watch": "пускане при промяна на файла: ",
  "schedule.outcome.label.webhook": "пускане от уебхук ({facts}): ",
  "schedule.outcome.label.email": "пускане от имейл ({facts}): ",
  "schedule.outcome.facts.noPayload": "без съдържание",
  "schedule.outcome.facts.payload": "съдържание {bytes} Б, sha256 {hash}",
  "schedule.outcome.facts.email": "от {sender}, {bytes} Б, sha256 {hash}",
  "schedule.outcome.notPosted.noHome":
    "завърши, но резултатът не е публикуван: няма „Начало“, в което да се публикува („Начало“ е изключено)",
  "schedule.outcome.notPosted.failed": "завърши, но резултатът не е публикуван: публикуването в „Начало“ не успя",
  "schedule.outcome.cutShort": {
    one: "завърши без нищо за докладване, но {n} от извикванията му беше отказано, така че може да е пропуснало нещо",
    other: "завърши без нищо за докладване, но {n} от извикванията му бяха отказани, така че може да е пропуснало нещо",
  },
  "schedule.outcome.webhookRefused": {
    one: "уебхукът отказа {n} извикване този час ({causes})",
    other: "уебхукът отказа {n} извиквания този час ({causes})",
  },
  "schedule.outcome.emailRefused": {
    one: "задействането с имейл отказа {n} имейл този час ({causes})",
    other: "задействането с имейл отказа {n} имейла този час ({causes})",
  },
} as const satisfies CatalogFor<typeof en>;
