# Tasks

## 1. Core rule and tests

- [x] 1.1 Add a pure `patronymic` module with `derive_patronymic`, `fill_patronymic` and `unique_father_given_name`; no I/O, no new dependency.
- [x] 1.2 Implement the Russian hard/soft/vowel endings, the irregular-name table and the Ukrainian/Belarusian suffix tables.
- [x] 1.3 Return `None` for Latin or mixed-script names, an unknown gender, an empty name and an ambiguous ending.
- [x] 1.4 Fill only an absent or whitespace-only primary patronymic; keep every non-empty value.
- [x] 1.5 Add unit tests for the required common names in both genders, irregular endings, Ukrainian/Belarusian forms, Latin and mixed-script no-ops, unknown gender, ambiguity, the empty-only rule and the unique-father selection.

## 2. Command integration

- [x] 2.1 Fill the child in `create_relationship` from the prospective `PARENT_CHILD` set; write persons only when the value changed, after events and relationships.
- [x] 2.2 Fill the event owner in `event_create` and `event_update` for a `BIRTH` event after relation derivation; write persons only on change.
- [x] 2.3 Fill the submitted person in `person_update` from the stored biological father before the person write.
- [x] 2.4 Add command tests for a son, a daughter, a non-empty imported value, an unknown-gender child, a Latin father and a birth event.

## 3. Documentation

- [x] 3.1 Document the trigger paths, the empty-only rule and the conservative script selection in `desktop/docs/relations-from-events.md`.
- [x] 3.2 Keep the change out of the project format, import, chat tools, UI dictionaries and the relation model.

## 4. Verification

- [x] 4.1 Run the targeted core, relationship and event tests.
- [x] 4.2 Run `make check` and `git diff --check`.
- [x] 4.3 Validate the OpenSpec change and re-read the diff for synthetic-only fixtures, no absolute paths and no unrelated edits.
