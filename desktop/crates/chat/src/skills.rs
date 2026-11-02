//! Embedded assistant skills and the deterministic router.
//!
//! Every skill is a separate Markdown file under `crates/chat/skills/`, with
//! YAML-like frontmatter (`name`, `description`) followed by its body. The
//! files are embedded at compile time; skills are never read from the project
//! or the user's disk at runtime. `core` is always loaded; the router selects
//! up to three thematic skills from the current user question.
//!
//! Routing is deliberately local: no extra model call, no network, and the same
//! question always selects the same skills. If the catalog cannot be parsed,
//! [`catalog`] falls back to a minimal core skill instead of failing chat.

use std::sync::OnceLock;

/// The embedded skill files, in prompt order (`core` first).
const EMBEDDED_SKILLS: &[(&str, &str)] = &[
    ("core", include_str!("../skills/core.md")),
    ("find-person", include_str!("../skills/find-person.md")),
    (
        "person-profile",
        include_str!("../skills/person-profile.md"),
    ),
    (
        "family-relations",
        include_str!("../skills/family-relations.md"),
    ),
    (
        "timeline-chronology",
        include_str!("../skills/timeline-chronology.md"),
    ),
    (
        "place-research",
        include_str!("../skills/place-research.md"),
    ),
    (
        "sources-evidence",
        include_str!("../skills/sources-evidence.md"),
    ),
    ("tree-overview", include_str!("../skills/tree-overview.md")),
    (
        "data-quality-audit",
        include_str!("../skills/data-quality-audit.md"),
    ),
    ("date-handling", include_str!("../skills/date-handling.md")),
    (
        "research-guidance",
        include_str!("../skills/research-guidance.md"),
    ),
    (
        "edit-request-handoff",
        include_str!("../skills/edit-request-handoff.md"),
    ),
    (
        "person-data-editing",
        include_str!("../skills/person-data-editing.md"),
    ),
];

/// At most this many thematic skills are added to the always-on `core` skill.
pub const MAX_THEMATIC_SKILLS: usize = 3;

/// One `SKILL.md` block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// Parsed catalog, in the document order (`core` first).
#[derive(Debug, Clone, Default)]
pub struct SkillCatalog {
    skills: Vec<Skill>,
}

impl SkillCatalog {
    /// Parses one skill file: frontmatter plus body.
    ///
    /// # Errors
    ///
    /// Returns a static reason when the file has no frontmatter, no non-empty
    /// `name` or `description`, unterminated frontmatter, or an empty body.
    pub fn parse(source: &str) -> Result<Self, String> {
        Ok(Self {
            skills: vec![parse_skill(source)?],
        })
    }

    /// Parses every embedded file and enforces the catalog invariants:
    /// unique names, filename equal to `name`, and a `core` skill.
    fn parse_all(files: &[(&str, &str)]) -> Result<Self, String> {
        let mut skills = Vec::with_capacity(files.len());
        for (file_name, source) in files {
            let skill =
                parse_skill(source).map_err(|error| format!("skill file {file_name}: {error}"))?;
            if skill.name != *file_name {
                return Err(format!(
                    "skill file {file_name} declares name {}",
                    skill.name
                ));
            }
            if skills.iter().any(|other: &Skill| other.name == skill.name) {
                return Err(format!("duplicate skill {}", skill.name));
            }
            skills.push(skill);
        }
        if !skills.iter().any(|skill| skill.name == "core") {
            return Err("the core skill is missing".to_owned());
        }
        Ok(Self { skills })
    }

