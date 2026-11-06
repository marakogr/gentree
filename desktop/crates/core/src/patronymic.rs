//! Derive a patronymic from the father's given name.
//!
//! The archive stores no language field for a name, so the rule is chosen from
//! the script and spelling of the father's given name. This module is pure: it
//! never reads storage, never localizes text and never invents a form it cannot
//! support. A Latin name, an unknown child gender, an empty name or an
//! ambiguous ending returns `None`, and the caller leaves the field untouched.

use uuid::Uuid;

use crate::person::{Gender, Person};
use crate::relationship::{Relationship, RelationshipType};

/// East Slavic spelling supported by the suffix table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Variant {
    Russian,
    Ukrainian,
    Belarusian,
}

/// Common male names whose patronymic is not produced by the regular ending
/// rule. Only Russian orthography needs this table; the entries are checked
/// before the ending rule.
const RUSSIAN_IRREGULAR: &[(&str, &str, &str)] = &[
    ("дмитрий", "дмитриевич", "дмитриевна"),
    ("василий", "васильевич", "васильевна"),
    ("юрий", "юрьевич", "юрьевна"),
    ("анатолий", "анатольевич", "анатольевна"),
    ("григорий", "григорьевич", "григорьевна"),
    ("евгений", "евгеньевич", "евгеньевна"),
    ("аркадий", "аркадьевич", "аркадьевна"),
    ("пётр", "петрович", "петровна"),
    ("петр", "петрович", "петровна"),
    ("павел", "павлович", "павловна"),
    ("яков", "яковлевич", "яковлевна"),
    ("лев", "львович", "львовна"),
    ("илья", "ильич", "ильинична"),
    ("кузьма", "кузьмич", "кузьминична"),
    ("фома", "фомич", "фоминична"),
    ("лука", "лукич", "лукинична"),
];

/// Derive the patronymic for a child of `child_gender` from the father's given
/// name. Returns `None` for a Latin/non-Cyrillic name, an unknown gender, an
/// empty name or an ending the rule cannot resolve unambiguously.
#[must_use]
pub fn derive_patronymic(father_given_name: &str, child_gender: Gender) -> Option<String> {
    if child_gender == Gender::Unknown {
        return None;
    }
    let lower = father_given_name.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let variant = classify(&lower)?;
    let form = match variant {
        Variant::Russian => russian(&lower, child_gender)?,
        Variant::Ukrainian => ukrainian(&lower, child_gender)?,
        Variant::Belarusian => belarusian(&lower, child_gender)?,
    };
    Some(capitalize(&form))
}

/// Fill the person's primary name patronymic when it is empty. Returns whether
/// anything was written. A non-empty patronymic (including an imported one) is
/// never replaced, and an unknown gender or unusable father name is a no-op.
pub fn fill_patronymic(person: &mut Person, father_given_name: &str) -> bool {
    if person.gender == Gender::Unknown {
        return false;
    }
    let Some(index) = primary_name_index(person) else {
        return false;
    };
    if person.names[index]
        .patronymic
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return false;
    }
    let Some(derived) = derive_patronymic(father_given_name, person.gender) else {
        return false;
    };
    if person.names[index].patronymic.as_deref() == Some(derived.as_str()) {
        return false;
    }
    person.names[index].patronymic = Some(derived);
    true
}

/// The given name of the single biological father of `child_id`, if exactly one
/// male `PARENT_CHILD` parent exists and has a usable given name.
///
/// Adoptive parents and female parents are ignored. Two or more male biological
/// parents are ambiguous, so they produce `None`.
#[must_use]
pub fn unique_father_given_name(
    persons: &[Person],
    relationships: &[Relationship],
    child_id: Uuid,
) -> Option<String> {
    let mut father_ids: Vec<Uuid> = Vec::new();
    for row in relationships {
        if row.rel_type != RelationshipType::ParentChild || row.related_person_id != child_id {
            continue;
        }
        let Some(parent) = persons.iter().find(|person| person.id == row.person_id) else {
            continue;
        };
        if parent.gender == Gender::Male && !father_ids.contains(&parent.id) {
            father_ids.push(parent.id);
        }
    }
    if father_ids.len() != 1 {
        return None;
    }
    let father = persons.iter().find(|person| person.id == father_ids[0])?;
    given_name(father).map(str::to_owned)
}

fn primary_name_index(person: &Person) -> Option<usize> {
    person
        .names
        .iter()
        .position(|name| name.is_primary)
        .or_else(|| (!person.names.is_empty()).then_some(0))
}

fn given_name(person: &Person) -> Option<&str> {
    person
        .names
        .iter()
        .find(|name| name.is_primary)
        .and_then(|name| usable_given(name.given.as_deref()))
        .or_else(|| {
            person
                .names
                .iter()
                .find_map(|name| usable_given(name.given.as_deref()))
        })
}

