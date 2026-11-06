# Proposal

## Why

The archive knows a child's biological father through a `PARENT_CHILD` relation and the child's `BIRTH` event, but the patronymic is still typed by hand. Issue #108 asks the app to derive it from the father's given name when the child has no patronymic, without inventing a form when the name, gender or rule is unclear.

The user asked for this behavior directly. It does not change the relation model or the project format: the patronymic is an ordinary name field, and the fill is skipped whenever it already has a value.

## What Changes

- A pure core rule derives a patronymic from the father's given name and the child's gender for names written in Cyrillic. The supported examples are `Игорь -> Игоревич/Игоревна`, `Андрей -> Андреевич/Андреевна`, `Иван -> Иванович/Ивановна` and `Никита -> Никитич/Никитична`.
- The rule covers hard and soft endings, a small table of irregular common names, and Ukrainian/Belarusian spellings that use distinct letters. A Latin or other non-Cyrillic name, an unknown child gender, an empty name or an ending the rule cannot resolve returns no value.
- Only an empty primary patronymic is filled. A non-empty patronymic, including an imported one, is never replaced. No father, two or more male biological parents, an adoptive-only parent, an unnamed father or an ambiguous name leaves the field unchanged without an error.
- The fill runs where the father becomes known:
  - creating a biological `PARENT_CHILD` relation through `relationship_create`;
  - saving a `BIRTH` event whose participants include the father;
  - saving the person form with an empty patronymic while a stored biological father exists;
  - opening a writable project that already stores the father relation (issue #130), once and idempotently.
- A read-only open, import and export never write a patronymic; the writable on-open pass reports only an aggregate count.
- No new IPC command, dependency, relation type, validation rule or storage field is added. The person form and the person card need no markup change because the saved person response already carries the name.

Out of scope: patronymics from a mother or an adoptive parent, a full name lexicon, surname or given-name inflection, locale selection for a name, and any retroactive rewrite of imported projects. Import writes its bundle directly and is not touched.

## Capabilities

### New Capabilities

- `person-names`: deriving and filling a patronymic from a biological father, with the conservatism rules above.

### Modified Capabilities

None. `relationships` keeps its current behavior; the fill consumes existing parent relations and birth participants.

## Impact

- `desktop/crates/core`: a new `patronymic` module with the pure derivation and fill helpers, plus unit tests for morphology, gender, ambiguity and the empty-only rule.
- `desktop/apps/desktop`: `create_relationship`, `event_create`, `event_update` and `person_update` call the core helper and write persons only when the value changed; command tests cover the relation and birth-event paths.
- `desktop/docs/relations-from-events.md`: documents when the fill runs and why it is conservative.
- Storage format, checksums, search, import, media, the chat tool surface and all UI dictionaries are unchanged.

## HITL

No mandatory-stop item changes: the relation and adoption model, deletion and merge behavior, re-import policy, date semantics, project format, architecture and IPC surface stay as they are. Adding a field value is ordinary validation-level behavior, not a change to who is a parent.
