import type { CatalogFor } from "@tavi/contracts/i18n";

import type { workers as en } from "../en/workers.js";

/** The words of features/workers, in Bulgarian. */
export const workers = {
  "workers.tree.cancelRefused": "Спирането беше отказано",
  "workers.tree.label": "йерархия на помощниците",
  "workers.tree.ancestry": "произход на задачата",
  "workers.tree.loading": "Зареждам дървото…",
  "workers.tree.ancestryUnknown": "Историята на родителските задачи е непълна.",
  "workers.tree.truncated":
    "Дървото е съкратено до {tasks} задачи или {ancestors} предшественика. Отвори дъщерна задача, за да видиш нейното поддърво.",
  "workers.tree.needs":
    "Този помощник или помощниците под него чакат: {needs}. На въпрос или предаване на браузъра от помощник отговаряш тук и в разговора на чата.",
  "workers.tree.completed": "Завършени ({count})",
  "workers.tree.noChildren": "Няма записани дъщерни задачи.",
  "workers.tree.updated": "обновено {when}",
  "workers.tree.using": "Използва {tool}",
  "workers.tree.nodeNeeds": "Чака {needs}",
  "workers.tree.cancel": "Спри {id}",
  "workers.tree.dismiss": "Скрий {id}",
  "workers.tree.under": { one: "{count} помощник под него", other: "{count} помощници под него" },

  "workers.needs.worker": "помощник {id}",
  "workers.needs.label": "помощниците ти питат",
  "workers.needs.whose": "въпрос от {asker}",
  "workers.needs.several":
    "Отворени са няколко въпроса: отговори на всеки в неговата карта. Съобщение, написано отдолу, отива в чата, а не като отговор.",
  "workers.needs.asks": "{asker} пита:",

  "workers.view.treeUnavailable": "Дървото не е достъпно. Рестартирай сървъра на Tavi с тази версия.",
  "workers.view.treeMismatch": "Отговорът за дървото е за друга задача или работно пространство.",
  "workers.view.finalAnswer": "крайният отговор на {label}: ",
  "workers.view.showLess": "Покажи по-малко",
  "workers.view.showAll": "Покажи всичко",
  "workers.view.historyUnread": "Не успях да прочета историята на този помощник.",
  "workers.view.earlierUnread": "Не успях да прочета по-ранните ходове.",
  "workers.view.title": "Помощник {label} — само за преглед",
  "workers.view.close": "Затвори",
  "workers.view.notAChat": "Помощникът не е чат: не приема съобщения, а на въпросите му отговаряш в този чат.",
  "workers.view.loading": "Зареждам историята на помощника…",
  "workers.view.loadEarlier": "Зареди по-ранни ходове",
  "workers.view.askedOf": "Възложено на {label}",
  "workers.view.failed": "Неуспешно",
  "workers.view.failedWith": "Неуспешно: {message}",
  "workers.view.stopped": "Спряно.",
  "workers.view.waited": "Чакаше човек.",
  "workers.view.working": "Работи…",
  "workers.view.nothingSaved": "Още няма нищо запазено: ходът ще се появи тук, щом приключи.",
} as const satisfies CatalogFor<typeof en>;
