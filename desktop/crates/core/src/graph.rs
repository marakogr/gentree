use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::person::Gender;
use crate::relationship::RelationshipSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AncestorRole {
    Root,
    Father,
    Mother,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AncestorNode {
    /// `None` for a placeholder (unknown parent), never a fake person.
    pub person_id: Option<Uuid>,
    /// Unique path-based key; the same person may appear under several keys.
    pub occurrence_key: String,
    pub generation: u32,
    pub role: AncestorRole,
    pub adoptive: bool,
    pub placeholder: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AncestorEdge {
    pub parent_key: String,
    pub child_key: String,
    pub adoptive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AncestorGraph {
    pub root_person_id: Uuid,
    pub generations: u32,
    pub nodes: Vec<AncestorNode>,
    pub edges: Vec<AncestorEdge>,
    pub truncated: bool,
    pub pedigree_collapse: bool,
}

/// Role of a person in a descendant tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DescendantRole {
    Root,
    Son,
    Daughter,
    Child,
}

/// One rendered descendant; the root is at generation 0 and children below it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescendantNode {
    pub person_id: Uuid,
    pub occurrence_key: String,
    pub generation: u32,
    pub role: DescendantRole,
    pub adoptive: bool,
}

/// Parent-to-child edge in a descendant tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescendantEdge {
    pub parent_key: String,
    pub child_key: String,
    pub adoptive: bool,
}

/// Root plus up to `generations` descendant levels. Siblings, spouses and
/// ancestors are not included. `pedigree_collapse` means a child is reachable
/// through more than one descendant parent and is drawn only once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescendantGraph {
    pub root_person_id: Uuid,
    pub generations: u32,
    pub nodes: Vec<DescendantNode>,
    pub edges: Vec<DescendantEdge>,
    pub truncated: bool,
    pub pedigree_collapse: bool,
}

pub const DEFAULT_GENERATIONS: u32 = 3;
/// Hard cap for an explicit "show next generation" request. The UI grows the
/// depth one step at a time; this only protects the render from runaway trees.
pub const MAX_GENERATIONS: u32 = 8;
pub const MAX_ANCESTORS: usize = 14;
/// Safety cap for very broad descendant trees (one generation may have many
/// children). The graph is marked truncated before this limit is exceeded.
pub const MAX_DESCENDANT_NODES: usize = 500;

impl RelationshipSet {
    /// Root plus up to `generations` ancestor levels. Placeholders fill unknown
    /// parent slots; siblings/uncles are never included. See ADR-0011.
    pub fn ancestors(&self, root: Uuid, generations: u32) -> AncestorGraph {
        self.ancestors_with_gender(root, generations, |_| Gender::Unknown)
    }

