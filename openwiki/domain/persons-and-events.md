---
type: concept
title: People, events and validation
description: The core Person and Event records, type-specific event details, how participants and sources work, which project-wide checks run, the single-birth/single-death rule at write time versus its validation warning, and why deleting a person must not cascade through shared events.
tags: [domain, persons, events, validation, deletion]
sources:
  - id: openwiki-source-b9357914b0833478bb89f27f
    resource: repo://desktop/apps/desktop/src/commands/event.rs
  - id: openwiki-source-7ec74e8a06909c7d14b26020
    resource: repo://desktop/crates/core/src/event_fields.rs
  - id: openwiki-source-4415ac3b9c2f57ace9d84d48
    resource: repo://desktop/crates/core/src/person.rs
  - id: openwiki-source-2ceb2cf109727ad6a4699cb4
    resource: repo://desktop/crates/core/src/record.rs
  - id: openwiki-source-652b594f0a99d5c5858f82f4
    resource: repo://desktop/crates/core/src/validation.rs
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# People, events and validation

`gentree-core` defines the family tree as plain validated records. Every record is a UUID v7 with its own `DateValue`s, and every rule that matters is enforced in `validate()` rather than in the UI. The store validates each entity again before writing it.

## Person

```rust
pub struct Person {
    pub id: Uuid,
    pub gender: Gender,            // MALE | FEMALE | UNKNOWN
    pub names: Vec<Name>,          // BIRTH | MARRIED | RELIGIOUS | OTHER
    pub birth: DateValue,
    pub death: DateValue,
    pub notes: Option<String>,
    pub external_ids: Vec<ExternalId>,
}
```

`Name` separates `given`, `patronymic`, `surname`, `prefix`, `suffix`, a `nameType` and `isPrimary`. A person may be unnamed — real exports contain unknown individuals who still participate in relationships — but at most one name may be primary. `display_name` prefers the primary name and falls back to the first; `Name::display` joins surname, given name and patronymic, skipping empty parts.

`external_ids` preserve provenance from other systems (`source` + `value`). Person validation checks the name rule, both dates and the birth/death order; nothing else is invented.

## Event

An event has exactly one owning person and optional co-participants:

```rust
pub struct Event {
    pub id: Uuid,
    pub person_id: Uuid,           // owner
    #[serde(rename = "type")]
    pub event_type: EventType,     // BIRTH, DEATH, MARRIAGE, DIVORCE, BURIAL, RESIDENCE, OCCUPATION, EDUCATION, OTHER
    pub date: DateValue,
    pub place: Option<String>,     // at most 500 characters
    pub place_geo: Option<PlaceGeo>, // confirmed point, omitted when absent
    pub description: Option<String>,
    pub source_ids: Vec<Uuid>,
    pub original_type: Option<String>, // kept when the source value is not in the enum
    pub participant_ids: Vec<Uuid>,    // never repeats the owner
    pub details: BTreeMap<String, String>, // type-specific values
}
```

A marriage is owned by one spouse and lists the other in `participant_ids`. `involves` answers "does this person take part?" and `detach_person` removes a person from an event:

- removing a co-participant just drops the id;
- removing the owner promotes the first remaining co-participant to owner;
- `detach_person` returns `true` only when nobody is left, meaning the event itself must be deleted.

`Event::validate` requires a non-nil owner, valid dates, a place of at most 500 characters, a valid `place_geo` point when present, and participant ids that are non-nil, distinct, and never equal to the owner. A `Media` row may point at either a person or an event through `event_id`, but never both; see [Event places, coordinates and the map](places-and-map.md) for the point itself.

## Event details

Type-specific values live in one generic `details` map instead of a struct per event type: birth certificates and hospitals, a death cause, marriage witnesses, a residence address, an occupation's position and employer, and so on. Core owns the curated built-in key list (`builtin_event_field_keys`) and the generic shape limits:

- at most 40 entries, key ≤ 64 characters, value ≤ 2000 characters;
- keys are stable lowercase ASCII snake_case (`[a-z][a-z0-9_]*`) so a rename never silently orphans values;
- the domain accepts unknown keys because the schema is config-driven; the config layer adds per-type groups, and the UI resolves built-ins plus config groups with `resolveEventFields`, skipping duplicate keys.

An empty map is omitted on serialization, so events without details stay byte-compatible with older project files.

## Single birth and death

Birth and death are single events of a life, enforced at two different strengths:

- **Write commands** - `event_create` and `event_update` call `ensure_single_life_event` and fail with `LIFE_EVENT_ALREADY_EXISTS` when the same person would get a second `BIRTH` or `DEATH`. Editing an existing birth/death (same person and type) is allowed, so old duplicates can still be corrected; moving an event to another person or type is checked. The chat tool backend applies the same guard.
- **Project validation** - `DUPLICATE_LIFE_EVENT` is a **warning**, not an error. Imports and merges write rows directly, so a project that already contains duplicate birth or death events stays readable, listable and mergeable; the validation report lists the group and the UI offers to open it.

Residence, occupation, education and `OTHER` events may repeat freely and are never reported by this rule.

Legacy projects may have marriage events without the second spouse. `backfill_marriage_participants` adds the partner only when the person has exactly one spouse/partner link; ambiguous people are left untouched rather than guessed. The desktop runs this repair once when opening a writable project.

## Sources and citations

`Source` requires a non-empty title and only accepts `http://` or `https://` URLs. `Citation` points a source at a person, event, relationship or media row; its `source_id` and `target_id` must be non-nil. Confidence is optional (`LOW`, `MEDIUM`, `HIGH`).

## Project-wide validation

`validate_project` takes a borrowed `ProjectSnapshot` and returns a deterministic `ValidationReport`:

1. duplicate ids across all six collections (`DUPLICATE_ID`);
2. dangling references (`DANGLING_REFERENCE`) for every relationship, event participant, citation and media/source link;
3. relationship invariants from `RelationshipSet`;
4. per-entity `validate()` failures (`VALIDATION_ERROR` with parameters);
5. duplicate life events (`DUPLICATE_LIFE_EVENT`, warning) when one person owns more than one `BIRTH` or `DEATH`;
6. lifespan warnings (`EVENT_OUT_OF_LIFESPAN`) when an event lies wholly before the owner's birth or at/after the owner's death.

`is_valid()` is true only when there are zero errors; warnings never block. Lifespan checks skip death and burial events and only use bounds the data actually has, so an unknown or open-ended date never produces a fake bound.

`checked_at` is the only generated timestamp, and it is report metadata, not project data.

## Deleting a person

`removal_plan` computes what to delete without mutating anything:

- relationships touching the person are removed;
- an event owned by the person with no other participants is removed;
- an event that still has other participants is **kept** and returned in `kept_event_ids`; the caller must detach the person from it instead of deleting shared history;
- citations targeting the person, a removed event or a removed relationship are removed;
- citations targeting media are never removed, and media files are never deleted by a person deletion.

This is the concrete form of the product invariant "deleting a person must not cascade-delete events with other participants".

## Related pages

- [Relationships, graph invariants and kinship](relationships-and-kinship.md)
- [Event places, coordinates and the map](places-and-map.md)
- [Date values, precision and qualifiers](dates.md)
- [Project merge: preview, decisions and apply](../architecture/project-merge.md)
- [Project folder format and write discipline](../architecture/project-format.md)