    /// One skill by exact name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Skill> {
        self.skills.iter().find(|skill| skill.name == name)
    }

    /// The always-on skill.
    ///
    /// # Panics
    ///
    /// Only if a caller built a catalog without `core`; [`parse`](Self::parse)
    /// rejects that and [`fallback`](Self::fallback) always inserts it.
    #[must_use]
    pub fn core(&self) -> &Skill {
        self.get("core").expect("a catalog always has a core skill")
    }

    /// Thematic skills in document order.
    pub fn thematic(&self) -> impl Iterator<Item = &Skill> {
        self.skills.iter().filter(|skill| skill.name != "core")
    }

    /// Number of skills, including `core`.
    #[must_use]
    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// `true` when the catalog has no skills at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    fn fallback() -> Self {
        Self {
            skills: vec![Skill {
                name: "core".to_owned(),
                description: "Minimal fallback when the embedded skill document is invalid."
                    .to_owned(),
                body:
                    "Ты — помощник-генеалог. Отвечай только по данным инструментов, не выдумывай \
                       даты и факты, не изменяй дерево. Если проект не открыт или данных нет — \
                       скажи об этом."
                        .to_owned(),
            }],
        }
    }
}

/// The process-wide catalog.
#[must_use]
pub fn catalog() -> &'static SkillCatalog {
    static CATALOG: OnceLock<SkillCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        SkillCatalog::parse_all(EMBEDDED_SKILLS).unwrap_or_else(|_| SkillCatalog::fallback())
    })
}

/// Skills selected for one user question, always starting with `core`.
#[must_use]
pub fn route(message: &str) -> Vec<&'static Skill> {
    let catalog = catalog();
    let mut selected = vec![catalog.core()];
    for name in select_thematic(message) {
        if let Some(skill) = catalog.get(name) {
            selected.push(skill);
        }
    }
    selected
}

/// Names selected by [`route`], for logs and tests.
#[must_use]
pub fn route_names(message: &str) -> Vec<&'static str> {
    route(message)
        .into_iter()
        .map(|skill| skill.name.as_str())
        .collect()
}

/// One routing rule. Longer phrases in `strong` weigh more than single words in
/// `weak`, so an explicit "кем приходится" beats an incidental "брат".
struct Rule {
    skill: &'static str,
    strong: &'static [&'static str],
    weak: &'static [&'static str],
}

