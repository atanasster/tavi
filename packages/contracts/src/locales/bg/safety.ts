import type { CatalogFor } from "../../i18n.js";

import type { safety as en } from "../en/safety.js";

/** The `core` words for provenance, why Tavi asked, shell and skill limits, in Bulgarian. */
export const safety = {
  "provenance.source.web": "уеб страница",
  "provenance.source.search": "резултати от търсене",
  "provenance.source.email": "имейл",
  "provenance.source.chatOther": "съобщение от друг човек",
  "provenance.source.chatForward": "препратено съобщение",
  "provenance.source.attachment": "прикачен файл",
  "provenance.source.download": "изтеглен файл",
  "provenance.source.mcp": "резултат от MCP инструмент",
  "provenance.source.plugin": "резултат от плъгин",
  "provenance.source.agent": "отговор на помощник",
  "provenance.source.pastChat": "предишен чат",
  "provenance.source.routineOutput": "резултат от рутина",
  "provenance.source.heartbeat": "сигнал от пулса",
  "provenance.source.sandbox": "резултат от изолираната среда",
  "provenance.source.webhook": "извикване на уебхук",
  "provenance.source.unknownSource": "непроверено съдържание",
  "provenance.source.desktop": "екран на настолно приложение",
  "provenance.source.desktopApp": "екран на настолно приложение ({app})",
  "provenance.ref.email": "поща, която препрати или цитира (през {host})",
  "provenance.ref.chatOther": "съобщение от {host}",
  "provenance.ref.search": "резултати от търсене в {host}",
  "provenance.ref.mcp": "MCP сървър {host}",
  "provenance.ref.other": "{source} ({host})",
  "provenance.claim.page": "страницата се представя като „{title}“",
  "memory.provenance.proposed": "Предложено, след като този чат прочете {what}{where}{title}",
  "memory.provenance.tidyUp": "Обединява спомени, предложени, след като един чат прочете {what}{where}{title}",
  "routine.provenance.changed": "Променено от Tavi, след като чатът му прочете {what}{where}{title}",
  "provenance.claim.email": "имейлът се представя като „{title}“",
  "provenance.claim.other": "представя се като „{title}“",
  "provenance.sources.more": "{sources} и още {more}",
  "provenance.sources.last": "{sources} и {last}",
  "provenance.line": "⚠ след четене на {sources}",
  "provenance.line.onceOnly": "⚠ след четене на {sources} — само веднъж",
  "provenance.why.novelUrl":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване отваря адрес, който не идва от теб и за който Tavi не може да гарантира: написал го е моделът или го е показала страница, след като моделът е писал в нея. Страница може да подмами модела да сложи данните ти в адрес.",
  "provenance.why.taintedPayload":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване действа в сайт по избор на модела: изпраща, пише, качва или изтегля. Страница може да подмами модела да изпрати данните ти или да изтегли каквото тя иска.",
  "provenance.why.taintedMessage":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване изпраща съобщение. Страница може да подмами модела да пише на някого от твое име.",
  "provenance.why.credentialUnderTaint":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване ползва едни от запазените ти данни за достъп.",
  "provenance.why.taintedPersist":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване променя нещо, което остава и след чата (рутина, напомняне, правило, файл).",
  "provenance.why.privateSearch":
    "Този чат прочете съдържание, на което Tavi не вярва, и съдържа лични данни, а това извикване изпраща търсене, което може да ги изнесе навън.",
  "provenance.why.privateGroupReply":
    "Този чат прочете съдържание, на което Tavi не вярва, и съдържа лични данни, а този отговор отива там, където го четат и други хора.",
  "provenance.why.signedInBrowser":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване отваря браузъра с твоя профил: сайтовете, в които имаш вход, от твое име. Страница може да подмами модела да действа в акаунтите ти.",
  "provenance.why.outsideSkillCeiling":
    "Умение, заредено в този чат, изброява инструментите, които ползва (allowed-tools), а това извикване не е сред тях. Одобри го само ако очакваш умението да има нужда от него.",
  "provenance.why.desktopTainted":
    "Този чат прочете съдържание, на което Tavi не вярва, а това извикване действа в приложение на компютъра ти: щраква, пише или натиска клавиши. Прочетеното може да подмами модела да действа от твое име.",
  "provenance.why.tainted": "Този чат прочете съдържание, на което Tavi не вярва, и то може да насочва това извикване.",
  "provenance.origin.person": "от твоето съобщение",
  "provenance.origin.unmatched": "не е в скорошния текст на чата (написано от модела или по-старо)",
  "provenance.origin.source": "среща се в {source}",
  "provenance.origin.tool": "среща се в резултата на {tool}",
  "provenance.origin.anyTool": "среща се в резултата на инструмент",
  "taint.chip": "Прочетено: {sources}",
  "taint.remedy": "Започни нов чат",
  "taint.detail.head": "Този чат прочете съдържание, на което Tavi не вярва:",
  "taint.detail.lasting":
    "До края на чата всяко извикване, което изпраща данни навън, ползва данни за достъп или променя нещо трайно, ще те пита веднъж.",
  "taint.detail.fresh": "Започни нов чат, за да работиш без него: новият чат започва на чисто.",
  "taint.detail.compact": "Командата /compact не го изчиства: обобщението се пише от същото съдържание.",
  "shell.reason.quoting": "ползва кавички ANSI-C или според локала",
  "shell.reason.continuation": "продължава ред с обратна наклонена черта",
  "shell.reason.bracedExpansion": "ползва разгъване на параметър с фигурни скоби",
  "shell.reason.processSubstitution": "ползва заместване на процес",
  "shell.reason.parseDisagreement": "при второ четене дава други команди",
  "skill.ceiling.why": {
    one: "Този чат зареди умението {skills}, което изброява инструментите, които ползва (allowed-tools: {declared}), а това извикване не е сред тях. Одобри го само ако очакваш умението да има нужда от него.",
    other:
      "Този чат зареди уменията {skills}, които изброяват инструментите, които ползват (allowed-tools: {declared}), а това извикване не е сред тях. Одобри го само ако очакваш уменията да имат нужда от него.",
  },
  "skill.ceiling.name": "„{id}“",
  "skill.ceiling.noTools": "няма инструменти",
  "skill.ceiling.unenforceable": "Изброени, но тук не могат да се наложат: {names}.",
  "skill.escalation.dropped": "Разширяване: тази версия маха allowed-tools ({tools}), така че след зареждане нищо не я ограничава",
  "skill.escalation.widened": "Разширяване: тази версия добавя към allowed-tools {tools}",
  "skill.proposal.notice": "Умение чака преглед от теб: {command}",
  "skill.proposal.untrusted":
    "{line}. Части от този текст може да идват от това съдържание, а не от теб или от стъпките на агента: прочети го внимателно, преди да одобриш.",
  "skill.trace.ended": "{call} — {status}",
  "skill.trace.running": "още работи",
  "skill.trace.failed": "неуспешно",
  "skill.trace.interrupted": "прекъснато",
  "skill.history.activated": "Активиране на {version}",
  "skill.history.activatedWas": "Активиране на {version} (преди: {previous})",
  "skill.history.rolledBack": "Връщане към {version}",
  "skill.history.rolledBackWas": "Връщане към {version} (преди: {previous})",
  "skill.history.disabled": "Изключване",
  "skill.history.disabledWas": "Изключване (преди: {previous})",
  "skill.history.none": "няма",
  "skill.usage.never": "не е използвано",
  "skill.usage.count": { one: "{uses} използване, последно {date}", other: "{uses} използвания, последно {date}" },
} as const satisfies CatalogFor<typeof en>;
