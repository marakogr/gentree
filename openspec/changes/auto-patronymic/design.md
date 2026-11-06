# Design

## Context

See `proposal.md` for motivation and `specs/person-names/spec.md` for the contract.

Current state that shapes the approach:

- `Name` has an optional `patronymic`; a person may have several names with at most one `is_primary`. Imported and manual values are stored verbatim.
- A biological father is a `PARENT_CHILD` row with `person_id` as the father and `related_person_id` as the child. `Person.gender` is `MALE`, `FEMALE` or `UNKNOWN`.
- A `BIRTH` event lists zero, one or two parents in `participant_ids`, and event saves derive missing parent rows. The relation command and the event commands are the two write paths where a father becomes known.
- There is no language field on a person or a name, and no name-morphology dependency in the workspace.

## Goals / Non-Goals

**Goals:**

- One pure, testable rule shared by every write path.
- Conservative behavior: an unclear case is a no-op, never a guess and never an error.
- Preserve imported and manual names; fill only an empty field.
- Keep commands testable without Tauri state where the existing code already is.

**Non-Goals:**

- Inflecting surnames or given names, or changing the display name.
- Deriving a patronymic from a mother, an adoptive parent, a spouse or a godparent.
- A full dictionary of given names and stress-dependent forms.
- Filling during project open, import or read-only access.
- A locale setting or a new UI string.

## Decisions

### D1. Script and spelling select the suffix table

`derive_patronymic` trims and lowercases the father's given name, then requires every character to be Cyrillic. Latin and mixed-script names, digits, separators and internal spaces return `None`.

Within Cyrillic, the spelling selects the suffix table:

- any of `і`, `ї`, `є`, `ґ` marks Ukrainian (`-ович`/`-івна`, `-йович`/`ївна`);
- `ў` or a non-initial `э` marks Belarusian (`-авіч`/`-аўна`, `-евіч`/`-еўна`);
- otherwise the name uses the Russian table (`-ович`/`-овна`, `-евич`/`-евна`, `-ич`/`-ична`);
- both markers present means the local form cannot be chosen and returns `None`.

This is a heuristic, not a locale lookup: the archive has no language field, and the issue explicitly prefers leaving the field empty over inventing a local form.

### D2. Russian endings and the irregular table

The regular Russian rules are:

- `-й` and `-ь`: drop the final character, add `-евич`/`-евна` (`Андрей`, `Игорь`);
- `-а`: drop it, add `-ич`/`-ична` (`Никита`);
- `-о`: drop it, add `-ович`/`-овна` (`Петро`, `Михайло`);
- a hard consonant: add `-ович`/`-овна` (`Иван`, `Александр`);
- anything else: `None`.

`-ий` is ambiguous between soft stems (`Василий -> Васильевич`) and hard stems (`Дмитрий -> Дмитриевич`), so the regular rule refuses it. A short table resolves common irregular names (`Пётр`, `Павел`, `Лев`, `Яков`, `Илья`, `Василий`, `Дмитрий`, `Юрий`, `Григорий`, `Евгений`, `Анатолий`, `Аркадий`, `Кузьма`, `Фома`, `Лука`). The table is data, not a new dependency, and only affects names a user would expect to work.

Alternative: a full morphology crate. Rejected because issue #108 forbids an external dependency without a separate decision and the required cases are a small, stable set.

Alternative: always use `-ович`/`-овна`. Rejected because `Игорь` and `Андрей` would be wrong.

### D3. Empty means `None`, empty string or whitespace

`fill_patronymic` selects the primary name, falling back to the first name. It writes only when the stored patronymic is absent or trims to empty. A non-empty value, including one with surrounding spaces that is otherwise meaningful, is never replaced. The derived value's first character is uppercased and the rest is lowercased.

If the person is unnamed, has no primary name and no first name, or has `Gender::UNKNOWN`, the fill is a no-op.

### D4. Exactly one male biological parent

`unique_father_given_name` collects distinct `PARENT_CHILD` parents of the child whose gender is `MALE` and whose given name is usable. Zero or more than one distinct father returns `None`. `ADOPTIVE_PARENT_CHILD` rows and female or unknown-gender parents are ignored.

Alternative: pick the first male parent. Rejected because a second father is ambiguous data, and the issue asks for no guess in ambiguous cases.

### D5. Triggers and write ordering

The fill is applied in the commands that already write the child or the link:

- `create_relationship`: after the future relation set validates, compute the unique father from the prospective rows and fill the child. Persons are written last, after events and relationships, so a failed relation write cannot leave a patronymic without its relation.
- `event_create` / `event_update`: only for a `BIRTH` event; after `derive_event_relations` adds the parent rows, fill the event owner. Persons are written after events and relationships.
- `person_update`: before replacing the stored person, read the existing relationships and fill the submitted entity. This is the form-save path; the saved response carries the filled value back to the form.

`person_create` does nothing because a newly created person has no relation yet. `person_get` and export/import do not fill. A writable project open runs the idempotent pass once for already-stored fathers (issue #130); a read-only open does not. Reading must never write outside that one migration, and imported values keep priority.

Alternative: fill in `person_get` so the form shows the value on open. Rejected because a read command would write the project, and because the value would not be durable if the user never saves.

### D6. No error on a skipped case

Every trigger returns a boolean and the caller writes persons only when it is true. A missing father, unknown gender, ambiguous name or Latin name is an ordinary no-op with no error code and no UI message; the user can still type the patronymic.

### D7. Tests

Core unit tests cover the required common names for both genders, soft/hard/irregular endings, Ukrainian and Belarusian spellings, Latin and mixed-script names, unknown gender, ambiguity, the empty-only rule, whitespace values, unnamed people and the unique-father selection. Command tests cover relation creation for a son and a daughter, a non-empty imported value, an unknown-gender child, a Latin father, and a birth event that fills the patronymic. All fixtures are synthetic.

## Risks / Trade-offs

- **Heuristic spelling detection.** A name that uses shared letters can be classified into the wrong East Slavic table. The rule is conservative on mixed markers and never touches a non-empty value; a user can correct the field manually.
- **Irregular names.** A name outside the table with an `-ий` ending stays empty. This is the required ambiguity behavior, not an error.
- **Clearing a patronymic while a father exists.** Saving an empty value fills it again on the next save. The issue defines the behavior as "empty patronymic is filled"; editing a derived value to a different non-empty value is durable.
- **Three files are not one transaction.** A failed write after an earlier one is reported and the next save retries the idempotent fill. No command claims atomicity across files.
- **Two male parents.** Both are valid stored relations, but the patronymic is left empty because the father is ambiguous.

## Migration Plan

A writable project open backfills an empty patronymic from an already-stored biological father (issue #130). The pass is idempotent, fills only an empty value, and reports an aggregate count; a read-only project is untouched. Imported non-empty values and existing relations are never rewritten. Rollback is safe: older builds ignore the new helper and read the same files.