const RULES: &[Rule] = &[
    Rule {
        skill: "find-person",
        strong: &[
            "найди",
            "найти",
            "поищи",
            "разыщи",
            "кто такой",
            "кто такая",
            "who is",
            "who was",
            "find",
            "search for",
        ],
        weak: &["поиск", "искать", "человек по имени", "look up"],
    },
    Rule {
        skill: "person-profile",
        strong: &[
            "расскажи",
            "что известно",
            "биография",
            "профиль",
            "подробнее о",
            "всё о",
            "все о",
            "tell me about",
            "what is known",
            "biography",
            "profile",
            "all about",
        ],
        weak: &["информация о", "о ком", "information about"],
    },
    Rule {
        skill: "family-relations",
        strong: &[
            "кем приходится",
            "кем мне",
            "степень родства",
            "родственные связи",
            "общий предок",
            "related to",
            "relationship",
            "common ancestor",
            "how is",
        ],
        weak: &[
            "родств",
            "брат",
            "сестр",
            "родител",
            "отец",
            "отц",
            "мать",
            "матер",
            "дети",
            "ребен",
            "ребён",
            "дочь",
            "дочер",
            "сын",
            "сынов",
            "муж",
            "жен",
            "супруг",
            "бабуш",
            "дедуш",
            "внук",
            "внуч",
            "предк",
            "потомк",
            "дяд",
            "тет",
            "тёт",
            "племян",
            "девер",
            "золов",
            "шурин",
            "свояк",
            "тесть",
            "тестя",
            "тёщ",
            "свекор",
            "свёкор",
            "свекр",
            "свекров",
            "brother",
            "sister",
            "parent",
            "father",
            "mother",
            "children",
            "son",
            "daughter",
            "husband",
            "wife",
            "spouse",
            "grandmother",
            "grandfather",
            "ancestor",
            "descendant",
            "uncle",
            "aunt",
            "nephew",
            "niece",
            "cousin",
        ],
    },
    Rule {
        skill: "timeline-chronology",
        strong: &[
            "хронологи",
            "что происходило",
            "что было",
            "сколько лет",
            "в каком году",
            "возраст",
            "timeline",
            "chronology",
            "what happened",
            "how old",
        ],
        weak: &[
            "когда",
            "год",
            "период",
            "десятилет",
            "1941",
            "1945",
            "when",
            "year",
            "period",
            "age",
        ],
    },
    Rule {
        skill: "place-research",
        strong: &[
            "где жил",
            "где родил",
            "где умер",
            "место жительства",
            "переезд",
            "миграц",
            "where did",
            "where was",
            "place of residence",
            "migration",
            "moved",
        ],
        weak: &[
            "город",
            "деревн",
            "сел",
            "жил в",
            "родился в",
            "умер в",
            "место",
            "city",
            "village",
            "lived in",
            "born in",
            "died in",
            "place",
        ],
    },
    Rule {
        skill: "sources-evidence",
        strong: &[
            "источник",
            "подтвержд",
            "цитат",
            "откуда известно",
            "какие документы",
            "source",
            "evidence",
            "citation",
            "confirmed",
            "where does it come from",
        ],
        weak: &[
            "документ",
            "архив",
            "метрическ",
            "запись",
            "свидетельств",
            "document",
            "archive",
            "record",
            "certificate",
        ],
    },
    Rule {
        skill: "tree-overview",
        strong: &[
            "сколько людей",
            "сколько персон",
            "обзор дерева",
            "статистик",
            "что в дереве",
            "с чего начать",
            "размер дерева",
            "how many people",
            "how many persons",
            "tree overview",
            "statistics",
            "what is in the tree",
            "where to start",
            "tree size",
        ],
        weak: &["корнев", "полнота", "roots", "completeness"],
    },
    Rule {
        skill: "data-quality-audit",
        strong: &[
            "ошибк",
            "противореч",
            "дубл",
            "качество данных",
            "нереалистич",
            "невозможн",
            "error",
            "mistake",
            "duplicate",
            "contradiction",
            "data quality",
            "unrealistic",
            "impossible",
        ],
        weak: &[
            "проверь",
            "проверить",
            "аномал",
            "логично",
            "check",
            "inconsistent",
            "anomaly",
        ],
    },
    Rule {
        skill: "date-handling",
        strong: &[
            "точность даты",
            "precision",
            "старый стиль",
            "новый стиль",
            "календар",
            "qualifier",
            "date precision",
            "old style",
            "new style",
            "calendar",
        ],
        weak: &[
            "дат",
            "точн",
            "около",
            "приблизительно",
            "неизвестн",
            "date",
            "circa",
            "approximately",
            "unknown",
        ],
    },
    Rule {
        skill: "research-guidance",
        strong: &[
            "где искать",
            "как найти",
            "что дальше",
            "куда копать",
            "поиск предков",
            "с чего продолжить",
            "where to search",
            "how to find",
            "what next",
            "next step",
            "research ancestors",
            "where to continue",
        ],
        weak: &[
            "архив",
            "метрическ",
            "ревизск",
            "исповедн",
            "документ",
            "archive",
            "metric book",
            "revision",
            "confession",
            "document",
        ],
    },
    Rule {
        skill: "edit-request-handoff",
        strong: &[
            "добав",
            "исправ",
            "измен",
            "удал",
            "создай персон",
            "создай событ",
            "создай связь",
            "созда",
            "запиши",
            "внес",
            "постав",
            "add",
            "fix",
            "change",
            "delete",
            "remove",
            "create person",
            "create event",
            "create relationship",
            "update",
            "set",
        ],
        weak: &["обнови", "заполни", "создай", "edit", "fill"],
    },
    Rule {
        skill: "person-data-editing",
        strong: &[
            "исправь имя",
            "исправь фамилию",
            "исправь отчество",
            "исправь дату",
            "исправь заметк",
            "исправь пол",
            "измени имя",
            "измени фамилию",
            "измени отчество",
            "измени дату",
            "измени заметк",
            "поменяй имя",
            "поменяй фамилию",
            "поменяй дату",
            "поставь дату",
            "переименуй",
            "опечатк",
            "fix the name",
            "fix the surname",
            "fix the date",
            "fix the note",
            "correct the name",
            "correct the surname",
            "rename",
            "typo",
            "misspell",
            "change the name",
            "change the surname",
            "change the gender",
            "update the note",
            "edit the note",
        ],
        weak: &["заметк", "опечат", "typo"],
    },
];

