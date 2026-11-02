//! Idempotency helpers shared by importers. Contract: ADR-0013.
//!
//! The dedupe key is `(source, externalId)` first; when a person has no
//! external id, or the id is not known to the existing set, the fallback is
//! `(normalised FIO, birth.start, death.start)`. Only stable reason codes are
//! reported, never field values.

use std::collections::BTreeMap;

use gentree_core::date::CivilDate;
use gentree_core::person::{Person, PersonId};

use crate::report::{Conflict, ConflictReason};

type FioKey = (String, Option<CivilDate>, Option<CivilDate>);

/// Split `incoming` into records that are new and records that already exist.
///
/// `new` keeps the incoming order, so callers can write it as-is. A conflict is
/// produced for every incoming person that matches `existing` by external id
/// or by the `(fio, dates)` fallback; matched persons are not returned in
/// `new`, so a repeated import never duplicates records.
pub fn dedupe_persons(existing: &[Person], incoming: Vec<Person>) -> (Vec<Person>, Vec<Conflict>) {
    let mut by_external: BTreeMap<(String, String), PersonId> = BTreeMap::new();
    let mut by_fio: BTreeMap<FioKey, PersonId> = BTreeMap::new();
    for person in existing {
        for external in &person.external_ids {
            by_external
                .entry((external.source.clone(), external.value.clone()))
                .or_insert(person.id);
        }
        by_fio.entry(fio_key(person)).or_insert(person.id);
    }

    let mut fresh = Vec::new();
    let mut conflicts = Vec::new();
    for (incoming_index, person) in incoming.into_iter().enumerate() {
        let matched = person.external_ids.iter().find_map(|external| {
            by_external
                .get(&(external.source.clone(), external.value.clone()))
                .map(|id| (*id, ConflictReason::ExternalId))
        });
        let matched = matched.or_else(|| {
            by_fio
                .get(&fio_key(&person))
                .map(|id| (*id, ConflictReason::FioAndDates))
        });
        match matched {
            Some((existing_id, reason)) => conflicts.push(Conflict {
                incoming_index,
                existing_id,
                reason,
            }),
            None => fresh.push(person),
        }
    }
    (fresh, conflicts)
}

/// Lowercase, whitespace-collapsed display name plus both date starts.
fn fio_key(person: &Person) -> FioKey {
    let display = person.display_name().to_lowercase();
    let name = display.split_whitespace().collect::<Vec<_>>().join(" ");
    (name, person.birth.start, person.death.start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gentree_core::person::{ExternalId, Name};

    fn person(given: &str, surname: &str, birth: Option<i32>) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some(given.into()),
            surname: Some(surname.into()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap();
        if let Some(year) = birth {
            person.birth = gentree_core::date::DateValue::exact_year(year);
        }
        person
    }

    fn external(person: &mut Person, value: &str) {
        person.external_ids.push(ExternalId {
            source: "AT5".into(),
            value: value.into(),
        });
    }

    #[test]
    fn same_external_id_is_a_conflict_not_a_new_person() {
        let mut existing = person("Иван", "Петров", Some(1950));
        external(&mut existing, "1");
        let mut incoming = person("Иван", "Петров", Some(1950));
        external(&mut incoming, "1");

        let (fresh, conflicts) = dedupe_persons(&[existing.clone()], vec![incoming]);
        assert!(fresh.is_empty());
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].incoming_index, 0);
        assert_eq!(conflicts[0].existing_id, existing.id);
        assert_eq!(conflicts[0].reason, ConflictReason::ExternalId);
    }

    #[test]
    fn fio_and_dates_fall_back_when_external_ids_are_absent() {
        let existing = person("Иван", "Петров", Some(1950));
        let incoming = person("  иван ", "ПЕТРОВ", Some(1950));
        let different = person("Иван", "Петров", Some(1951));

        let (fresh, conflicts) =
            dedupe_persons(std::slice::from_ref(&existing), vec![incoming, different]);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].incoming_index, 0);
        assert_eq!(conflicts[0].existing_id, existing.id);
        assert_eq!(conflicts[0].reason, ConflictReason::FioAndDates);
        assert_eq!(fresh.len(), 1, "different dates are a different person");
        assert_eq!(fresh[0].birth.start.unwrap().to_iso(), "1951-01-01");
    }

    #[test]
    fn unrelated_persons_are_all_new() {
        let existing = person("Иван", "Петров", None);
        let incoming = vec![person("Мария", "Иванова", None)];
        let (fresh, conflicts) = dedupe_persons(&[existing], incoming);
        assert_eq!(fresh.len(), 1);
        assert!(conflicts.is_empty());
    }
}
