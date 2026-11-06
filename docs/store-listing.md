# Microsoft Store listing: Gentree

Copy for Partner Center **Store listings**. Plain text only, no Markdown; the
Store adds the bullets to Product features itself. Limits: description 10,000
characters, short description 1,000 (keep it under 270 — some views cut there),
product features 20 × 200, keywords 7 × 40 (21 words total per language).

Fill this in for every language the package declares
(`en-us`, `ru-ru`, `uk-ua`, `be-by`, `de-de`, `es-es`); English and Russian are
written here, the rest can start from the English text.

The first submission has no "What's new in this version": leave that field
blank. Use the template at the end for 0.8.0 and later.

---

## English (en-us)

### Product name

Gentree

### Short description

Local-first family history. Your tree is a folder of files you own: people,
events, sources, photos, a readable tree, a timeline and a map — plus an
assistant that asks before it edits anything.

### Description

Gentree is a desktop app for family history research. It keeps an archive as a
folder on your disk — readable JSON files you can copy, back up, and open
without the app — instead of locking it in a service.

Honest dates
A date can be exact, approximate, a range, "before" or "after", or simply
unknown, down to the day, month or year. Gentree never invents a date, and dates
that came from an imported file keep their original precision and wording.

A tree that stays readable
Ancestors, descendants and blood relatives are laid out as separate families
instead of one tangle of lines. Pick a root person and every card shows how that
person is related to them. Ask for the term between any two people and Gentree
shows the common ancestor and the path.

One story across the archive
Events, Map and Timeline share the same filters: person, relation, event type and
years. Jump from a person's events to the timeline and back without losing the
selection.

Bring your research along
Open AT5 archives (the Drevo Zhizni format) read-only — the original file is
never modified — and import GEDCOM 5.5.1 or 7.0. Everything that could not be
parsed is reported instead of being dropped. Export to GEDCOM 5.5.1/7.0 or to
JSON/ZIP with media metadata.

Photos, sources and quality checks
Attach photos and documents with checksums; removing a link never deletes the
file. Keep sources and citations with the facts they support, and run checks for
duplicate identifiers, dangling references, broken relationship rules and
impossible lifespans.

An assistant that asks first
Gentree ships its own catalog of genealogy tools and guides, so an
OpenAI-compatible model works on the archive you have open: search, read people
and events, walk ancestors, explain kinship, validate the project. Editing is
opt-in: each change is validated in a dry run and shown as a before/after card,
and nothing is written until you confirm. The tools run inside the app, with no
server listening on a port; until you configure a provider, chat sends nothing.

Privacy
No Gentree account, no backend, no telemetry. Online services are used only for
optional features, each with its own switch in Settings: chat with a provider you
configure, address suggestions for places, historical place-name lookup, online
map tiles (an offline outline is available), and update checks (off by default).
Turn a switch off and that feature stops using the network.

Languages and requirements
Interface in Russian, Ukrainian, Belarusian, English, German and Spanish.
Windows 10 version 1809 or newer, or Windows 11, x64, with the Microsoft Edge
WebView2 Runtime (included in Windows 11 and current Windows 10; otherwise a free
download from Microsoft). Everything except the optional online services works
without an internet connection.

### Product features

- Local-first: a project is a folder of readable files you can copy and keep.
- No accounts, no backend, no telemetry.
- Exact, approximate, range or unknown dates — never guessed.
- Ancestor, descendant and blood-relative trees with kinship terms.
- Shared filters across Events, Map and Timeline.
- AT5 (Drevo Zhizni) read-only import; GEDCOM 5.5.1/7.0 import and export.
- Full-text search over names, biographies, events, places and sources.
- Photos and documents with checksums; unlinking never deletes a file.
- Duplicate, dangling-reference and lifespan checks on the archive.
- Optional AI assistant that edits only after a dry run you confirm.
- Six interface languages; works offline.

### Keywords

genealogy, family tree, family history, GEDCOM, ancestry, local-first, archive

### Additional system requirements

- Microsoft Edge WebView2 Runtime (free from Microsoft; already present in Windows 11 and current Windows 10).
- Internet connection only for the optional online services and the AI chat; the archive works offline.

---

## Русский (ru-ru)

### Название продукта

Gentree

### Краткое описание

Семейная история, которая хранится у вас. Дерево — это папка с файлами: люди,
события, источники, фотографии, читаемое древо, хронология и карта. Плюс
ассистент, который спрашивает, прежде чем что-то изменить.

### Описание