fn usable_given(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn classify(lower: &str) -> Option<Variant> {
    if lower
        .chars()
        .any(|character| !('\u{0400}'..='\u{04FF}').contains(&character))
    {
        return None;
    }
    let has_ukrainian = lower
        .chars()
        .any(|character| matches!(character, 'і' | 'ї' | 'є' | 'ґ'));
    let has_belarusian =
        lower.contains('ў') || lower.chars().skip(1).any(|character| character == 'э');
    match (has_ukrainian, has_belarusian) {
        (false, false) => Some(Variant::Russian),
        (true, false) => Some(Variant::Ukrainian),
        (false, true) => Some(Variant::Belarusian),
        // Both markers are present: the local form cannot be chosen safely.
        (true, true) => None,
    }
}

fn russian(lower: &str, gender: Gender) -> Option<String> {
    if let Some((_, male, female)) = RUSSIAN_IRREGULAR.iter().find(|(name, _, _)| *name == lower) {
        return Some(
            if gender == Gender::Male {
                *male
            } else {
                *female
            }
            .to_owned(),
        );
    }
    // "-ий" is ambiguous between soft stems (Василий -> Васильевич) and hard
    // stems (Дмитрий -> Дмитриевич); the table above resolves the common ones.
    if lower.ends_with("ий") {
        return None;
    }
    let (last, stem) = split_last(lower)?;
    let form = match last {
        'й' | 'ь' => join(stem, gender, "евич", "евна"),
        'а' => join(stem, gender, "ич", "ична"),
        'о' => join(stem, gender, "ович", "овна"),
        hard if is_hard(hard) => join(lower, gender, "ович", "овна"),
        _ => return None,
    };
    Some(form)
}

fn ukrainian(lower: &str, gender: Gender) -> Option<String> {
    let (last, stem) = split_last(lower)?;
    let form = match last {
        'й' => join(stem, gender, "йович", "ївна"),
        'ь' => join(stem, gender, "ович", "івна"),
        'а' => join(stem, gender, "ович", "івна"),
        'о' => join(stem, gender, "ович", "івна"),
        hard if is_hard(hard) => join(lower, gender, "ович", "івна"),
        _ => return None,
    };
    Some(form)
}

fn belarusian(lower: &str, gender: Gender) -> Option<String> {
    let (last, stem) = split_last(lower)?;
    let form = match last {
        'й' | 'ь' => join(stem, gender, "евіч", "еўна"),
        'а' => join(stem, gender, "авіч", "аўна"),
        hard if is_hard(hard) => join(lower, gender, "авіч", "аўна"),
        _ => return None,
    };
    Some(form)
}

/// Split the final character from the rest of the name. The stem excludes the
/// ending character, not any earlier letters, so `-ович` keeps a hard consonant.
fn split_last(lower: &str) -> Option<(char, &str)> {
    let (index, last) = lower.char_indices().last()?;
    Some((last, &lower[..index]))
}

fn join(stem: &str, gender: Gender, male: &str, female: &str) -> String {
    let suffix = if gender == Gender::Male { male } else { female };
    format!("{stem}{suffix}")
}

/// Russian hard consonants that take `-ович`/`-овна`. Sibilants are excluded
/// because their patronymic ending is not uniform; such a name stays ambiguous.
fn is_hard(character: char) -> bool {
    matches!(
        character,
        'б' | 'в'
            | 'г'
            | 'д'
            | 'ж'
            | 'з'
            | 'к'
            | 'л'
            | 'м'
            | 'н'
            | 'п'
            | 'р'
            | 'с'
            | 'т'
            | 'ф'
            | 'х'
            | 'ц'
    )
}

fn capitalize(word: &str) -> String {
    let mut characters = word.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::person::{Name, Person};

    fn named(gender: Gender, given: &str) -> Person {
        let mut person = Person::new(vec![Name {
            given: Some(given.to_owned()),
            is_primary: true,
            ..Name::default()
        }])
        .unwrap();
        person.gender = gender;
        person
    }

    fn derive(name: &str, gender: Gender) -> String {
        derive_patronymic(name, gender).expect("expected a patronymic")
    }

    #[test]
    fn igor_gives_the_required_son_and_daughter_forms() {
        assert_eq!(derive("Игорь", Gender::Male), "Игоревич");
        assert_eq!(derive("Игорь", Gender::Female), "Игоревна");
    }

    #[test]
    fn common_vowel_and_soft_endings_are_correct() {
        assert_eq!(derive("Андрей", Gender::Male), "Андреевич");
        assert_eq!(derive("Андрей", Gender::Female), "Андреевна");
        assert_eq!(derive("Иван", Gender::Male), "Иванович");
        assert_eq!(derive("Иван", Gender::Female), "Ивановна");
        assert_eq!(derive("Никита", Gender::Male), "Никитич");
        assert_eq!(derive("Никита", Gender::Female), "Никитична");
        assert_eq!(derive("Павел", Gender::Male), "Павлович");
        assert_eq!(derive("Павел", Gender::Female), "Павловна");
        assert_eq!(derive("Пётр", Gender::Male), "Петрович");
        assert_eq!(derive("Пётр", Gender::Female), "Петровна");
    }

    #[test]
    fn ukrainian_and_belarusian_spellings_use_their_own_suffixes() {
        assert_eq!(derive("Ігор", Gender::Male), "Ігорович");
        assert_eq!(derive("Ігор", Gender::Female), "Ігорівна");
        assert_eq!(derive("Андрій", Gender::Male), "Андрійович");
        assert_eq!(derive("Андрій", Gender::Female), "Андріївна");
        assert_eq!(derive("Андрэй", Gender::Male), "Андрэевіч");
        assert_eq!(derive("Андрэй", Gender::Female), "Андрэеўна");
    }

    #[test]
    fn unknown_gender_and_latin_names_are_no_ops() {
        assert_eq!(derive_patronymic("Игорь", Gender::Unknown), None);
        assert_eq!(derive_patronymic("Igor", Gender::Male), None);
        assert_eq!(derive_patronymic("Andrew", Gender::Female), None);
        assert_eq!(derive_patronymic("", Gender::Male), None);
        assert_eq!(derive_patronymic("   ", Gender::Female), None);
    }

    #[test]
    fn ambiguous_endings_and_foreign_names_are_conservative() {
        // "-ий" can be hard or soft; only the irregular table resolves it.
        assert_eq!(
            derive_patronymic("Василий", Gender::Male),
            Some("Васильевич".to_owned())
        );
        assert_eq!(derive_patronymic("Геннадий", Gender::Male), None);
        assert_eq!(derive_patronymic("Игорь-Пётр", Gender::Male), None);
        assert_eq!(derive_patronymic("Игорь 2", Gender::Male), None);
    }

    #[test]
    fn fill_writes_only_an_empty_primary_patronymic() {
        let mut child = named(Gender::Male, "Ребёнок");
        assert!(fill_patronymic(&mut child, "Игорь"));
        assert_eq!(child.names[0].patronymic.as_deref(), Some("Игоревич"));

        assert!(!fill_patronymic(&mut child, "Иван"));
        assert_eq!(child.names[0].patronymic.as_deref(), Some("Игоревич"));

        let mut imported = named(Gender::Female, "Ребёнок");
        imported.names[0].patronymic = Some("Импортированная".to_owned());
        assert!(!fill_patronymic(&mut imported, "Игорь"));
        assert_eq!(
            imported.names[0].patronymic.as_deref(),
            Some("Импортированная")
        );

        let mut blank = named(Gender::Female, "Ребёнок");
        blank.names[0].patronymic = Some("  ".to_owned());
        assert!(fill_patronymic(&mut blank, "Игорь"));
        assert_eq!(blank.names[0].patronymic.as_deref(), Some("Игоревна"));
    }

    #[test]
    fn fill_skips_unknown_gender_and_unnamed_people() {
        let mut unknown = named(Gender::Unknown, "Ребёнок");
        assert!(!fill_patronymic(&mut unknown, "Игорь"));
        assert_eq!(unknown.names[0].patronymic, None);

        let mut unnamed = Person::new(Vec::new()).unwrap();
        unnamed.gender = Gender::Male;
        assert!(!fill_patronymic(&mut unnamed, "Игорь"));
    }

    #[test]
    fn unique_father_requires_exactly_one_male_biological_parent() {
        let child = named(Gender::Male, "Ребёнок");
        let father = named(Gender::Male, "Игорь");
        let mother = named(Gender::Female, "Мать");
        let other = named(Gender::Male, "Иван");
        let persons = vec![child.clone(), father.clone(), mother.clone(), other.clone()];
        let row = |rel_type, person_id, related_person_id| Relationship {
            id: Uuid::now_v7(),
            rel_type,
            person_id,
            related_person_id,
            notes: None,
            origin: Default::default(),
            source_event_ids: Vec::new(),
        };

        assert_eq!(
            unique_father_given_name(&persons, &[], child.id),
            None,
            "no relation is not a father"
        );
        assert_eq!(
            unique_father_given_name(
                &persons,
                &[row(RelationshipType::ParentChild, mother.id, child.id)],
                child.id
            ),
            None,
            "a mother is not a father"
        );
        assert_eq!(
            unique_father_given_name(
                &persons,
                &[
                    row(RelationshipType::ParentChild, father.id, child.id),
                    row(RelationshipType::AdoptiveParentChild, other.id, child.id),
                ],
                child.id
            ),
            Some("Игорь".to_owned()),
            "an adoptive parent is ignored"
        );
        assert_eq!(
            unique_father_given_name(
                &persons,
                &[
                    row(RelationshipType::ParentChild, father.id, child.id),
                    row(RelationshipType::ParentChild, other.id, child.id),
                ],
                child.id
            ),
            None,
            "two biological fathers are ambiguous"
        );
    }
}
