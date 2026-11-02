use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::relationship::RelationshipSet;

/// Maximum number of alternative routes attached to a [`PathResult`].
pub const MAX_ALTERNATIVES: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EdgeDirection {
    Up,
    Down,
    Spouse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStep {
    pub person_id: Uuid,
    pub edge_to_next: Option<EdgeDirection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResult {
    pub found: bool,
    pub path: Vec<PathStep>,
    pub length: usize,
    pub common_ancestor_id: Option<Uuid>,
    pub spouse_edges: usize,
    /// Up to [`MAX_ALTERNATIVES`] other routes between the same two people,
    /// nearest first. Never nested: every entry has an empty `alternatives`.
    #[serde(default)]
    pub alternatives: Vec<PathResult>,
}

type Cost = (u32, u32, Vec<Uuid>);

impl RelationshipSet {
    /// BFS/Dijkstra over parent, child and spouse edges. Tie-break: fewer spouse
    /// edges, then fewer nodes, then lexicographically smaller personId path.
    /// Alternatives are found by banning one edge of the primary route at a
    /// time; the primary route itself is never replaced. See ADR-0011.
    pub fn find_path(&self, from: Uuid, to: Uuid) -> PathResult {
        let mut primary = self.find_primary_path(from, to);
        if primary.found && primary.length > 0 {
            primary.alternatives = self.alternative_paths(from, to, &primary);
        }
        primary
    }

    /// The same search without the alternative routes; used by `kinship`, which
    /// only needs the shortest chain.
    pub(crate) fn find_primary_path(&self, from: Uuid, to: Uuid) -> PathResult {
        match self.shortest_path(from, to, None) {
            Some((nodes, spouses)) => self.result_from_nodes(from, to, nodes, spouses),
            None => PathResult {
                found: false,
                path: Vec::new(),
                length: 0,
                common_ancestor_id: None,
                spouse_edges: 0,
                alternatives: Vec::new(),
            },
        }
    }

    /// One Dijkstra run per edge of the primary route. Results are deduplicated
    /// by their node sequence, sorted by length and capped at two.
    fn alternative_paths(&self, from: Uuid, to: Uuid, primary: &PathResult) -> Vec<PathResult> {
        let main = node_ids(&primary.path);
        let mut seen: Vec<Vec<Uuid>> = vec![main.clone()];
        let mut alternatives: Vec<PathResult> = Vec::new();
        for pair in main.windows(2) {
            let banned = (pair[0], pair[1]);
            let Some((nodes, spouses)) = self.shortest_path(from, to, Some(banned)) else {
                continue;
            };
            if seen.contains(&nodes) {
                continue;
            }
            seen.push(nodes.clone());
            alternatives.push(self.result_from_nodes(from, to, nodes, spouses));
        }
        alternatives
            .sort_by_key(|result| (result.length, result.spouse_edges, node_ids(&result.path)));
        alternatives.truncate(MAX_ALTERNATIVES);
        alternatives
    }

    fn result_from_nodes(
        &self,
        from: Uuid,
        to: Uuid,
        nodes: Vec<Uuid>,
        spouses: u32,
    ) -> PathResult {
        let length = nodes.len().saturating_sub(1);
        let path = nodes
            .iter()
            .enumerate()
            .map(|(index, person)| PathStep {
                person_id: *person,
                edge_to_next: nodes
                    .get(index + 1)
                    .map(|next| self.direction(*person, *next)),
            })
            .collect::<Vec<_>>();
        PathResult {
            found: true,
            path,
            length,
            common_ancestor_id: self.common_ancestor(from, to),
            spouse_edges: spouses as usize,
            alternatives: Vec::new(),
        }
    }

    /// Shortest route, optionally ignoring one undirected edge.
    fn shortest_path(
        &self,
        from: Uuid,
        to: Uuid,
        banned: Option<(Uuid, Uuid)>,
    ) -> Option<(Vec<Uuid>, u32)> {
        let mut best: HashMap<Uuid, Cost> = HashMap::new();
        let start: Cost = (0, 0, vec![from]);
        best.insert(from, start.clone());
        let mut heap: BinaryHeap<Reverse<Cost>> = BinaryHeap::from(vec![Reverse(start)]);

        while let Some(Reverse((hops, spouses, path))) = heap.pop() {
            let current = *path.last().expect("path is never empty");
            if current == to {
                return Some((path, spouses));
            }
            if best
                .get(&current)
                .is_some_and(|known| known < &(hops, spouses, path.clone()))
            {
                continue;
            }

            for (neighbour, direction) in self.neighbours(current) {
                if is_banned(banned, current, neighbour) {
                    continue;
                }
                let next_cost = (
                    hops + 1,
                    spouses + u32::from(direction == EdgeDirection::Spouse),
                    {
                        let mut next = path.clone();
                        next.push(neighbour);
                        next
                    },
                );
                let improve = match best.get(&neighbour) {
                    Some(known) => next_cost < *known,
                    None => true,
                };
                if improve {
                    best.insert(neighbour, next_cost.clone());
                    heap.push(Reverse(next_cost));
                }
            }
        }

        None
    }

    fn neighbours(&self, person: Uuid) -> Vec<(Uuid, EdgeDirection)> {
        let mut out = Vec::new();
        for (parent, _) in self.parents_of(person) {
            out.push((parent, EdgeDirection::Up));
        }
        for child in self.children_of(person) {
            out.push((child, EdgeDirection::Down));
        }
        for spouse in self.spouses_of(person) {
            out.push((spouse, EdgeDirection::Spouse));
        }
        out.sort_by_key(|(id, _)| *id);
        out
    }

    fn direction(&self, from: Uuid, to: Uuid) -> EdgeDirection {
        if self.parents_of(from).iter().any(|(id, _)| *id == to) {
            EdgeDirection::Up
        } else if self.children_of(from).contains(&to) {
            EdgeDirection::Down
        } else {
            EdgeDirection::Spouse
        }
    }

    /// Closest common ancestor by (sum of depths, max depth, id).
    pub fn common_ancestor(&self, a: Uuid, b: Uuid) -> Option<Uuid> {
        let left = self.ancestor_depths(a);
        let right = self.ancestor_depths(b);
        left.iter()
            .filter_map(|(person, depth)| {
                right.get(person).map(|other| {
                    let sum = depth + other;
                    let max = (*depth).max(*other);
                    (*person, sum, max)
                })
            })
            .min_by_key(|(person, sum, max)| (*sum, *max, *person))
            .map(|(person, _, _)| person)
    }
}

fn node_ids(path: &[PathStep]) -> Vec<Uuid> {
    path.iter().map(|step| step.person_id).collect()
}

fn is_banned(banned: Option<(Uuid, Uuid)>, from: Uuid, to: Uuid) -> bool {
    banned.is_some_and(|(a, b)| (from == a && to == b) || (from == b && to == a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relationship::{Relationship, RelationshipType};

    fn edge(set: &mut RelationshipSet, kind: RelationshipType, a: Uuid, b: Uuid) {
        set.push(Relationship::new(kind, a, b).unwrap()).unwrap();
    }

    #[test]
    fn siblings_path_goes_through_parent() {
        let parent = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, parent, a);
        edge(&mut set, RelationshipType::ParentChild, parent, b);
        let result = set.find_path(a, b);
        assert!(result.found);
        assert_eq!(result.length, 2);
        assert_eq!(result.common_ancestor_id, Some(parent));
        assert_eq!(result.path[0].edge_to_next, Some(EdgeDirection::Up));
        assert_eq!(result.path[1].edge_to_next, Some(EdgeDirection::Down));
    }

    #[test]
    fn shortest_path_wins_before_spouse_tiebreak() {
        let parent = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, parent, a);
        edge(&mut set, RelationshipType::ParentChild, parent, b);
        edge(&mut set, RelationshipType::Spouse, a, b);
        let result = set.find_path(a, b);
        // one hop through the marriage beats two hops through the parent
        assert_eq!(result.length, 1);
        assert_eq!(result.spouse_edges, 1);
    }

    #[test]
    fn equal_length_prefers_fewer_spouse_edges() {
        let parent = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let via = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, parent, a);
        edge(&mut set, RelationshipType::ParentChild, parent, b);
        edge(&mut set, RelationshipType::Spouse, a, via);
        edge(&mut set, RelationshipType::Spouse, via, b);
        let result = set.find_path(a, b);
        assert_eq!(result.length, 2);
        assert_eq!(result.spouse_edges, 0);
        assert_eq!(result.path[1].person_id, parent);
    }

    #[test]
    fn no_path_is_reported() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let set = RelationshipSet::default();
        let result = set.find_path(a, b);
        assert!(!result.found);
        assert!(result.path.is_empty());
        assert!(result.alternatives.is_empty());
    }

    #[test]
    fn deterministic_repeat() {
        let parent = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, parent, a);
        edge(&mut set, RelationshipType::ParentChild, parent, b);
        let first = set.find_path(a, b);
        let second = set.find_path(a, b);
        assert_eq!(node_ids(&first.path), node_ids(&second.path));
        assert_eq!(first.alternatives, second.alternatives);
    }

    #[test]
    fn single_route_has_no_alternatives() {
        let parent = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, parent, a);
        edge(&mut set, RelationshipType::ParentChild, parent, b);
        let result = set.find_path(a, b);
        assert_eq!(result.length, 2);
        assert!(result.alternatives.is_empty());
    }

    /// Deterministic ids: `Ord` follows the numeric order, unlike `now_v7`.
    fn id(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    #[test]
    fn second_route_is_reported_without_replacing_the_primary_one() {
        let (a, b) = (id(1), id(2));
        let first = id(10);
        let alternate = id(20);
        let mut set = RelationshipSet::default();
        edge(&mut set, RelationshipType::ParentChild, first, a);
        edge(&mut set, RelationshipType::ParentChild, first, b);
        edge(&mut set, RelationshipType::ParentChild, alternate, a);
        edge(&mut set, RelationshipType::ParentChild, alternate, b);

        let result = set.find_path(a, b);
        assert_eq!(result.length, 2);
        // The lexicographically smaller route stays primary.
        assert_eq!(node_ids(&result.path), vec![a, first, b]);
        assert_eq!(result.alternatives.len(), 1);
        assert_eq!(
            node_ids(&result.alternatives[0].path),
            vec![a, alternate, b]
        );
        assert_eq!(result.alternatives[0].length, result.length);
        assert!(result.alternatives[0].alternatives.is_empty());
        // The primary route is untouched by the alternative search.
        assert_eq!(node_ids(&set.find_path(a, b).path), vec![a, first, b]);
    }

    #[test]
    fn alternatives_are_capped_and_sorted_by_length() {
        let (a, b) = (id(1), id(2));
        let (p1, p2, q) = (id(10), id(20), id(30));
        let (r1, r2, r3) = (id(40), id(50), id(60));
        let mut set = RelationshipSet::default();
        // Primary: a — p1 — p2 — b (3 hops, smallest ids on the first hop).
        edge(&mut set, RelationshipType::ParentChild, a, p1);
        edge(&mut set, RelationshipType::ParentChild, p1, p2);
        edge(&mut set, RelationshipType::ParentChild, b, p2);
        // Shorter alternative that reuses the tail p2 — b.
        edge(&mut set, RelationshipType::ParentChild, q, a);
        edge(&mut set, RelationshipType::ParentChild, q, p2);
        // Long alternative that reuses the head a — p1.
        edge(&mut set, RelationshipType::ParentChild, r1, p1);
        edge(&mut set, RelationshipType::ParentChild, r1, r2);
        edge(&mut set, RelationshipType::ParentChild, r2, r3);
        edge(&mut set, RelationshipType::ParentChild, r3, b);

        let result = set.find_path(a, b);
        assert_eq!(result.length, 3);
        assert_eq!(node_ids(&result.path), vec![a, p1, p2, b]);
        assert_eq!(result.alternatives.len(), MAX_ALTERNATIVES);
        assert_eq!(node_ids(&result.alternatives[0].path), vec![a, q, p2, b]);
        assert_eq!(result.alternatives[0].length, 3);
        assert_eq!(
            node_ids(&result.alternatives[1].path),
            vec![a, p1, r1, r2, r3, b]
        );
        assert_eq!(result.alternatives[1].length, 5);
        assert!(result
            .alternatives
            .iter()
            .all(|item| item.alternatives.is_empty()));
        assert!(result
            .alternatives
            .windows(2)
            .all(|pair| pair[0].length <= pair[1].length));
    }
}
