use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Civil (timezone-free) date. See ADR-0010. Serialized as an ISO `YYYY-MM-DD`
/// string, not as an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CivilDate {
    pub year: i32,
    pub month: u8,
    pub day: u8,
}

impl Serialize for CivilDate {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_iso())
    }
}

impl<'de> Deserialize<'de> for CivilDate {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DatePrecision {
    Day,
    Month,
    Year,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DateQualifier {
    Exact,
    Approximate,
    Before,
    After,
    Range,
    Unknown,
}

/// `start` inclusive, `end` exclusive. See ADR-0010.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateValue {
    pub start: Option<CivilDate>,
    pub end: Option<CivilDate>,
    pub precision: DatePrecision,
    pub qualifier: DateQualifier,
    pub original: Option<String>,
}

impl Default for DateValue {
    fn default() -> Self {
        Self::unknown(None)
    }
}

impl CivilDate {
    pub fn new(year: i32, month: u8, day: u8) -> AppResult<Self> {
        let value = Self { year, month, day };
        value.validate()?;
        Ok(value)
    }

    pub fn parse(value: &str) -> AppResult<Self> {
        let mut parts = value.split('-');
        let (y, m, d) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(y), Some(m), Some(d), None) => (y, m, d),
            _ => {
                return Err(AppError::validation("date", "format").with_param("value", value));
            }
        };
        let year: i32 = y
            .parse()
            .map_err(|_| AppError::validation("date", "year"))?;
        let month: u8 = m
            .parse()
            .map_err(|_| AppError::validation("date", "month"))?;
        let day: u8 = d.parse().map_err(|_| AppError::validation("date", "day"))?;
        Self::new(year, month, day)
    }

    pub fn to_iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    pub fn validate(self) -> AppResult<()> {
        if !(1..=12).contains(&self.month) {
            return Err(AppError::validation("date", "month"));
        }
        let max = days_in_month(self.year, self.month);
        if self.day == 0 || self.day > max {
            return Err(AppError::validation("date", "day"));
        }
        Ok(())
    }

    pub fn next_day(self) -> Self {
        let mut out = self;
        if out.day < days_in_month(out.year, out.month) {
            out.day += 1;
            return out;
        }
        out.day = 1;
        if out.month < 12 {
            out.month += 1;
        } else {
            out.month = 1;
            out.year += 1;
        }
        out
    }

    pub fn first_of_month(self) -> Self {
        Self {
            year: self.year,
            month: self.month,
            day: 1,
        }
    }

    pub fn next_month(self) -> Self {
        if self.month < 12 {
            Self {
                year: self.year,
                month: self.month + 1,
                day: 1,
            }
        } else {
            Self {
                year: self.year + 1,
                month: 1,
                day: 1,
            }
        }
    }

    pub fn first_of_year(self) -> Self {
        Self {
            year: self.year,
            month: 1,
            day: 1,
        }
    }

    pub fn next_year(self) -> Self {
        Self {
            year: self.year + 1,
            month: 1,
            day: 1,
        }
    }
}

pub fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

pub fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

impl DateValue {
    pub fn unknown(original: Option<String>) -> Self {
        Self {
            start: None,
            end: None,
            precision: DatePrecision::Unknown,
            qualifier: DateQualifier::Unknown,
            original,
        }
    }

    pub fn exact_day(date: CivilDate) -> Self {
        Self {
            start: Some(date),
            end: Some(date.next_day()),
            precision: DatePrecision::Day,
            qualifier: DateQualifier::Exact,
            original: None,
        }
    }

    pub fn exact_month(date: CivilDate) -> Self {
        Self {
            start: Some(date.first_of_month()),
            end: Some(date.first_of_month().next_month()),
            precision: DatePrecision::Month,
            qualifier: DateQualifier::Exact,
            original: None,
        }
    }

    pub fn exact_year(year: i32) -> Self {
        let start = CivilDate {
            year,
            month: 1,
            day: 1,
        };
        Self {
            start: Some(start),
            end: Some(start.next_year()),
            precision: DatePrecision::Year,
            qualifier: DateQualifier::Exact,
            original: None,
        }
    }

    pub fn before(date: CivilDate) -> Self {
        Self {
            start: None,
            end: Some(date),
            precision: DatePrecision::Day,
            qualifier: DateQualifier::Before,
            original: None,
        }
    }

