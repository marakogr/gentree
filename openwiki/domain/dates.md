---
type: concept
title: Date values, precision and qualifiers
description: The DateValue model for historical dates - half-open bounds, precision, qualifiers and preserved originals - and why the app never invents a timestamp.
tags: [domain, dates, uncertainty, invariants]
sources:
  - id: openwiki-source-c6074f0c21e42f4db3d50032
    resource: repo://desktop/crates/core/src/date.rs
  - id: openwiki-source-4415ac3b9c2f57ace9d84d48
    resource: repo://desktop/crates/core/src/person.rs
  - id: openwiki-source-f35619aa85b2acc8cae9a133
    resource: repo://desktop/crates/import/src/at5.rs
  - id: openwiki-source-82981b8dc435923f049ec7f4
    resource: repo://desktop/ui/src/features/timeline/dates.ts
generated: { by: "opencode", at: "2026-11-02T09:11:48.673Z" }
verified:
  - by: openwiki/0.7.0
    at: 2026-11-02T09:11:48.673Z
---

# Date values, precision and qualifiers

Genealogy runs on incomplete evidence. A record may name a year, a month, a season, or only "before the war". Gentree models that uncertainty instead of collapsing it into a fake day: `DateValue` is the only date type used by persons, events, imports and exports, and `CivilDate` is the only calendar type.

## CivilDate

`CivilDate` is a timezone-free `{year, month, day}`. It serializes as an ISO `YYYY-MM-DD` string and validates month, day and leap years on construction. It is deliberately not a `chrono`/`time` timestamp: a birth on 1950-05-01 is the same date everywhere, and converting it to an instant would inject a timezone the source never had.

## DateValue

```rust
pub struct DateValue {
    pub start: Option<CivilDate>,   // inclusive
    pub end: Option<CivilDate>,     // exclusive
    pub precision: DatePrecision,   // DAY | MONTH | YEAR | UNKNOWN
    pub qualifier: DateQualifier,   // EXACT | APPROXIMATE | BEFORE | AFTER | RANGE | UNKNOWN
    pub original: Option<String>,
}
```

The half-open interval is the core trick. `exact_day(1950-05-01)` stores `start = 1950-05-01`, `end = 1950-05-02`; `exact_month` spans the first of the month to the first of the next; `exact_year` spans January 1 to January 1 of the following year. `before(d)` stores only `end`, `after(d)` stores only `start`.

`original` keeps the user's or importer's exact wording even when the app can parse the value. For unknown dates it is often the only surviving information.

`DateValue::default()` is `unknown(None)`: a new person has no invented birth or death date.

## Validation rules

`DateValue::validate` enforces the contract:

- `precision = UNKNOWN` means no bounds; unknown with a bound is `date/unknownHasBounds`.
- Any other precision needs at least one bound (`date/missingBounds`).
- `BEFORE` may have only `end`, `AFTER` only `start`; anything else is `beforeBounds` or `afterBounds`.
- `EXACT`, `APPROXIMATE` and `RANGE` need both bounds.
- When both bounds exist, `start < end` (`startNotBeforeEnd`).
- Bounds must match the declared precision: a `MONTH` bound is the first of a month, a `YEAR` bound is January 1. `RANGE` is exempt because the user supplied explicit bounds.

The constructors produce valid values; hand-built or imported values are validated on every entity save.

## Where dates appear

`Person` carries `birth` and `death` as `DateValue`. Person validation rejects a death whose start precedes the birth start (`death/beforeBirth`), but it does not require either date to exist. `Event` carries a single `date: DateValue`.

Import and export keep the model symmetric: AT5 date strings are parsed by `import::at5::parse_date`, which always writes the trimmed source into `original` and returns `DateValue::unknown` when the text is not a recognized numeric form. Recognized years, `YYYY-MM` and `YYYY-MM-DD` (also with dots) become normalized precision values; everything else stays unknown rather than guessed.

The timeline works on derived intervals, not on the model: `toTimelineDate` converts bounds into JavaScript `Date` values for layout, `lifeInterval` builds a person's span, and `isOpenEnd` marks `before`/`after` dates so the canvas can render an open edge. Formatting follows the precision, so a year-only date is never displayed as a day.

## Invariant

Never invent a timestamp for an unknown date, and never "repair" an unparsable one. If the app cannot interpret the source, it keeps the original string, sets `precision = UNKNOWN`, and says so. This is a product invariant, not a formatting preference.

## Related pages

<!-- openwiki: broken internal link [/openwiki/domain/persons-and-events.md] link "/openwiki/domain/persons-and-events.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [People, events and validation](/openwiki/domain/persons-and-events.md)
<!-- openwiki: broken internal link [/openwiki/import/at5.md] link "/openwiki/import/at5.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- [AT5 import pipeline](/openwiki/import/at5.md)