Gentree — настольное приложение для исследования семейной истории. Архив лежит
папкой на вашем диске: понятные JSON-файлы, которые можно скопировать, сохранить
про запас и открыть без приложения, — а не запись в чужом сервисе.

Честные даты
Дата может быть точной, примерной, диапазоном, «до» или «после», либо просто
неизвестной — с точностью до дня, месяца или года. Gentree не придумывает даты, а
точность и формулировку из импортированного файла сохраняет как есть.

Дерево, которое читается
Предки, потомки и кровные родственники раскладываются отдельными семьями, а не
одним клубком линий. Выберите корневого человека — и каждая карточка покажет, кем
он приходится ему. Для любых двоих можно узнать термин родства, общего предка и
путь между ними.

Одна история на весь архив
«События», «Карта» и «Хронология» делят одни и те же фильтры: человек, связь, тип
события, годы. Из событий человека можно перейти в хронологию и вернуться обратно,
ничего не потеряв.

Исследование можно перенести
Архивы AT5 (формат программы «Древо жизни») открываются только для чтения —
исходный файл не меняется. GEDCOM 5.5.1 и 7.0 импортируются, всё непонятое
попадает в отчёт, а не пропадает молча. Экспорт — в GEDCOM 5.5.1/7.0 или в JSON/ZIP
с метаданными о медиафайлах.

Фотографии, источники и проверки
Фотографии и документы прикрепляются с контрольными суммами; удаление ссылки
никогда не удаляет файл. Источники и цитаты хранятся рядом с фактами, которые они
подтверждают. Встроенные проверки находят повторяющиеся идентификаторы, ссылки в
никуда, нарушения правил родства и невозможные даты жизни.

Ассистент, который сначала спрашивает
В Gentree есть собственный набор генеалогических инструментов и подсказок, поэтому
OpenAI-совместимая модель работает с тем архивом, который открыт: ищет, читает
людей и события, проходит по предкам, объясняет родство, проверяет проект.
Редактирование включается отдельно: каждое изменение проходит пробный прогон и
показывается карточкой «до/после», а запись происходит только после подтверждения.
Инструменты работают внутри приложения — никакого сервера на порту; пока провайдер
не настроен, чат ничего не отправляет.

Приватность
Нет аккаунта Gentree, нет бэкенда и телеметрии. Сеть нужна только необязательным
функциям, и у каждой есть переключатель в настройках: чат с настроенным вами
провайдером, подсказки адресов для мест, поиск исторических названий, онлайн-слой
карты (есть офлайн-контур) и проверка обновлений (по умолчанию выключена).
Выключите переключатель — и функция перестанет обращаться в сеть.

Языки и требования
Интерфейс на русском, украинском, белорусском, английском, немецком и испанском.
Windows 10 версии 1809 или новее либо Windows 11, x64, с Microsoft Edge WebView2
Runtime (входит в Windows 11 и актуальные обновления Windows 10, иначе бесплатно
скачивается у Microsoft). Всё, кроме необязательных онлайн-функций, работает без
интернета.

### Возможности

- Всё хранится у вас: проект — папка с понятными файлами, которую можно скопировать.
- Без аккаунтов, без бэкенда, без телеметрии.
- Точные, примерные, диапазонные и неизвестные даты — без выдумывания.
- Древо предков, потомков и кровных родственников с терминами родства.
- Общие фильтры в «Событиях», «Карте» и «Хронологии».
- Импорт AT5 («Древо жизни») только для чтения; импорт и экспорт GEDCOM 5.5.1/7.0.
- Полнотекстовый поиск по именам, биографиям, событиям, местам и источникам.
- Фотографии и документы с контрольными суммами; удаление ссылки не удаляет файл.
- Проверки на дубли, ссылки в никуда и невозможные даты жизни.
- Необязательный ИИ-ассистент: правит только после пробного прогона и подтверждения.
- Шесть языков интерфейса; работает без интернета.

### Ключевые слова

генеалогия, семейное дерево, родословная, GEDCOM, предки, семейный архив, древо

### Дополнительные системные требования

- Microsoft Edge WebView2 Runtime (бесплатно у Microsoft; уже есть в Windows 11 и актуальных обновлениях Windows 10).
- Интернет нужен только необязательным онлайн-функциям и чату с ИИ; архив работает офлайн.

---

## What's new (для следующих версий)

Поле «Что нового в этой версии» (до 1500 знаков) заполняется начиная со второй
отправки. Для первой оставьте пустым.

Шаблон для 0.8.0:

```
English:
- <change one>
- <change two>

Русский:
- <изменение>
- <изменение>
```