    pub fn after(date: CivilDate) -> Self {
        Self {
            start: Some(date),
            end: None,
            precision: DatePrecision::Day,
            qualifier: DateQualifier::After,
            original: None,
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        use DateQualifier as Q;
        match self.precision {
            DatePrecision::Unknown => {
                if self.start.is_some() || self.end.is_some() {
                    return Err(AppError::validation("date", "unknownHasBounds"));
                }
                return Ok(());
            }
            _ => {
                if self.start.is_none() && self.end.is_none() {
                    return Err(AppError::validation("date", "missingBounds"));
                }
            }
        }

        match self.qualifier {
            Q::Before if self.start.is_some() || self.end.is_none() => {
                return Err(AppError::validation("date", "beforeBounds"));
            }
            Q::After if self.end.is_some() || self.start.is_none() => {
                return Err(AppError::validation("date", "afterBounds"));
            }
            Q::Exact | Q::Approximate | Q::Range if self.start.is_none() || self.end.is_none() => {
                return Err(AppError::validation("date", "missingBounds"));
            }
            _ => {}
        }

        if let (Some(start), Some(end)) = (self.start, self.end) {
            start.validate()?;
            end.validate()?;
            if start >= end {
                return Err(AppError::validation("date", "startNotBeforeEnd"));
            }
        }
        self.check_precision_alignment()?;
        Ok(())
    }

    /// ADR-0010 rule 7: bounds must match the declared precision. `RANGE`
    /// carries explicit user bounds, so it is exempt.
    fn check_precision_alignment(&self) -> AppResult<()> {
        if self.qualifier == DateQualifier::Range {
            return Ok(());
        }
        let aligned = |date: CivilDate| match self.precision {
            DatePrecision::Day | DatePrecision::Unknown => true,
            DatePrecision::Month => date.day == 1,
            DatePrecision::Year => date.month == 1 && date.day == 1,
        };
        for bound in [self.start, self.end].into_iter().flatten() {
            if !aligned(bound) {
                return Err(AppError::validation("date", "precisionBounds"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::codes;

    #[test]
    fn exact_day_is_half_open() {
        let date = CivilDate::new(1950, 5, 1).unwrap();
        let value = DateValue::exact_day(date);
        value.validate().unwrap();
        assert_eq!(value.end.unwrap(), CivilDate::new(1950, 5, 2).unwrap());
    }

    #[test]
    fn month_and_year_bounds() {
        let month = DateValue::exact_month(CivilDate::new(1950, 12, 31).unwrap());
        assert_eq!(month.start.unwrap().to_iso(), "1950-12-01");
        assert_eq!(month.end.unwrap().to_iso(), "1951-01-01");
        let year = DateValue::exact_year(1950);
        assert_eq!(year.start.unwrap().to_iso(), "1950-01-01");
        assert_eq!(year.end.unwrap().to_iso(), "1951-01-01");
    }

    #[test]
    fn unknown_has_no_bounds() {
        let value = DateValue::unknown(Some("весна, примерно".into()));
        value.validate().unwrap();
        assert!(value.start.is_none() && value.end.is_none());
    }

    #[test]
    fn unknown_with_bounds_is_rejected() {
        let mut value = DateValue::unknown(None);
        value.start = Some(CivilDate::new(1950, 1, 1).unwrap());
        let err = value.validate().unwrap_err();
        assert_eq!(err.code, codes::VALIDATION_ERROR);
    }

    #[test]
    fn before_and_after() {
        let date = CivilDate::new(1900, 1, 1).unwrap();
        DateValue::before(date).validate().unwrap();
        DateValue::after(date).validate().unwrap();
        let mut bad = DateValue::before(date);
        bad.start = Some(date);
        assert!(bad.validate().is_err());
    }

    #[test]
    fn leap_years() {
        assert_eq!(days_in_month(2000, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
        assert!(CivilDate::new(2023, 2, 29).is_err());
    }

    #[test]
    fn civil_date_serializes_as_iso_string() {
        let date = CivilDate::new(1950, 5, 1).unwrap();
        assert_eq!(serde_json::to_string(&date).unwrap(), "\"1950-05-01\"");
        let back: CivilDate = serde_json::from_str("\"1950-05-01\"").unwrap();
        assert_eq!(back, date);
        assert!(serde_json::from_str::<CivilDate>("\"1950-13-01\"").is_err());
    }

    #[test]
    fn bounds_must_match_precision() {
        let mut year = DateValue::exact_year(1950);
        year.start = Some(CivilDate::new(1950, 5, 1).unwrap());
        assert_eq!(
            year.validate()
                .unwrap_err()
                .params
                .get("rule")
                .map(String::as_str),
            Some("precisionBounds")
        );

        let mut month = DateValue::exact_month(CivilDate::new(1950, 5, 1).unwrap());
        month.end = Some(CivilDate::new(1950, 6, 2).unwrap());
        assert!(month.validate().is_err());
    }
}