    /// Same as [`Self::ancestors`], but picks Father/Mother by the person's
    /// gender instead of parent order.
    pub fn ancestors_with_gender<F: Fn(Uuid) -> Gender>(
        &self,
        root: Uuid,
        generations: u32,
        gender_of: F,
    ) -> AncestorGraph {
        let generations = generations.min(MAX_GENERATIONS);
        let mut nodes: Vec<AncestorNode> = vec![AncestorNode {
            person_id: Some(root),
            occurrence_key: "0".to_owned(),
            generation: 0,
            role: AncestorRole::Root,
            adoptive: false,
            placeholder: false,
        }];
        let mut edges = Vec::new();
        let mut truncated = false;

        for generation in 0..generations {
            let level: Vec<(String, Uuid)> = nodes
                .iter()
                .filter(|node| node.generation == generation && !node.placeholder)
                .filter_map(|node| {
                    node.person_id
                        .map(|person| (node.occurrence_key.clone(), person))
                })
                .collect();

            for (key, person) in level {
                let parents = self.parents_of(person);
                let mut known = parents.into_iter();
                for slot in 0..2 {
                    let suffix = if slot == 0 { "f" } else { "m" };
                    let occurrence_key = format!("{key}.{suffix}");
                    let next = known.next();
                    let role = match next {
                        Some((parent_id, _)) => match gender_of(parent_id) {
                            Gender::Male => AncestorRole::Father,
                            Gender::Female => AncestorRole::Mother,
                            Gender::Unknown if slot == 0 => AncestorRole::Father,
                            Gender::Unknown => AncestorRole::Mother,
                        },
                        None if slot == 0 => AncestorRole::Father,
                        None => AncestorRole::Mother,
                    };
                    match next {
                        Some((parent_id, adoptive)) => {
                            edges.push(AncestorEdge {
                                parent_key: occurrence_key.clone(),
                                child_key: key.clone(),
                                adoptive,
                            });
                            nodes.push(AncestorNode {
                                person_id: Some(parent_id),
                                occurrence_key,
                                generation: generation + 1,
                                role,
                                adoptive,
                                placeholder: false,
                            });
                        }
                        None => {
                            nodes.push(AncestorNode {
                                person_id: None,
                                occurrence_key,
                                generation: generation + 1,
                                role,
                                adoptive: false,
                                placeholder: true,
                            });
                        }
                    }
                }
            }
        }

        // Anything at the level after the last shown generation means the tree
        // continues but is intentionally not rendered.
        for node in nodes.iter().filter(|node| node.generation == generations) {
            if let Some(person) = node.person_id {
                if !self.parents_of(person).is_empty() {
                    truncated = true;
                    break;
                }
            }
        }

        let mut seen: BTreeMap<Uuid, usize> = BTreeMap::new();
        for node in &nodes {
            if let Some(person) = node.person_id {
                *seen.entry(person).or_insert(0) += 1;
            }
        }
        let pedigree_collapse = seen.values().any(|count| *count > 1);

        AncestorGraph {
            root_person_id: root,
            generations,
            nodes,
            edges,
            truncated,
            pedigree_collapse,
        }
    }

    /// Root plus up to `generations` descendant levels. Children are sorted by
    /// id, so equal input yields equal output. A child reached through two
    /// descendant parents is drawn once and flagged as a pedigree collapse;
    /// spouses and siblings are not added.
    pub fn descendants_with_gender<F: Fn(Uuid) -> Gender>(
        &self,
        root: Uuid,
        generations: u32,
        gender_of: F,
    ) -> DescendantGraph {
        let generations = generations.min(MAX_GENERATIONS);
        let mut nodes = vec![DescendantNode {
            person_id: root,
            occurrence_key: "0".to_owned(),
            generation: 0,
            role: DescendantRole::Root,
            adoptive: false,
        }];
        let mut edges = Vec::new();
        let mut seen: BTreeMap<Uuid, String> = BTreeMap::from([(root, "0".to_owned())]);
        let mut truncated = false;
        let mut pedigree_collapse = false;

        for generation in 0..generations {
            let level: Vec<(String, Uuid)> = nodes
                .iter()
                .filter(|node| node.generation == generation)
                .map(|node| (node.occurrence_key.clone(), node.person_id))
                .collect();

            for (parent_key, person) in level {
                for (index, child) in self.children_of(person).into_iter().enumerate() {
                    if seen.contains_key(&child) {
                        // The same child is reachable through another descendant
                        // parent: keep one occurrence and report the collapse.
                        pedigree_collapse = true;
                        continue;
                    }
                    if nodes.len() >= MAX_DESCENDANT_NODES {
                        truncated = true;
                        break;
                    }
                    let occurrence_key = format!("{parent_key}.c{index}");
                    let adoptive = self
                        .parents_of(child)
                        .into_iter()
                        .find(|(parent, _)| *parent == person)
                        .map(|(_, adoptive)| adoptive)
                        .unwrap_or(false);
                    let role = match gender_of(child) {
                        Gender::Male => DescendantRole::Son,
                        Gender::Female => DescendantRole::Daughter,
                        Gender::Unknown => DescendantRole::Child,
                    };
                    edges.push(DescendantEdge {
                        parent_key: parent_key.clone(),
                        child_key: occurrence_key.clone(),
                        adoptive,
                    });
                    nodes.push(DescendantNode {
                        person_id: child,
                        occurrence_key: occurrence_key.clone(),
                        generation: generation + 1,
                        role,
                        adoptive,
                    });
                    seen.insert(child, occurrence_key);
                }
                if nodes.len() >= MAX_DESCENDANT_NODES {
                    truncated = true;
                    break;
                }
            }
            if nodes.len() >= MAX_DESCENDANT_NODES {
                break;
            }
        }

        // The requested depth is reached but at least one person there has
        // children; the tree continues beyond the cut.
        if !truncated {
            truncated = nodes
                .iter()
                .filter(|node| node.generation == generations)
                .any(|node| !self.children_of(node.person_id).is_empty());
        }

        DescendantGraph {
            root_person_id: root,
            generations,
            nodes,
            edges,
            truncated,
            pedigree_collapse,
        }
    }