fn select_thematic(message: &str) -> Vec<&'static str> {
    let lower = message.to_lowercase();
    let mut scored: Vec<(&'static str, u32)> = RULES
        .iter()
        .filter_map(|rule| {
            let score = rule
                .strong
                .iter()
                .filter(|term| contains_term(&lower, term))
                .count() as u32
                * 3
                + rule
                    .weak
                    .iter()
                    .filter(|term| contains_term(&lower, term))
                    .count() as u32;
            (score > 0).then_some((rule.skill, score))
        })
        .collect();
    // Stable: equal scores keep the document order of RULES.
    scored.sort_by_key(|left| std::cmp::Reverse(left.1));

    let mut selected: Vec<&'static str> = Vec::with_capacity(MAX_THEMATIC_SKILLS);
    for (name, _) in scored {
        if selected.len() == MAX_THEMATIC_SKILLS {
            break;
        }
        push_unique(&mut selected, name);
    }

    // A profile or an edit request needs identity resolution. Reserve a slot
    // for the search skill, replacing the weakest selected skill if necessary.
    let needs_search = selected.iter().any(|name| {
        *name == "person-profile"
            || *name == "edit-request-handoff"
            || *name == "person-data-editing"
    });
    if needs_search && !selected.contains(&"find-person") {
        if selected.len() < MAX_THEMATIC_SKILLS {
            selected.push("find-person");
        } else if let Some(last) = selected.last_mut() {
            *last = "find-person";
        }
    }

    selected
}

/// Cyrillic terms are stems and match inside a word; ASCII terms need word
/// boundaries so `date` does not match `update` and `son` does not match
/// `person`.
fn contains_term(haystack: &str, term: &str) -> bool {
    if !term.is_ascii() {
        return haystack.contains(term);
    }
    haystack.match_indices(term).any(|(start, _)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + term.len()..].chars().next();
        before.is_none_or(|character| !character.is_alphanumeric())
            && after.is_none_or(|character| !character.is_alphanumeric())
    })
}

fn push_unique(selected: &mut Vec<&'static str>, name: &'static str) {
    if !selected.contains(&name) {
        selected.push(name);
    }
}

