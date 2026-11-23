import type { CatalogFor } from "../../i18n.js";

import type { connect as en } from "../en/connect.js";
import { nav } from "./nav.js";

/** The `core` words for apps, channels, models, plugins, the browser, the desktop, the heartbeat and onboarding plugins, in Bulgarian. */
export const connect = {
  "app.connect.need.notSetUp": `В {app} още няма вход. Отвори Tavi на компютъра си → ${nav["nav.settings.apps"]}.`,
  "app.connect.need.signInAgain": `{app} иска да влезеш отново. Отвори Tavi на компютъра си → ${nav["nav.settings.apps"]}.`,
  "app.plugin.describe": "Приложение {id} ({category}), по думите на автора му: {words}",
  "app.plugin.describeData": "Приложение {id} ({category}, данни: {dataClass}), по думите на автора му: {words}",
  "app.plugin.word.name": "име {value}",
  "app.plugin.word.publisher": "издател {value}",
  "app.plugin.word.summary": "описание {value}",
  "app.plugin.word.scope": "обхват {scope} ({access}) {says}",
  "app.plugin.word.tool": "инструмент {name} {title}",
  "app.plugin.word.toolSays": "инструмент {name} {title} {says}",
  "app.plugin.word.quoted": "„{text}“",
  "channel.trigger.mention": "при споменаване",
  "channel.trigger.reply": "при отговор на мое съобщение",
  "channel.trigger.thread": "при писане в нишка, започната от мен",
  "channel.trigger.command": "при използване на моя команда",
  "channel.trigger.picked": "при избор на съобщение за мен",
  "channel.trigger.or": "{list} или {last}",
  "model.lifecycle.retired": "е спрян",
  "model.lifecycle.retiredOn": "е спрян на {date}",
  "model.lifecycle.via": "{to} (през {via})",
  "model.lifecycle.redirected": "отговаря и се таксува като {to}",
  "model.lifecycle.redirectedSince": "отговаря и се таксува като {to} от {date}",
  "model.lifecycle.redirectsSoon": "ще отговаря и ще се таксува като {to}",
  "model.lifecycle.redirectsSoonOn": "ще отговаря и ще се таксува като {to} от {date}",
  "model.lifecycle.retires": "спира",
  "model.lifecycle.retiresOn": "спира на {date}",
  "model.lifecycle.mayHaveRetired": "може вече да е спрян (доставчикът не го е потвърдил)",
  "model.lifecycle.mayHaveRetiredOn": "може да е спрян на {date} (доставчикът не го е потвърдил)",
  "model.lifecycle.mayRetire": "може да спре (доставчикът не го е потвърдил)",
  "model.lifecycle.mayRetireOn": "може да спре на {date} (доставчикът не го е потвърдил)",
  "model.lifecycle.deprecated": "е остарял",
  "model.lifecycle.deprecatedOn": "е остарял от {date}",
  "model.lifecycle.priceChanges": "сменя цената си",
  "model.lifecycle.priceChangesOn": "сменя цената си на {date}",
  "model.preset.note.anthropic":
    "Нова връзка говори със собствения Messages API на Anthropic, който кешира заявките и пази мисленето между извикванията на инструменти. Връзка, добавена по-рано, минава през слоя за съвместимост с OpenAI (без кеширане на заявките), докато не я премахнеш и добавиш отново; за съвместим шлюз избери „Custom“.",
  "model.preset.note.ollama":
    "Работи на този компютър и не иска ключ. Един ход с инструментите на Tavi е около 22K токена: задай контекст на Ollama (в неговите настройки или с OLLAMA_CONTEXT_LENGTH) от 32K или повече.",
  "model.preset.note.lmstudio": "Въведи токен за сървъра, ако удостоверяването е включено; иначе не трябва ключ за облак.",
  "model.preset.note.custom": "Посочи адрес, съвместим с OpenAI. Локален сървър може да се настрои и без ключ за облак.",
  "model.video.disclosure":
    "С включен видео вход чат, който гледа видео, праща целия клип — всеки кадър и звука му — на {provider} за {model} при всяко гледане. Без него Tavi праща най-много три неподвижни кадъра. Важат правилата на {provider} за пазене на данни.",
  "pastChats.search.summary": {
    one: "Потърсих в по-ранните чатове · намерен {found}",
    other: "Потърсих в по-ранните чатове · намерени {found}",
  },
  "pastChats.search.untitled": "Чат без заглавие",
  "plugin.ui.channels.receives": "Получава {channels}.",
  "plugin.ui.channels.control":
    "Иска също да вижда и да пише в страниците, които поемаш, включително страници за вход; Tavi сам показва поемането, затова те не му се дават.",
  "plugin.ui.contribution.withRole": "{id} (роля {role})",
  "plugin.ui.contribution.noChannels": "без канали",
  "plugin.ui.contribution.receives": "получава {channels}",
  "plugin.ui.contribution.line": "{name} → {slots}; {channels}",
  "plugin.ui.contribution.lineDisclosure": "{name} → {slots}; {channels} — {disclosure}",
  "plugin.tool.line": "{id} ({effect}{notes})",
  "plugin.tool.effect.readOnly": "само за четене",
  "plugin.tool.effect.mutating": "променя данни",
  "plugin.tool.effect.external": "излиза навън",
  "plugin.tool.note": ", {note}",
  "plugin.tool.note.trustedOutput": "резултат с доверие",
  "plugin.tool.note.sink": "праща към {sink}",
  "plugin.tool.note.attended": "човек решава за всяко извикване",
  "plugin.tool.note.card": "картата му показва {fields}",
  "plugin.tool.note.browserWorker": "помощникът за браузъра може да го извиква",
  "plugin.router.describe":
    "Доставчик за маршрутизиране: получава {receives}, когато изходящият трафик към маршрутизатора е разрешен. {calls}, на цена като {connection} / {model}. Настройките и данните за достъп са общи за всяко работно пространство, което го избере.",
  "plugin.router.describeChooses":
    "Доставчик за маршрутизиране: получава {receives}, когато изходящият трафик към маршрутизатора е разрешен; може да избира между основния и бързия модел. {calls}, на цена като {connection} / {model}. Настройките и данните за достъп са общи за всяко работно пространство, което го избере.",
  "plugin.router.receives": "текста на задачата",
  "plugin.router.receivesAnd": "текста на задачата и {extra}",
  "plugin.router.feature.tools": "описанията на инструментите",
  "plugin.router.feature.memory": "откъси от паметта",
  "plugin.router.feature.skills": "данни за уменията",
  "plugin.router.calls.batched": "Извикванията са на пакети",
  "plugin.router.calls.perFeature": "По едно извикване за всяка функция",
  "plugin.channel.receives": "Получава съобщения отвън и може да праща от твое име в {label}",
  "plugin.channel.erases": "Премахването на някоя от връзките му изтрива каквото е донесла след 24\u00a0часа",
  "plugin.channel.mailbox":
    "Профилите му са пощенски кутии, в които агентът може да търси, да чете и от които да праща, всяка едва след като я включиш",
  "plugin.channel.sharedClient":
    "Иска да влиза с OAuth клиента, общ за приложенията ти от {provider}, чиято тайна тогава отива на адреса му за токени: едва след като свържеш тази версия с него (`{command}`) и само докато влиза през собствените адреси на {provider}",
  "plugin.channel.startsPublic": "Иска профилите му да започват като публични, което плъгин никога не получава: започват като лични",
  "plugin.onboarding.withDetails":
    "с подробностите им: имената на доставчика и модела, етикетите на профилите и редовете, които показва всяка стъпка",
  "plugin.onboarding.noDetails": "никога подробностите им",
  "plugin.onboarding.describe":
    "Поток за първи стъпки: получава кои стъпки са готови ({details}), какво може Tavi тук и идентификаторите на наличните доставчици, канали и приложения, нищо твое. Избира стъпките и думите им; Tavi проверява потока и сам прави всяка промяна.",
  "plugin.onboarding.describeSays":
    "Поток за първи стъпки: получава кои стъпки са готови ({details}), какво може Tavi тук и идентификаторите на наличните доставчици, канали и приложения, нищо твое. Избира стъпките и думите им; Tavi проверява потока и сам прави всяка промяна. Казва: {disclosure}",
  "heartbeat.tick.wake.event": "събуден от събитие",
  "heartbeat.tick.wake.manual": "ти поиска",
  "heartbeat.tick.wake.catchUp": "наваксване след отсъствие",
  "heartbeat.tick.wake.signal": "събуден от сигнал",
  "heartbeat.tick.memories": { one: "използва {n} спомен", other: "използва {n} спомена" },
  "heartbeat.hook.heldBack": "{by} задържа",
  "heartbeat.hook.heldBackBecause": "{by} задържа ({reason})",
  "heartbeat.hook.waited": "{by} го отложи за обобщението",
  "heartbeat.hook.waitedBecause": "{by} го отложи за обобщението ({reason})",
  "heartbeat.plugin.receive.instructions": "инструкциите ти за пулса",
  "heartbeat.plugin.receive.signals": "нови сигнали (заглавия и метаданни на това, което чака)",
  "heartbeat.plugin.receive.ledger": "какво ти е казал пулсът наскоро и отзивите ти",
  "heartbeat.plugin.receive.memory": "записи от паметта, свързани с всяка проверка",
  "heartbeat.plugin.receive.none": "никакви данни от пулса освен часа на всяка проверка",
  "heartbeat.plugin.describe":
    "Доставчик за пулса: решава какво ти казва пулсът. Може да получава {what}, всяко само когато го включиш. Самият той никога не праща нищо; Tavi доставя. Всяка проверка е ограничена до {seconds} сек.",
  "heartbeat.plugin.describeTurns":
    "Доставчик за пулса: решава какво ти казва пулсът. Може да получава {what}, всяко само когато го включиш; може да пуска кратки, отчитани ходове на модела само за четене. Самият той никога не праща нищо; Tavi доставя. Всяка проверка е ограничена до {seconds} сек.",
  "heartbeat.plugin.signals":
    "Източници на сигнали за пулса ({sources}): добавят неща, които пулсът да следи. Работят без модел, а това, което връщат, се смята за непроверен текст.",
  "heartbeat.plugin.signalsOffers":
    "Източници на сигнали за пулса ({sources}): добавят неща, които пулсът да следи. Работят без модел, а това, което връщат, се смята за непроверен текст. При първото пускане пулсът може да предложи: {offers}.",
  "heartbeat.plugin.offer": "„{line}“",
  "heartbeat.plugin.sourceOffer": "{offer}, от {plugin}",
  "heartbeat.plugin.sourceNamed": "{source} от {plugin}",
  "memory.provider.does.recall": "подрежда какво припомня паметта",
  "memory.provider.does.capture": "предлага записи от чатовете ти",
  "memory.provider.does.consolidate": "предлага подреждане на запазеното",
  "memory.provider.receives.records": "одобрените ти спомени (никога чувствителни, а личните само с трети превключвател)",
  "memory.provider.receives.conversation": "какво казваш: заявката на всяко припомняне и частите от чата, от които предлага записи",
  "memory.provider.receives.nothing": "нищо твое: вместо него отговаря собственото търсене на Tavi",
  "memory.provider.receives.both": "{first}; и {second}",
  "memory.provider.describe":
    "Доставчик на памет: {does}. Може да получава {receives}, всяко само когато го включиш за работното пространство. Връща само идентификатори, никога текст, и само предлага: ти решаваш какво се пази.",
  "memory.provider.describeOwnIndex":
    "Доставчик на памет: {does}. Може да получава {receives}, всяко само когато го включиш за работното пространство. Пази собствен индекс, от който Tavi му казва да махне запис, когато го забравиш. Връща само идентификатори, никога текст, и само предлага: ти решаваш какво се пази.",
  "memory.provider.pending": {
    one: "{providers} ще го премахне при следващото си пускане.",
    other: "{providers} ще го премахнат, всеки при следващото си пускане.",
  },
  "memory.provider.pendingTaught": {
    one: "{providers} ще премахне наученото от него при следващото си пускане.",
    other: "{providers} ще премахнат наученото от него, всеки при следващото си пускане.",
  },
} as const satisfies CatalogFor<typeof en>;