    /// Parent-only ancestor depth map, including the person itself at depth 0.
    pub fn ancestor_depths(&self, person: Uuid) -> BTreeMap<Uuid, u32> {
        let mut depths = BTreeMap::new();
        let mut queue = vec![(person, 0u32)];
        while let Some((current, depth)) = queue.pop() {
            if depths.get(&current).is_some_and(|known| *known <= depth) {
                continue;
            }
            depths.insert(current, depth);
            for (parent, _) in self.parents_of(current) {
                queue.push((parent, depth + 1));
            }
        }
        depths
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relationship::{Relationship, RelationshipType};

    struct Family {
        grandpa: Uuid,
        grandma: Uuid,
        father: Uuid,
        mother: Uuid,
        child: Uuid,
    }

    fn family() -> (Family, RelationshipSet) {
        let grandpa = Uuid::now_v7();
        let grandma = Uuid::now_v7();
        let father = Uuid::now_v7();
        let mother = Uuid::now_v7();
        let child = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        for (parent, kid) in [
            (grandpa, father),
            (grandma, father),
            (father, child),
            (mother, child),
        ] {
            set.push(Relationship::new(RelationshipType::ParentChild, parent, kid).unwrap())
                .unwrap();
        }
        (
            Family {
                grandpa,
                grandma,
                father,
                mother,
                child,
            },
            set,
        )
    }

    #[test]
    fn three_generations_with_placeholders() {
        let (f, set) = family();
        let graph = set.ancestors(f.child, 3);
        assert_eq!(graph.nodes[0].person_id, Some(f.child));
        assert_eq!(graph.nodes[0].role, AncestorRole::Root);
        let ids: Vec<Uuid> = graph
            .nodes
            .iter()
            .filter_map(|node| node.person_id)
            .collect();
        assert!(ids.contains(&f.father));
        assert!(ids.contains(&f.mother));
        assert!(ids.contains(&f.grandpa));
        assert!(ids.contains(&f.grandma));
        // grandparents on the mother's side are unknown placeholders
        assert!(graph.nodes.iter().any(|node| node.placeholder));
        assert!(!graph.pedigree_collapse);
    }

    fn descendant_set() -> (Uuid, Uuid, Uuid, Uuid, RelationshipSet) {
        let root = Uuid::now_v7();
        let son = Uuid::now_v7();
        let daughter = Uuid::now_v7();
        let grandchild = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        for (parent, child) in [(root, son), (root, daughter), (son, grandchild)] {
            set.push(Relationship::new(RelationshipType::ParentChild, parent, child).unwrap())
                .unwrap();
        }
        (root, son, daughter, grandchild, set)
    }

    #[test]
    fn descendants_include_children_and_grandchildren_with_gender_roles() {
        let (root, son, daughter, grandchild, set) = descendant_set();
        let graph = set.descendants_with_gender(root, 2, |person| {
            if person == son {
                Gender::Male
            } else if person == daughter {
                Gender::Female
            } else {
                Gender::Unknown
            }
        });
        assert_eq!(graph.nodes[0].person_id, root);
        assert_eq!(graph.nodes[0].role, DescendantRole::Root);
        assert_eq!(graph.nodes.len(), 4);
        assert_eq!(graph.edges.len(), 3);
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.person_id == son && node.role == DescendantRole::Son));
        assert!(graph
            .nodes
            .iter()
            .any(|node| { node.person_id == daughter && node.role == DescendantRole::Daughter }));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.person_id == grandchild && node.role == DescendantRole::Child));
        assert!(!graph.truncated);
        assert!(!graph.pedigree_collapse);
    }

    #[test]
    fn descendants_are_truncated_at_the_requested_generation() {
        let (root, _, _, _, set) = descendant_set();
        let graph = set.descendants_with_gender(root, 1, |_| Gender::Unknown);
        assert_eq!(graph.nodes.len(), 3); // root + two children
        assert!(graph.truncated);
    }

    #[test]
    fn a_child_reached_through_two_descendants_is_drawn_once() {
        let root = Uuid::now_v7();
        let left = Uuid::now_v7();
        let right = Uuid::now_v7();
        let shared = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        for (parent, child) in [(root, left), (root, right), (left, shared), (right, shared)] {
            set.push(Relationship::new(RelationshipType::ParentChild, parent, child).unwrap())
                .unwrap();
        }
        let graph = set.descendants_with_gender(root, 3, |_| Gender::Unknown);
        assert_eq!(
            graph
                .nodes
                .iter()
                .filter(|node| node.person_id == shared)
                .count(),
            1
        );
        assert!(graph.pedigree_collapse);
    }

    #[test]
    fn a_person_without_children_has_a_single_descendant_node() {
        let root = Uuid::now_v7();
        let graph =
            RelationshipSet::default().descendants_with_gender(root, 3, |_| Gender::Unknown);
        assert_eq!(graph.nodes.len(), 1);
        assert!(graph.edges.is_empty());
        assert!(!graph.truncated);
    }

    #[test]
    fn one_unknown_parent_is_a_placeholder() {
        let parent = Uuid::now_v7();
        let child = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        set.push(Relationship::new(RelationshipType::ParentChild, parent, child).unwrap())
            .unwrap();
        let graph = set.ancestors(child, 1);
        let placeholders = graph.nodes.iter().filter(|node| node.placeholder).count();
        assert_eq!(placeholders, 1);
        assert!(graph
            .nodes
            .iter()
            .all(|node| node.person_id.is_some() || node.placeholder));
    }

    #[test]
    fn pedigree_collapse_keeps_same_person_id() {
        let shared = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let child = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        set.push(Relationship::new(RelationshipType::ParentChild, shared, a).unwrap())
            .unwrap();
        set.push(Relationship::new(RelationshipType::ParentChild, shared, b).unwrap())
            .unwrap();
        set.push(Relationship::new(RelationshipType::ParentChild, a, child).unwrap())
            .unwrap();
        set.push(Relationship::new(RelationshipType::ParentChild, b, child).unwrap())
            .unwrap();
        let graph = set.ancestors(child, 2);
        assert!(graph.pedigree_collapse);
        let occurrences: Vec<&AncestorNode> = graph
            .nodes
            .iter()
            .filter(|node| node.person_id == Some(shared))
            .collect();
        assert_eq!(occurrences.len(), 2);
        assert_ne!(occurrences[0].occurrence_key, occurrences[1].occurrence_key);
    }

    #[test]
    fn ancestors_never_include_siblings() {
        let parent = Uuid::now_v7();
        let child = Uuid::now_v7();
        let sibling = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        set.push(Relationship::new(RelationshipType::ParentChild, parent, child).unwrap())
            .unwrap();
        set.push(Relationship::new(RelationshipType::ParentChild, parent, sibling).unwrap())
            .unwrap();
        let graph = set.ancestors(child, 3);
        assert!(!graph
            .nodes
            .iter()
            .any(|node| node.person_id == Some(sibling)));
    }
}
