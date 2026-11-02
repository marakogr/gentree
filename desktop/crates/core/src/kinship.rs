use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::path::PathResult;
use crate::person::Gender;
use crate::relationship::{RelationshipSet, RelationshipType};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KinshipKind {
    Father,
    Mother,
    Son,
    Daughter,
    Husband,
    Wife,
    Partner,
    Brother,
    Sister,
    Grandfather,
    Grandmother,
    Grandson,
    Granddaughter,
    Uncle,
    Aunt,
    Nephew,
    Niece,
    Cousin,
    GreatGrandparent,
    GreatGrandchild,
    ParentInLaw,
    ChildInLaw,
    SiblingInLaw,
    SiblingOfSpouse,
    SpouseOfSibling,
    SpouseOfSpousesSibling,
    GreatUncle,
    GreatAunt,
    GrandNephew,
    GrandNiece,
    StepParent,
    StepChild,
    StepSibling,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KinshipLine {
    Paternal,
    Maternal,
    Mixed,
}

/// One resolved edge of a kinship chain; mirrors the UI `KinshipEdge`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KinshipEdgeKind {
    Parent,
    Child,
    Spouse,
    Partner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KinshipEdge {
    pub from: Uuid,
    pub to: Uuid,
    pub kind: KinshipEdgeKind,
    pub from_gender: Gender,
    pub to_gender: Gender,
    pub adoptive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KinshipDescriptor {
    pub kind: KinshipKind,
    /// Gender of the target person; UI picks a neutral form when UNKNOWN.
    pub gender: Gender,
    /// Gender of the person the relation is described from (ego).
    #[serde(default)]
    pub source_gender: Gender,
    pub line: Option<KinshipLine>,
    pub degree: u32,
    pub removed: u32,
    pub generation_delta: i32,
    pub via_spouse_gender: Option<Gender>,
    pub path: Vec<Uuid>,
    /// Resolved edges of `path`, same order; `edges.len() == path.len() - 1`.
    #[serde(default)]
    pub edges: Vec<KinshipEdge>,
    #[serde(default)]
    pub common_ancestor_id: Option<Uuid>,
}

impl KinshipDescriptor {
    fn new(kind: KinshipKind, gender: Gender, source_gender: Gender) -> Self {
        Self {
            kind,
            gender,
            source_gender,
            line: None,
            degree: 0,
            removed: 0,
            generation_delta: 0,
            via_spouse_gender: None,
            path: Vec::new(),
            edges: Vec::new(),
            common_ancestor_id: None,
        }
    }
}

/// Direction of one chain step; spouses and partners are one step kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Up,
    Down,
    Spouse,
}

/// Counts for a spouse-free chain. `None` when up/down steps interleave in a
/// non-monotone way (down followed by up), where no single term applies.
struct Shape {
    ups: usize,
    downs: usize,
}

fn shape(steps: &[Step]) -> Option<Shape> {
    let mut ups = 0;
    let mut downs = 0;
    let mut seen_down = false;
    for step in steps {
        match step {
            Step::Up if !seen_down => ups += 1,
            Step::Up => return None,
            Step::Down => {
                seen_down = true;
                downs += 1;
            }
            Step::Spouse => return None,
        }
    }
    Some(Shape { ups, downs })
}

fn step_of(kind: KinshipEdgeKind) -> Step {
    match kind {
        KinshipEdgeKind::Parent => Step::Up,
        KinshipEdgeKind::Child => Step::Down,
        KinshipEdgeKind::Spouse | KinshipEdgeKind::Partner => Step::Spouse,
    }
}

#[derive(Debug, Clone, Copy)]
struct Classification {
    kind: KinshipKind,
    line: Option<KinshipLine>,
    degree: u32,
    removed: u32,
    generation_delta: i32,
    via_spouse_gender: Option<Gender>,
}

impl Classification {
    fn new(kind: KinshipKind) -> Self {
        Self {
            kind,
            line: None,
            degree: 0,
            removed: 0,
            generation_delta: 0,
            via_spouse_gender: None,
        }
    }

    fn unknown() -> Self {
        Self::new(KinshipKind::Unknown)
    }
}

fn male_or_female(gender: Gender, male: KinshipKind, female: KinshipKind) -> KinshipKind {
    match gender {
        Gender::Female => female,
        _ => male,
    }
}

fn parent_line(gender: Gender) -> Option<KinshipLine> {
    match gender {
        Gender::Male => Some(KinshipLine::Paternal),
        Gender::Female => Some(KinshipLine::Maternal),
        Gender::Unknown => None,
    }
}

impl RelationshipSet {
    /// Structural descriptor; no localized strings. See ADR-0011.
    ///
    /// The term is derived from the shortest path between the two people, so
    /// the chain (`path` + `edges`) and the term always agree.
    pub fn kinship(
        &self,
        from: Uuid,
        to: Uuid,
        gender_of: &dyn Fn(Uuid) -> Gender,
    ) -> KinshipDescriptor {
        let path = self.find_primary_path(from, to);
        self.kinship_from_path(from, to, &path, gender_of)
    }

    /// Same as [`Self::kinship`] for a path that was already computed, so the
    /// command layer does not search the graph twice.
    pub fn kinship_from_path(
        &self,
        from: Uuid,
        to: Uuid,
        path: &PathResult,
        gender_of: &dyn Fn(Uuid) -> Gender,
    ) -> KinshipDescriptor {
        let source_gender = gender_of(from);
        let target_gender = gender_of(to);
        let person_path: Vec<Uuid> = path.path.iter().map(|step| step.person_id).collect();
        let edges: Vec<KinshipEdge> = if path.found {
            person_path
                .windows(2)
                .filter_map(|pair| self.resolve_edge(pair[0], pair[1], gender_of))
                .collect()
        } else {
            Vec::new()
        };

        let mut descriptor =
            KinshipDescriptor::new(KinshipKind::Unknown, target_gender, source_gender);
        descriptor.path = person_path.clone();
        descriptor.edges = edges.clone();
        descriptor.common_ancestor_id = path.common_ancestor_id;

        if from == to || !path.found {
            return descriptor;
        }
        // A chain with an unresolvable edge cannot be trusted for a term.
        if edges.len() + 1 != person_path.len() {
            return descriptor;
        }

        let classification = self.classify(&person_path, &edges, gender_of);
        descriptor.kind = classification.kind;
        descriptor.line = classification.line;
        descriptor.degree = classification.degree;
        descriptor.removed = classification.removed;
        descriptor.generation_delta = classification.generation_delta;
        descriptor.via_spouse_gender = classification.via_spouse_gender;
        descriptor
    }

    /// Resolve the stored relationship(s) behind one path step.
    fn resolve_edge(
        &self,
        from: Uuid,
        to: Uuid,
        gender_of: &dyn Fn(Uuid) -> Gender,
    ) -> Option<KinshipEdge> {
        let (kind, adoptive) = if let Some((_, adoptive)) = self
            .parents_of(from)
            .into_iter()
            .find(|(parent, _)| *parent == to)
        {
            (KinshipEdgeKind::Parent, adoptive)
        } else if self.children_of(from).contains(&to) {
            let adoptive = self
                .parents_of(to)
                .into_iter()
                .any(|(parent, adoptive)| parent == from && adoptive);
            (KinshipEdgeKind::Child, adoptive)
        } else {
            let row = self.rows().iter().find(|row| {
                row.rel_type.is_spouse()
                    && ((row.person_id == from && row.related_person_id == to)
                        || (row.person_id == to && row.related_person_id == from))
            })?;
            let kind = if row.rel_type == RelationshipType::Partner {
                KinshipEdgeKind::Partner
            } else {
                KinshipEdgeKind::Spouse
            };
            (kind, false)
        };
        Some(KinshipEdge {
            from,
            to,
            kind,
            from_gender: gender_of(from),
            to_gender: gender_of(to),
            adoptive,
        })
    }

    fn classify(
        &self,
        person_path: &[Uuid],
        edges: &[KinshipEdge],
        gender_of: &dyn Fn(Uuid) -> Gender,
    ) -> Classification {
        let target_gender = gender_of(*person_path.last().expect("path has a target"));
        let steps: Vec<Step> = edges.iter().map(|edge| step_of(edge.kind)).collect();
        let spouse_steps = steps.iter().filter(|step| **step == Step::Spouse).count();

        match spouse_steps {
            0 => self.classify_blood(person_path, edges, &steps, target_gender, gender_of),
            1 => self.classify_one_spouse(person_path, &steps, target_gender, gender_of),
            _ => classify_two_spouses(person_path, &steps, gender_of),
        }
    }

    /// No spouse step: ancestors, descendants, siblings, uncles, cousins.
    fn classify_blood(
        &self,
        person_path: &[Uuid],
        edges: &[KinshipEdge],
        steps: &[Step],
        target_gender: Gender,
        gender_of: &dyn Fn(Uuid) -> Gender,
    ) -> Classification {
        let Some(shape) = shape(steps) else {
            return Classification::unknown();
        };
        let line = match steps.first() {
            Some(Step::Up) => parent_line(edges[0].to_gender),
            _ => None,
        };

        if shape.downs == 0 {
            let kind = match shape.ups {
                1 => male_or_female(target_gender, KinshipKind::Father, KinshipKind::Mother),
                2 => male_or_female(
                    target_gender,
                    KinshipKind::Grandfather,
                    KinshipKind::Grandmother,
                ),
                _ => KinshipKind::GreatGrandparent,
            };
            let mut classification = Classification::new(kind);
            classification.generation_delta = shape.ups as i32;
            classification.line = line;
            return classification;
        }

        if shape.ups == 0 {
            let kind = match shape.downs {
                1 => male_or_female(target_gender, KinshipKind::Son, KinshipKind::Daughter),
                2 => male_or_female(
                    target_gender,
                    KinshipKind::Grandson,
                    KinshipKind::Granddaughter,
                ),
                _ => KinshipKind::GreatGrandchild,
            };
            let mut classification = Classification::new(kind);
            classification.generation_delta = -(shape.downs as i32);
            return classification;
        }

        let kind = match (shape.ups, shape.downs) {
            (1, 1) => male_or_female(target_gender, KinshipKind::Brother, KinshipKind::Sister),
            (1, 2) => male_or_female(target_gender, KinshipKind::Nephew, KinshipKind::Niece),
            (1, _) => male_or_female(
                target_gender,
                KinshipKind::GrandNephew,
                KinshipKind::GrandNiece,
            ),
            (2, 1) => male_or_female(target_gender, KinshipKind::Uncle, KinshipKind::Aunt),
            (_, 1) => male_or_female(
                target_gender,
                KinshipKind::GreatUncle,
                KinshipKind::GreatAunt,
            ),
            _ => KinshipKind::Cousin,
        };

        let mut classification = Classification::new(kind);
        // Cousins keep the legacy sign convention: a negative delta means the
        // target is one generation older, which is what the UI reads. Direct
        // ancestors/descendants use the opposite (positive = older) convention.
        classification.generation_delta = if kind == KinshipKind::Cousin {
            shape.downs as i32 - shape.ups as i32
        } else {
            shape.ups as i32 - shape.downs as i32
        };
        match kind {
            KinshipKind::Uncle
            | KinshipKind::Aunt
            | KinshipKind::GreatUncle
            | KinshipKind::GreatAunt => classification.line = line,
            KinshipKind::Cousin => {
                classification.degree = shape.ups.min(shape.downs).saturating_sub(1) as u32;
                classification.removed = shape.ups.abs_diff(shape.downs) as u32;
                classification.line = cousin_line(person_path, gender_of);
            }
            _ => {}
        }
        classification
    }

    /// Exactly one spouse step: in-law and step relations.
    fn classify_one_spouse(
        &self,
        person_path: &[Uuid],
        steps: &[Step],
        target_gender: Gender,
        gender_of: &dyn Fn(Uuid) -> Gender,
    ) -> Classification {
        let index = steps
            .iter()
            .position(|step| *step == Step::Spouse)
            .expect("exactly one spouse step");
        let prefix = &steps[..index];
        let suffix = &steps[index + 1..];
        // The spouse the term is named after: the person reached by a leading
        // S step, otherwise the ego-side endpoint of the S step (the sibling,
        // child or parent already on the chain).
        let via_spouse_gender = Some(gender_of(if index == 0 {
            person_path[1]
        } else {
            person_path[index]
        }));

        if prefix.is_empty() && suffix.is_empty() {
            let kind = match target_gender {
                Gender::Male => KinshipKind::Husband,
                Gender::Female => KinshipKind::Wife,
                Gender::Unknown => KinshipKind::Partner,
            };
            return Classification::new(kind);
        }

        if index == 0 {
            // S … : spouse first (parents, children, siblings of the spouse).
            let Some(shape) = shape(suffix) else {
                return Classification::unknown();
            };
            let kind = match (shape.ups, shape.downs) {
                (1, 0) => KinshipKind::ParentInLaw,
                // A child of the spouse is a step-child, never a child-in-law.
                (0, 1) => KinshipKind::StepChild,
                (1, 1) => KinshipKind::SiblingOfSpouse,
                _ => return Classification::unknown(),
            };
            let mut classification = Classification::new(kind);
            classification.via_spouse_gender = via_spouse_gender;
            return classification;
        }

        if index + 1 == steps.len() {
            // … S: spouse last (parents, children, siblings of ego).
            let Some(shape) = shape(prefix) else {
                return Classification::unknown();
            };
            let kind = match (shape.ups, shape.downs) {
                (1, 0) => KinshipKind::StepParent,
                (1, 1) => KinshipKind::SpouseOfSibling,
                (0, 1) => KinshipKind::ChildInLaw,
                _ => return Classification::unknown(),
            };
            let mut classification = Classification::new(kind);
            classification.via_spouse_gender = via_spouse_gender;
            if shape.ups == 1 && shape.downs == 1 {
                classification.line = parent_line(gender_of(person_path[1]));
            }
            return classification;
        }

        // Spouse in the middle: a parent's spouse's child is a step-sibling.
        let (Some(left), Some(right)) = (shape(prefix), shape(suffix)) else {
            return Classification::unknown();
        };
        if left.ups == 1 && left.downs == 0 && right.ups == 0 && right.downs == 1 {
            let mut classification = Classification::new(KinshipKind::StepSibling);
            classification.via_spouse_gender = via_spouse_gender;
            return classification;
        }
        Classification::unknown()
    }

    pub fn are_siblings(&self, a: Uuid, b: Uuid) -> bool {
        if a == b {
            return false;
        }
        let left: BTreeSet<Uuid> = self.parents_of(a).into_iter().map(|(id, _)| id).collect();
        if left.is_empty() {
            return false;
        }
        self.parents_of(b)
            .iter()
            .any(|(parent, _)| left.contains(parent))
    }

    pub fn siblings_of(&self, person: Uuid) -> Vec<Uuid> {
        let parents: BTreeSet<Uuid> = self
            .parents_of(person)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        let mut out = BTreeSet::new();
        for parent in parents {
            for child in self.children_of(parent) {
                if child != person {
                    out.insert(child);
                }
            }
        }
        out.into_iter().collect()
    }
}

/// Two spouse steps: only свояк/ятровка (spouse → sibling → spouse) has a
/// dedicated term; everything else stays descriptive.
fn classify_two_spouses(
    person_path: &[Uuid],
    steps: &[Step],
    gender_of: &dyn Fn(Uuid) -> Gender,
) -> Classification {
    let expected = [Step::Spouse, Step::Up, Step::Down, Step::Spouse];
    if steps == expected.as_slice() {
        let mut classification = Classification::new(KinshipKind::SpouseOfSpousesSibling);
        classification.via_spouse_gender = person_path.get(1).map(|spouse| gender_of(*spouse));
        return classification;
    }
    Classification::unknown()
}

/// Paternal/maternal side of a cousin relation: compare the first parent on
/// each side of the common ancestor.
fn cousin_line(person_path: &[Uuid], gender_of: &dyn Fn(Uuid) -> Gender) -> Option<KinshipLine> {
    let source = parent_line(gender_of(*person_path.get(1)?))?;
    let target = parent_line(gender_of(
        *person_path.get(person_path.len().checked_sub(2)?)?,
    ))?;
    Some(if source == target {
        source
    } else {
        KinshipLine::Mixed
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::relationship::{Relationship, RelationshipType};

    /// Synthetic family builder: every person has an explicit gender and every
    /// edge goes through the validated `RelationshipSet`.
    struct Fixture {
        genders: BTreeMap<Uuid, Gender>,
        set: RelationshipSet,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                genders: BTreeMap::new(),
                set: RelationshipSet::default(),
            }
        }

        fn person(&mut self, gender: Gender) -> Uuid {
            let id = Uuid::now_v7();
            self.genders.insert(id, gender);
            id
        }

        fn parent(&mut self, parent: Uuid, child: Uuid) {
            self.link(RelationshipType::ParentChild, parent, child);
        }

        fn adoptive_parent(&mut self, parent: Uuid, child: Uuid) {
            self.link(RelationshipType::AdoptiveParentChild, parent, child);
        }

        fn spouse(&mut self, a: Uuid, b: Uuid) {
            self.link(RelationshipType::Spouse, a, b);
        }

        fn partner(&mut self, a: Uuid, b: Uuid) {
            self.link(RelationshipType::Partner, a, b);
        }

        fn link(&mut self, kind: RelationshipType, a: Uuid, b: Uuid) {
            self.set
                .push(Relationship::new(kind, a, b).unwrap())
                .unwrap();
        }

        fn kinship(&self, from: Uuid, to: Uuid) -> KinshipDescriptor {
            self.set.kinship(from, to, &|id| {
                self.genders.get(&id).copied().unwrap_or(Gender::Unknown)
            })
        }
    }

    struct Basic {
        grandpa: Uuid,
        grandma: Uuid,
        father: Uuid,
        mother: Uuid,
        son: Uuid,
        daughter: Uuid,
        uncle: Uuid,
        cousin: Uuid,
    }

    fn basic() -> (Fixture, Basic) {
        let mut family = Fixture::new();
        let grandpa = family.person(Gender::Male);
        let grandma = family.person(Gender::Female);
        let father = family.person(Gender::Male);
        let mother = family.person(Gender::Female);
        let son = family.person(Gender::Male);
        let daughter = family.person(Gender::Female);
        let uncle = family.person(Gender::Male);
        let cousin = family.person(Gender::Male);
        family.parent(grandpa, father);
        family.parent(grandma, father);
        family.parent(grandpa, uncle);
        family.parent(father, son);
        family.parent(mother, son);
        family.parent(father, daughter);
        family.parent(mother, daughter);
        family.parent(uncle, cousin);
        family.spouse(grandpa, grandma);
        family.spouse(father, mother);
        (
            family,
            Basic {
                grandpa,
                grandma,
                father,
                mother,
                son,
                daughter,
                uncle,
                cousin,
            },
        )
    }

    #[test]
    fn parents_and_grandparents() {
        let (family, tree) = basic();
        assert_eq!(
            family.kinship(tree.son, tree.father).kind,
            KinshipKind::Father
        );
        assert_eq!(
            family.kinship(tree.son, tree.mother).kind,
            KinshipKind::Mother
        );
        let grandpa = family.kinship(tree.son, tree.grandpa);
        assert_eq!(grandpa.kind, KinshipKind::Grandfather);
        assert_eq!(grandpa.generation_delta, 2);
        assert_eq!(grandpa.line, Some(KinshipLine::Paternal));
        assert_eq!(grandpa.edges.len(), 2);
        assert_eq!(
            family.kinship(tree.son, tree.grandma).kind,
            KinshipKind::Grandmother
        );
        assert_eq!(
            family.kinship(tree.son, tree.grandpa).source_gender,
            Gender::Male
        );
    }

    #[test]
    fn children_and_siblings() {
        let (family, tree) = basic();
        assert_eq!(family.kinship(tree.father, tree.son).kind, KinshipKind::Son);
        assert_eq!(
            family.kinship(tree.father, tree.daughter).kind,
            KinshipKind::Daughter
        );
        let sister = family.kinship(tree.son, tree.daughter);
        assert_eq!(sister.kind, KinshipKind::Sister);
        assert_eq!(sister.generation_delta, 0);
        assert_eq!(sister.edges.len(), 2);
        assert_eq!(
            family.kinship(tree.daughter, tree.son).kind,
            KinshipKind::Brother
        );
    }

    #[test]
    fn uncle_and_cousin() {
        let (family, tree) = basic();
        let uncle = family.kinship(tree.son, tree.uncle);
        assert_eq!(uncle.kind, KinshipKind::Uncle);
        assert_eq!(uncle.generation_delta, 1);
        assert_eq!(uncle.line, Some(KinshipLine::Paternal));
        let cousin = family.kinship(tree.son, tree.cousin);
        assert_eq!(cousin.kind, KinshipKind::Cousin);
        assert_eq!(cousin.degree, 1);
        assert_eq!(cousin.removed, 0);
        assert_eq!(cousin.generation_delta, 0);
        let reverse = family.kinship(tree.cousin, tree.son);
        assert_eq!(reverse.kind, KinshipKind::Cousin);
        assert_eq!(reverse.degree, 1);
        assert_eq!(reverse.removed, 0);
    }

    #[test]
    fn spouse_and_in_law() {
        let (family, tree) = basic();
        assert_eq!(
            family.kinship(tree.father, tree.mother).kind,
            KinshipKind::Wife
        );
        assert_eq!(
            family.kinship(tree.mother, tree.father).kind,
            KinshipKind::Husband
        );
        let in_law = family.kinship(tree.mother, tree.grandpa);
        assert_eq!(in_law.kind, KinshipKind::ParentInLaw);
        // The spouse through whom the relation exists is the husband here.
        assert_eq!(in_law.via_spouse_gender, Some(Gender::Male));
    }

    struct InLaws {
        ego: Uuid,
        wife: Uuid,
        wife_father: Uuid,
        wife_mother: Uuid,
        wife_brother: Uuid,
        wife_sister_husband: Uuid,
        father: Uuid,
        mother: Uuid,
        sister: Uuid,
        sister_husband: Uuid,
    }

    fn in_laws() -> (Fixture, InLaws) {
        let mut family = Fixture::new();
        let ego = family.person(Gender::Male);
        let wife = family.person(Gender::Female);
        let wife_father = family.person(Gender::Male);
        let wife_mother = family.person(Gender::Female);
        let wife_brother = family.person(Gender::Male);
        let wife_sister = family.person(Gender::Female);
        let wife_sister_husband = family.person(Gender::Male);
        let father = family.person(Gender::Male);
        let mother = family.person(Gender::Female);
        let sister = family.person(Gender::Female);
        let sister_husband = family.person(Gender::Male);

        family.spouse(ego, wife);
        for child in [wife, wife_brother, wife_sister] {
            family.parent(wife_father, child);
            family.parent(wife_mother, child);
        }
        family.spouse(wife_sister, wife_sister_husband);
        for child in [ego, sister] {
            family.parent(father, child);
            family.parent(mother, child);
        }
        family.spouse(father, mother);
        family.spouse(sister, sister_husband);

        (
            family,
            InLaws {
                ego,
                wife,
                wife_father,
                wife_mother,
                wife_brother,
                wife_sister_husband,
                father,
                mother,
                sister,
                sister_husband,
            },
        )
    }

    #[test]
    fn parents_in_law_use_the_spouse_gender() {
        let (family, tree) = in_laws();
        // Wife's parents: тесть/тёща — the spouse is the wife.
        for parent in [tree.wife_father, tree.wife_mother] {
            let descriptor = family.kinship(tree.ego, parent);
            assert_eq!(descriptor.kind, KinshipKind::ParentInLaw);
            assert_eq!(descriptor.via_spouse_gender, Some(Gender::Female));
            assert_eq!(descriptor.edges.len(), 2);
            assert_eq!(descriptor.edges[0].kind, KinshipEdgeKind::Spouse);
        }
        // Husband's parents: свёкор/свекровь — the spouse is the husband.
        for parent in [tree.father, tree.mother] {
            let descriptor = family.kinship(tree.wife, parent);
            assert_eq!(descriptor.kind, KinshipKind::ParentInLaw);
            assert_eq!(descriptor.via_spouse_gender, Some(Gender::Male));
        }
    }

    #[test]
    fn sibling_in_law_directions() {
        let (family, tree) = in_laws();
        // Wife's brother: шурин, named after the wife.
        let brother_of_wife = family.kinship(tree.ego, tree.wife_brother);
        assert_eq!(brother_of_wife.kind, KinshipKind::SiblingOfSpouse);
        assert_eq!(brother_of_wife.via_spouse_gender, Some(Gender::Female));
        // Sister's husband: зять, named after the sister — not SIBLING_IN_LAW.
        let husband_of_sister = family.kinship(tree.ego, tree.sister_husband);
        assert_eq!(husband_of_sister.kind, KinshipKind::SpouseOfSibling);
        assert_eq!(husband_of_sister.via_spouse_gender, Some(Gender::Female));
        // The same pair seen from the other end stays consistent.
        assert_eq!(
            family.kinship(tree.sister_husband, tree.ego).kind,
            KinshipKind::SiblingOfSpouse
        );
        assert_eq!(
            family.kinship(tree.sister, tree.wife).kind,
            KinshipKind::SpouseOfSibling
        );
        assert_eq!(
            family.kinship(tree.wife, tree.sister).kind,
            KinshipKind::SiblingOfSpouse
        );
    }

    #[test]
    fn svojak_is_reachable() {
        let (family, tree) = in_laws();
        let svojak = family.kinship(tree.ego, tree.wife_sister_husband);
        assert_eq!(svojak.kind, KinshipKind::SpouseOfSpousesSibling);
        assert_eq!(svojak.via_spouse_gender, Some(Gender::Female));
        assert_eq!(svojak.edges.len(), 4);
        assert_eq!(
            family.kinship(tree.wife_sister_husband, tree.ego).kind,
            KinshipKind::SpouseOfSpousesSibling
        );
    }

    #[test]
    fn child_in_law_is_the_spouse_of_a_child() {
        let (family, tree) = in_laws();
        let son_in_law = family.kinship(tree.father, tree.sister_husband);
        assert_eq!(son_in_law.kind, KinshipKind::ChildInLaw);
        assert_eq!(son_in_law.via_spouse_gender, Some(Gender::Female));
        // And the reverse direction is a parent-in-law, not a step relation.
        assert_eq!(
            family.kinship(tree.sister_husband, tree.father).kind,
            KinshipKind::ParentInLaw
        );
    }

    struct Dynasty {
        ego: Uuid,
        ggp: Uuid,
        guncle: Uuid,
        gaunt: Uuid,
        uncle_p: Uuid,
        uncle_m: Uuid,
        cousin1: Uuid,
        cousin1_child: Uuid,
        sc_parent: Uuid,
        second_cousin: Uuid,
        niece: Uuid,
        nephew: Uuid,
        grand_niece: Uuid,
        grand_nephew: Uuid,
        son: Uuid,
        grandson: Uuid,
    }

    fn dynasty() -> (Fixture, Dynasty) {
        let mut family = Fixture::new();
        let ggp = family.person(Gender::Male);
        let ggm = family.person(Gender::Female);
        let gp = family.person(Gender::Male);
        let gm = family.person(Gender::Female);
        let guncle = family.person(Gender::Male);
        let gaunt = family.person(Gender::Female);
        let father = family.person(Gender::Male);
        let mother = family.person(Gender::Female);
        let mgp = family.person(Gender::Male);
        let mgm = family.person(Gender::Female);
        let uncle_m = family.person(Gender::Male);
        let uncle_p = family.person(Gender::Male);
        let ego = family.person(Gender::Male);
        let sister = family.person(Gender::Female);
        let niece = family.person(Gender::Female);
        let nephew = family.person(Gender::Male);
        let grand_niece = family.person(Gender::Female);
        let grand_nephew = family.person(Gender::Male);
        let cousin1 = family.person(Gender::Male);
        let cousin1_child = family.person(Gender::Female);
        let sc_parent = family.person(Gender::Female);
        let second_cousin = family.person(Gender::Male);
        let son = family.person(Gender::Male);
        let grandson = family.person(Gender::Male);

        family.spouse(ggp, ggm);
        for child in [gp, guncle, gaunt] {
            family.parent(ggp, child);
            family.parent(ggm, child);
        }
        family.spouse(gp, gm);
        family.parent(gp, father);
        family.parent(gm, father);
        family.parent(gp, uncle_p);
        family.parent(gm, uncle_p);
        family.spouse(father, mother);
        for child in [ego, sister] {
            family.parent(father, child);
            family.parent(mother, child);
        }
        family.spouse(mgp, mgm);
        for child in [mother, uncle_m] {
            family.parent(mgp, child);
            family.parent(mgm, child);
        }
        family.parent(sister, niece);
        family.parent(sister, nephew);
        family.parent(niece, grand_niece);
        family.parent(nephew, grand_nephew);
        family.parent(uncle_p, cousin1);
        family.parent(cousin1, cousin1_child);
        family.parent(guncle, sc_parent);
        family.parent(sc_parent, second_cousin);
        family.parent(ego, son);
        family.parent(son, grandson);

        (
            family,
            Dynasty {
                ego,
                ggp,
                guncle,
                gaunt,
                uncle_p,
                uncle_m,
                cousin1,
                cousin1_child,
                sc_parent,
                second_cousin,
                niece,
                nephew,
                grand_niece,
                grand_nephew,
                son,
                grandson,
            },
        )
    }

    #[test]
    fn great_grandparent_generation_delta() {
        let (family, tree) = dynasty();
        let great_grandfather = family.kinship(tree.ego, tree.ggp);
        assert_eq!(great_grandfather.kind, KinshipKind::GreatGrandparent);
        assert_eq!(great_grandfather.generation_delta, 3);
        assert_eq!(great_grandfather.line, Some(KinshipLine::Paternal));
        let great_grandson = family.kinship(tree.ggp, tree.grandson);
        assert_eq!(great_grandson.kind, KinshipKind::GreatGrandchild);
        assert_eq!(great_grandson.generation_delta, -5);
        assert_eq!(family.kinship(tree.ego, tree.son).kind, KinshipKind::Son);
        assert_eq!(
            family.kinship(tree.ego, tree.grandson).kind,
            KinshipKind::Grandson
        );
    }

    #[test]
    fn great_uncle_and_grand_nephew() {
        let (family, tree) = dynasty();
        // Brother of the grandfather: двоюродный дед.
        let great_uncle = family.kinship(tree.ego, tree.guncle);
        assert_eq!(great_uncle.kind, KinshipKind::GreatUncle);
        assert_eq!(great_uncle.generation_delta, 2);
        assert_eq!(great_uncle.line, Some(KinshipLine::Paternal));
        // Sister of the grandfather: двоюродная бабка.
        assert_eq!(
            family.kinship(tree.ego, tree.gaunt).kind,
            KinshipKind::GreatAunt
        );
        // Daughter of a niece: внучатая племянница.
        let grand_niece = family.kinship(tree.ego, tree.grand_niece);
        assert_eq!(grand_niece.kind, KinshipKind::GrandNiece);
        assert_eq!(grand_niece.generation_delta, -2);
        assert_eq!(
            family.kinship(tree.ego, tree.grand_nephew).kind,
            KinshipKind::GrandNephew
        );
        assert_eq!(
            family.kinship(tree.ego, tree.niece).kind,
            KinshipKind::Niece
        );
        assert_eq!(
            family.kinship(tree.ego, tree.nephew).kind,
            KinshipKind::Nephew
        );
    }

    #[test]
    fn line_follows_the_parent_side() {
        let (family, tree) = dynasty();
        assert_eq!(
            family.kinship(tree.ego, tree.uncle_p).line,
            Some(KinshipLine::Paternal)
        );
        assert_eq!(
            family.kinship(tree.ego, tree.uncle_m).line,
            Some(KinshipLine::Maternal)
        );
        assert_eq!(
            family.kinship(tree.ego, tree.uncle_m).kind,
            KinshipKind::Uncle
        );
    }

    #[test]
    fn cousins_carry_degree_and_removed() {
        let (family, tree) = dynasty();
        let first = family.kinship(tree.ego, tree.cousin1);
        assert_eq!(first.kind, KinshipKind::Cousin);
        assert_eq!(first.degree, 1);
        assert_eq!(first.removed, 0);
        assert_eq!(first.generation_delta, 0);
        assert_eq!(first.line, Some(KinshipLine::Paternal));

        // Child of a first cousin: one generation apart.
        let removed = family.kinship(tree.ego, tree.cousin1_child);
        assert_eq!(removed.kind, KinshipKind::Cousin);
        assert_eq!(removed.degree, 1);
        assert_eq!(removed.removed, 1);
        assert_eq!(removed.generation_delta, 1);
        let removed_back = family.kinship(tree.cousin1_child, tree.ego);
        assert_eq!(removed_back.kind, KinshipKind::Cousin);
        assert_eq!(removed_back.degree, 1);
        assert_eq!(removed_back.removed, 1);
        assert_eq!(removed_back.generation_delta, -1);

        // Parent's cousin: also degree 1, removed 1, older generation.
        let elder = family.kinship(tree.ego, tree.sc_parent);
        assert_eq!(elder.kind, KinshipKind::Cousin);
        assert_eq!(elder.degree, 1);
        assert_eq!(elder.removed, 1);
        assert_eq!(elder.generation_delta, -1);

        // Second cousins share great-grandparents.
        let second = family.kinship(tree.ego, tree.second_cousin);
        assert_eq!(second.kind, KinshipKind::Cousin);
        assert_eq!(second.degree, 2);
        assert_eq!(second.removed, 0);
        assert_eq!(second.generation_delta, 0);
    }

    #[test]
    fn direction_inversion_is_consistent() {
        let (family, tree) = dynasty();
        assert_eq!(
            family.kinship(tree.ego, tree.uncle_p).kind,
            KinshipKind::Uncle
        );
        assert_eq!(
            family.kinship(tree.uncle_p, tree.ego).kind,
            KinshipKind::Nephew
        );
        assert_eq!(
            family.kinship(tree.ego, tree.guncle).kind,
            KinshipKind::GreatUncle
        );
        assert_eq!(
            family.kinship(tree.guncle, tree.ego).kind,
            KinshipKind::GrandNephew
        );
        assert_eq!(
            family.kinship(tree.ego, tree.grand_niece).kind,
            KinshipKind::GrandNiece
        );
        // From the grand-niece the same man is a great-uncle.
        assert_eq!(
            family.kinship(tree.grand_niece, tree.ego).kind,
            KinshipKind::GreatUncle
        );
        assert_eq!(
            family.kinship(tree.gaunt, tree.ego).kind,
            KinshipKind::GrandNephew
        );
        let sister = family.kinship(tree.ego, tree.grand_niece);
        assert_eq!(sister.edges.len() + 1, sister.path.len());
        let inverted = family.kinship(tree.grand_niece, tree.ego);
        assert_eq!(inverted.path.first(), Some(&tree.grand_niece));
        assert_eq!(inverted.path.last(), Some(&tree.ego));
    }

    struct Steps {
        ego: Uuid,
        stepfather: Uuid,
        stepbrother: Uuid,
        wife: Uuid,
        wife_daughter: Uuid,
    }

    fn steps() -> (Fixture, Steps) {
        let mut family = Fixture::new();
        let ego = family.person(Gender::Male);
        let mother = family.person(Gender::Female);
        let stepfather = family.person(Gender::Male);
        let stepbrother = family.person(Gender::Male);
        let wife = family.person(Gender::Female);
        let wife_daughter = family.person(Gender::Female);
        family.parent(mother, ego);
        family.spouse(mother, stepfather);
        family.parent(stepfather, stepbrother);
        family.spouse(ego, wife);
        family.parent(wife, wife_daughter);
        (
            family,
            Steps {
                ego,
                stepfather,
                stepbrother,
                wife,
                wife_daughter,
            },
        )
    }

    #[test]
    fn step_relations_are_reachable() {
        let (family, tree) = steps();
        // Husband of the mother: отчим, not a parent-in-law.
        let stepfather = family.kinship(tree.ego, tree.stepfather);
        assert_eq!(stepfather.kind, KinshipKind::StepParent);
        assert_eq!(stepfather.edges.len(), 2);
        // Daughter of the wife: падчерица, not a child-in-law.
        let stepchild = family.kinship(tree.ego, tree.wife_daughter);
        assert_eq!(stepchild.kind, KinshipKind::StepChild);
        assert_ne!(stepchild.kind, KinshipKind::ChildInLaw);
        assert_eq!(stepchild.via_spouse_gender, Some(Gender::Female));
        // And both invert into each other.
        assert_eq!(
            family.kinship(tree.stepfather, tree.ego).kind,
            KinshipKind::StepChild
        );
        assert_eq!(
            family.kinship(tree.wife_daughter, tree.ego).kind,
            KinshipKind::StepParent
        );
        // Child of the step-father: сводный брат.
        let stepbrother = family.kinship(tree.ego, tree.stepbrother);
        assert_eq!(stepbrother.kind, KinshipKind::StepSibling);
        assert_eq!(stepbrother.generation_delta, 0);
        assert_eq!(
            family.kinship(tree.stepbrother, tree.ego).kind,
            KinshipKind::StepSibling
        );
        assert_eq!(family.kinship(tree.ego, tree.wife).kind, KinshipKind::Wife);
    }

    #[test]
    fn unknown_is_not_a_fake_term() {
        let (family, tree) = basic();
        let stranger = Uuid::now_v7();
        let descriptor = family.kinship(tree.son, stranger);
        assert_eq!(descriptor.kind, KinshipKind::Unknown);
        assert!(descriptor.path.is_empty());
        assert!(descriptor.edges.is_empty());
        assert_eq!(descriptor.common_ancestor_id, None);
    }

    #[test]
    fn descriptor_edges_mirror_the_path() {
        let (family, tree) = basic();
        let descriptor = family.kinship(tree.son, tree.father);
        assert_eq!(descriptor.edges.len(), descriptor.path.len() - 1);
        assert_eq!(descriptor.edges[0].kind, KinshipEdgeKind::Parent);
        assert_eq!(
            (descriptor.edges[0].from, descriptor.edges[0].to),
            (tree.son, tree.father)
        );
        assert_eq!(descriptor.edges[0].from_gender, Gender::Male);
        assert_eq!(descriptor.edges[0].to_gender, Gender::Male);
        assert!(!descriptor.edges[0].adoptive);
        assert_eq!(descriptor.common_ancestor_id, Some(tree.father));
        assert_eq!(descriptor.source_gender, Gender::Male);
    }

    #[test]
    fn partner_and_adoptive_edges_are_kept() {
        let mut family = Fixture::new();
        let first = family.person(Gender::Unknown);
        let second = family.person(Gender::Unknown);
        family.partner(first, second);
        let partner = family.kinship(first, second);
        assert_eq!(partner.kind, KinshipKind::Partner);
        assert_eq!(partner.edges[0].kind, KinshipEdgeKind::Partner);

        // Legacy mapping: a partner of known gender still reads as husband/wife;
        // the Partner relationship stays visible through `edges`.
        let third = family.person(Gender::Female);
        family.partner(first, third);
        let known = family.kinship(first, third);
        assert_eq!(known.kind, KinshipKind::Wife);
        assert_eq!(known.edges[0].kind, KinshipEdgeKind::Partner);

        let adopter = family.person(Gender::Female);
        let child = family.person(Gender::Male);
        family.adoptive_parent(adopter, child);
        let up = family.kinship(child, adopter);
        assert_eq!(up.kind, KinshipKind::Mother);
        assert_eq!(up.edges[0].kind, KinshipEdgeKind::Parent);
        assert!(up.edges[0].adoptive);
        let down = family.kinship(adopter, child);
        assert_eq!(down.kind, KinshipKind::Son);
        assert_eq!(down.edges[0].kind, KinshipEdgeKind::Child);
        assert!(down.edges[0].adoptive);
    }

    #[test]
    fn descriptor_is_serializable_without_strings() {
        let (family, tree) = basic();
        let descriptor = family.kinship(tree.son, tree.father);
        let json = serde_json::to_value(&descriptor).unwrap();
        assert_eq!(json["kind"], "FATHER");
        assert_eq!(json["gender"], "MALE");
        assert_eq!(json["sourceGender"], "MALE");
        assert_eq!(json["viaSpouseGender"], serde_json::Value::Null);
        assert_eq!(json["edges"][0]["kind"], "PARENT");
        assert_eq!(json["edges"][0]["fromGender"], "MALE");
        assert_eq!(json["edges"][0]["toGender"], "MALE");
        assert!(json["commonAncestorId"].is_string());
        assert!(json.get("line").is_some());
        assert!(json.get("degree").is_some());
        assert!(json.get("removed").is_some());
        assert!(json.get("generationDelta").is_some());
        assert!(json.get("path").is_some());

        let (in_law_family, in_law_tree) = in_laws();
        let in_law =
            serde_json::to_value(in_law_family.kinship(in_law_tree.ego, in_law_tree.wife_brother))
                .unwrap();
        assert_eq!(in_law["kind"], "SIBLING_OF_SPOUSE");
        assert_eq!(in_law["viaSpouseGender"], "FEMALE");

        let (dynasty_family, dynasty_tree) = dynasty();
        let great_uncle =
            serde_json::to_value(dynasty_family.kinship(dynasty_tree.ego, dynasty_tree.guncle))
                .unwrap();
        assert_eq!(great_uncle["kind"], "GREAT_UNCLE");
        assert_eq!(great_uncle["generationDelta"], 2);
    }
}
