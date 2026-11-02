use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::date::DateValue;
use crate::error::{AppError, AppResult};

pub type PersonId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Gender {
    Male,
    Female,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NameType {
    #[default]
    Birth,
    Married,
    Religious,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Name {
    pub given: Option<String>,
    pub patronymic: Option<String>,
    pub surname: Option<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub name_type: NameType,
    pub is_primary: bool,
}

impl Name {
    pub fn display(&self) -> String {
        let parts = [
            self.surname.as_deref(),
            self.given.as_deref(),
            self.patronymic.as_deref(),
        ];
        parts
            .into_iter()
            .flatten()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalId {
    pub source: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: PersonId,
    pub gender: Gender,
    pub names: Vec<Name>,
    pub birth: DateValue,
    pub death: DateValue,
    pub notes: Option<String>,
    pub external_ids: Vec<ExternalId>,
}

impl Person {
    pub fn new(names: Vec<Name>) -> AppResult<Self> {
        let person = Self {
            id: Uuid::now_v7(),
            gender: Gender::Unknown,
            names,
            birth: DateValue::default(),
            death: DateValue::default(),
            notes: None,
            external_ids: Vec::new(),
        };
        person.validate()?;
        Ok(person)
    }

    pub fn display_name(&self) -> String {
        self.names
            .iter()
            .find(|name| name.is_primary)
            .or_else(|| self.names.first())
            .map(Name::display)
            .unwrap_or_default()
    }

    pub fn validate(&self) -> AppResult<()> {
        // A person may be unnamed: real exports contain unknown individuals that
        // still participate in relationships. Names are optional; if present,
        // at most one may be primary.
        if self.names.iter().filter(|name| name.is_primary).count() > 1 {
            return Err(AppError::validation("name", "multiplePrimary"));
        }
        self.birth.validate()?;
        self.death.validate()?;
        if let (Some(birth), Some(death)) = (self.birth.start, self.death.start) {
            if death < birth {
                return Err(AppError::validation("death", "beforeBirth"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::CivilDate;

    fn name(given: &str, surname: &str) -> Name {
        Name {
            given: Some(given.into()),
            surname: Some(surname.into()),
            is_primary: true,
            ..Name::default()
        }
    }

    #[test]
    fn creates_person_with_uuid_v7() {
        let person = Person::new(vec![name("Иван", "Петров")]).unwrap();
        assert_eq!(person.id.get_version_num(), 7);
        assert_eq!(person.display_name(), "Петров Иван");
    }

    #[test]
    fn death_before_birth_is_rejected() {
        let mut person = Person::new(vec![name("Иван", "Петров")]).unwrap();
        person.birth = DateValue::exact_year(1950);
        person.death = DateValue::exact_year(1940);
        let err = person.validate().unwrap_err();
        assert_eq!(err.params.get("field").map(String::as_str), Some("death"));
    }

    #[test]
    fn unnamed_person_is_allowed() {
        let person = Person::new(Vec::new()).unwrap();
        assert_eq!(person.display_name(), "");
        assert!(person.names.is_empty());
    }

    #[test]
    fn exact_day_does_not_break_person() {
        let mut person = Person::new(vec![name("Анна", "Иванова")]).unwrap();
        person.birth = DateValue::exact_day(CivilDate::new(1980, 3, 5).unwrap());
        person.validate().unwrap();
    }
}