fn parse_skill(source: &str) -> Result<Skill, String> {
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0;
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    if lines.get(index).map(|line| line.trim()) != Some("---") {
        return Err("skill has no frontmatter".to_owned());
    }
    index += 1;

    let mut name = None;
    let mut description = None;
    while index < lines.len() && lines[index].trim() != "---" {
        let line = lines[index].trim();
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().to_owned());
        }
        index += 1;
    }
    if lines.get(index).map(|line| line.trim()) != Some("---") {
        return Err("skill has unterminated frontmatter".to_owned());
    }
    index += 1;

    let name = name
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "skill has no name".to_owned())?;
    let description = description
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "skill has no description".to_owned())?;
    let body = lines[index..].join("\n").trim().to_owned();
    if body.is_empty() {
        return Err("skill has an empty body".to_owned());
    }
    Ok(Skill {
        name,
        description,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_has_core_and_twelve_thematic_skills() {
        let catalog = catalog();
        assert_eq!(catalog.len(), 13);
        assert_eq!(catalog.core().name, "core");
        let names: Vec<&str> = catalog
            .thematic()
            .map(|skill| skill.name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "find-person",
                "person-profile",
                "family-relations",
                "timeline-chronology",
                "place-research",
                "sources-evidence",
                "tree-overview",
                "data-quality-audit",
                "date-handling",
                "research-guidance",
                "edit-request-handoff",
                "person-data-editing",
            ]
        );
    }

    #[test]
    fn parsing_requires_frontmatter_name_description_and_body() {
        let valid = "---\nname: core\ndescription: base\n---\nbody\n";
        assert_eq!(SkillCatalog::parse(valid).expect("valid skill").len(), 1);
        for source in [
            "body only\n",
            "---\nname: core\n---\nbody\n",
            "---\nname:\ndescription: base\n---\nbody\n",
            "---\nname: core\ndescription:\n---\nbody\n",
            "---\nname: core\ndescription: base\n",
            "---\nname: core\ndescription: base\n---\n",
        ] {
            assert!(SkillCatalog::parse(source).is_err(), "{source:?}");
        }
    }

    #[test]
    fn every_embedded_file_parses_and_matches_its_filename() {
        let catalog = catalog();
        assert_eq!(catalog.len(), EMBEDDED_SKILLS.len());
        let mut names = std::collections::HashSet::new();
        for (file_name, source) in EMBEDDED_SKILLS {
            let skill = parse_skill(source).expect("embedded skill parses");
            assert_eq!(skill.name.as_str(), *file_name);
            assert!(!skill.name.is_empty());
            assert!(!skill.description.is_empty());
            assert!(!skill.body.is_empty());
            assert!(names.insert(skill.name.clone()), "duplicate {file_name}");
        }

        let mut files: Vec<String> =
            std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("skills"))
                .expect("skills directory")
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.ends_with(".md") && name != "README.md")
                .map(|name| name.trim_end_matches(".md").to_owned())
                .collect();
        files.sort();
        let mut embedded: Vec<String> = EMBEDDED_SKILLS
            .iter()
            .map(|(name, _)| (*name).to_owned())
            .collect();
        embedded.sort();
        assert_eq!(files, embedded);
    }

    #[test]
    fn every_rule_references_a_skill_and_every_thematic_skill_is_reachable() {
        let catalog = catalog();
        let mut reachable = std::collections::HashSet::new();
        for rule in RULES {
            assert_ne!(rule.skill, "core");
            assert!(catalog.get(rule.skill).is_some(), "{}", rule.skill);
            reachable.insert(rule.skill);
        }
        for skill in catalog.thematic() {
            assert!(reachable.contains(skill.name.as_str()), "{}", skill.name);
        }
    }

    #[test]
    fn core_is_first_and_selection_order_is_deterministic() {
        let question = "Расскажи о деде и кем он мне приходится";
        let first = route_names(question);
        let second = route_names(question);
        assert_eq!(first, second);
        assert_eq!(first.first(), Some(&"core"));
    }

    #[test]
    fn root_skill_catalog_file_is_gone() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("genealogy-assistant-skills.md");
        assert!(!root.exists(), "{} still exists", root.display());
    }

    #[test]
    fn core_is_always_first_and_the_limit_is_three_thematic_skills() {
        let selected =
            route("найди бабушку Марию, расскажи про неё, кем она мне приходится, что было в 1941");
        assert_eq!(selected[0].name, "core");
        assert!(selected.len() <= 1 + MAX_THEMATIC_SKILLS);
        assert!(selected.iter().skip(1).all(|skill| skill.name != "core"));
    }

    #[test]
    fn routes_the_documented_examples() {
        let cases = [
            ("Найди мою прабабушку Марию, она из Саратова", "find-person"),
            ("Расскажи всё о Петре Сидорове", "person-profile"),
            (
                "Кем мне приходится жена брата моего мужа?",
                "family-relations",
            ),
            (
                "Что происходило в семье Ивановых в 1941–1945?",
                "timeline-chronology",
            ),
            ("Чем подтверждена дата рождения деда?", "sources-evidence"),
            ("Есть ли в дереве ошибки?", "data-quality-audit"),
            ("Добавь бабушке дату смерти 1980", "edit-request-handoff"),
        ];
        for (question, expected) in cases {
            let names = route_names(question);
            assert!(
                names.contains(&expected),
                "{question:?} did not select {expected}: {names:?}"
            );
        }
    }

    #[test]
    fn profile_and_edit_requests_get_the_search_support_skill() {
        for question in ["Расскажи о деде", "Добавь бабушке дату смерти"]
        {
            let names = route_names(question);
            assert!(names.contains(&"find-person"), "{question:?}: {names:?}");
        }
    }

    #[test]
    fn inflected_russian_family_terms_route() {
        for question in [
            "привет сколько бабушек у Маракова Владислава",
            "сколько дедушек в дереве",
            "кто отец и мать Анны",
            "есть ли у него братья и сёстры",
        ] {
            let names = route_names(question);
            assert!(
                names.contains(&"family-relations"),
                "{question:?}: {names:?}"
            );
        }
    }

    #[test]
    fn english_questions_route_to_the_same_skills() {
        let cases = [
            ("Who is Ivan Petrov?", "find-person"),
            ("Tell me about Peter", "person-profile"),
            ("Where did Anna live?", "place-research"),
            ("Add a death date", "edit-request-handoff"),
        ];
        for (question, expected) in cases {
            let names = route_names(question);
            assert!(
                names.contains(&expected),
                "{question:?} did not select {expected}: {names:?}"
            );
        }
        let names = route_names("update the note");
        assert!(names.contains(&"edit-request-handoff"), "{names:?}");
        assert!(
            !names.contains(&"date-handling"),
            "`date` must not match inside `update`: {names:?}"
        );
    }

    #[test]
    fn empty_question_loads_only_core() {
        assert_eq!(route_names(""), vec!["core"]);
    }

    #[test]
    fn person_editing_requests_route_to_person_data_editing() {
        let cases = [
            ("Исправь опечатку в фамилии Петрова", "person-data-editing"),
            ("Исправь имя Иван на Ивана", "person-data-editing"),
            ("Поменяй дату рождения на 1950", "person-data-editing"),
            ("Поставь дату смерти 1980", "person-data-editing"),
            ("Fix the surname Petrov", "person-data-editing"),
            ("Correct the name", "person-data-editing"),
            ("Update the note", "person-data-editing"),
            ("Change the gender", "person-data-editing"),
        ];
        for (question, expected) in cases {
            let names = route_names(question);
            assert!(
                names.contains(&expected),
                "{question:?} did not select {expected}: {names:?}"
            );
        }
    }

    #[test]
    fn add_and_remove_requests_stay_in_edit_request_handoff() {
        for question in [
            "Добавь бабушке дату смерти 1980",
            "Удали персону",
            "Создай событие",
        ] {
            let names = route_names(question);
            assert!(
                names.contains(&"edit-request-handoff"),
                "{question:?}: {names:?}"
            );
        }
        // "Добавь бабушке дату смерти" must not select person-data-editing:
        // the verb belongs to edit-request-handoff.
        assert!(!route_names("Добавь бабушке дату смерти 1980").contains(&"person-data-editing"));
        assert!(!route_names("Удали персону").contains(&"person-data-editing"));
    }

    #[test]
    fn read_only_date_questions_do_not_select_person_editing() {
        let names = route_names("Найди дату смерти деда");
        assert!(names.contains(&"find-person"), "{names:?}");
        assert!(
            !names.contains(&"person-data-editing"),
            "a read-only date question must not select editing: {names:?}"
        );
    }
}
