use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DeltaId {
    pub replica_id: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CausalVersion {
    pub base_digest: String,
    pub frontier: BTreeSet<DeltaId>,
}

impl CausalVersion {
    pub fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.base_digest.as_bytes());
        hasher.update([0]);
        for head in &self.frontier {
            hasher.update(head.replica_id.as_bytes());
            hasher.update([0]);
            hasher.update(head.sequence.to_be_bytes());
        }
        hex::encode(hasher.finalize())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextEdit {
    pub start_utf8: usize,
    pub end_utf8: usize,
    pub inserted_text: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Attribution {
    pub actor_id: String,
    pub agent_id: String,
    pub run_id: String,
    pub prompt_message_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextDelta {
    pub id: DeltaId,
    pub based_on: CausalVersion,
    pub edits: Vec<TextEdit>,
    pub attribution: Attribution,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
enum ElementId {
    Base(u64),
    Insert {
        delta: DeltaId,
        edit_index: u32,
        char_index: u32,
    },
}

#[derive(Clone, Debug)]
struct Insertion {
    after: Option<ElementId>,
    chars: Vec<(ElementId, char)>,
}

#[derive(Clone, Debug)]
struct NormalizedDelta {
    parents: BTreeSet<DeltaId>,
    deletions: Vec<ElementId>,
    insertions: Vec<Insertion>,
}

#[derive(Clone, Debug)]
struct Node {
    character: char,
    continuation: Option<ElementId>,
    branches: BTreeSet<ElementId>,
}

#[derive(Clone, Debug)]
struct Materialized {
    text: String,
    visible: Vec<ElementId>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DocumentError {
    #[error("replica id cannot be empty")]
    EmptyReplicaId,
    #[error("delta sequence must be greater than zero")]
    InvalidSequence,
    #[error("delta id already exists with different contents")]
    DeltaConflict,
    #[error("delta references a different Git base")]
    BaseMismatch,
    #[error("delta references an unknown causal parent")]
    UnknownParent,
    #[error("edit ranges must be ordered and non-overlapping")]
    OverlappingEdits,
    #[error("edit range is outside the based-on document")]
    RangeOutOfBounds,
    #[error("edit range does not land on UTF-8 boundaries")]
    InvalidUtf8Boundary,
    #[error("causal graph contains a cycle")]
    CausalCycle,
    #[error("internal fragment reference is missing")]
    MissingFragment,
}

#[derive(Clone, Debug)]
pub struct AppliedDelta {
    pub version: CausalVersion,
    pub text: String,
    pub duplicate: bool,
}

#[derive(Clone, Debug)]
pub struct DocumentState {
    base_digest: String,
    base_text: String,
    frontier: BTreeSet<DeltaId>,
    source_deltas: BTreeMap<DeltaId, TextDelta>,
    deltas: BTreeMap<DeltaId, NormalizedDelta>,
}

impl DocumentState {
    pub fn new(base_digest: impl Into<String>, base_text: impl Into<String>) -> Self {
        Self {
            base_digest: base_digest.into(),
            base_text: base_text.into(),
            frontier: BTreeSet::new(),
            source_deltas: BTreeMap::new(),
            deltas: BTreeMap::new(),
        }
    }

    pub fn current_version(&self) -> CausalVersion {
        CausalVersion {
            base_digest: self.base_digest.clone(),
            frontier: self.frontier.clone(),
        }
    }

    pub fn current_text(&self) -> Result<String, DocumentError> {
        Ok(self.materialize(&self.frontier)?.text)
    }

    pub fn delta_count(&self) -> usize {
        self.deltas.len()
    }

    pub fn submit(&mut self, delta: TextDelta) -> Result<AppliedDelta, DocumentError> {
        if delta.id.replica_id.is_empty() {
            return Err(DocumentError::EmptyReplicaId);
        }
        if delta.id.sequence == 0 {
            return Err(DocumentError::InvalidSequence);
        }
        if delta.based_on.base_digest != self.base_digest {
            return Err(DocumentError::BaseMismatch);
        }

        if let Some(existing) = self.source_deltas.get(&delta.id) {
            if existing == &delta {
                return Ok(AppliedDelta {
                    version: self.current_version(),
                    text: self.current_text()?,
                    duplicate: true,
                });
            }
            return Err(DocumentError::DeltaConflict);
        }

        if delta
            .based_on
            .frontier
            .iter()
            .any(|parent| !self.deltas.contains_key(parent))
        {
            return Err(DocumentError::UnknownParent);
        }

        validate_edits(&delta.edits)?;
        let based_on = self.materialize(&delta.based_on.frontier)?;
        let normalized = self.normalize(&delta, &based_on)?;

        self.frontier
            .retain(|head| !delta.based_on.frontier.contains(head));
        self.frontier.insert(delta.id.clone());
        self.deltas.insert(delta.id.clone(), normalized);
        self.source_deltas.insert(delta.id.clone(), delta);

        Ok(AppliedDelta {
            version: self.current_version(),
            text: self.current_text()?,
            duplicate: false,
        })
    }

    fn normalize(
        &self,
        delta: &TextDelta,
        based_on: &Materialized,
    ) -> Result<NormalizedDelta, DocumentError> {
        let boundaries = utf8_boundaries(&based_on.text);
        let mut deletions = Vec::new();
        let mut insertions = Vec::new();

        for (edit_index, edit) in delta.edits.iter().enumerate() {
            if edit.end_utf8 > based_on.text.len() {
                return Err(DocumentError::RangeOutOfBounds);
            }
            let start_index = boundaries
                .binary_search(&edit.start_utf8)
                .map_err(|_| DocumentError::InvalidUtf8Boundary)?;
            let end_index = boundaries
                .binary_search(&edit.end_utf8)
                .map_err(|_| DocumentError::InvalidUtf8Boundary)?;

            deletions.extend_from_slice(&based_on.visible[start_index..end_index]);
            let after = start_index
                .checked_sub(1)
                .map(|index| based_on.visible[index].clone());
            let chars = edit
                .inserted_text
                .chars()
                .enumerate()
                .map(|(char_index, character)| {
                    (
                        ElementId::Insert {
                            delta: delta.id.clone(),
                            edit_index: edit_index as u32,
                            char_index: char_index as u32,
                        },
                        character,
                    )
                })
                .collect();
            insertions.push(Insertion { after, chars });
        }

        Ok(NormalizedDelta {
            parents: delta.based_on.frontier.clone(),
            deletions,
            insertions,
        })
    }

    fn causal_closure(
        &self,
        frontier: &BTreeSet<DeltaId>,
    ) -> Result<BTreeSet<DeltaId>, DocumentError> {
        let mut closure = BTreeSet::new();
        let mut stack: Vec<_> = frontier.iter().cloned().collect();
        while let Some(id) = stack.pop() {
            let Some(delta) = self.deltas.get(&id) else {
                return Err(DocumentError::UnknownParent);
            };
            if closure.insert(id) {
                stack.extend(delta.parents.iter().cloned());
            }
        }
        Ok(closure)
    }

    fn materialize(&self, frontier: &BTreeSet<DeltaId>) -> Result<Materialized, DocumentError> {
        let closure = self.causal_closure(frontier)?;
        let mut nodes = HashMap::<ElementId, Node>::new();
        let mut root_continuation = None;
        let mut root_branches = BTreeSet::new();

        let mut previous = None;
        for (byte_offset, character) in self.base_text.char_indices() {
            let id = ElementId::Base(byte_offset as u64);
            nodes.insert(
                id.clone(),
                Node {
                    character,
                    continuation: None,
                    branches: BTreeSet::new(),
                },
            );
            if let Some(previous_id) = previous {
                let previous_node = nodes
                    .get_mut(&previous_id)
                    .ok_or(DocumentError::MissingFragment)?;
                previous_node.continuation = Some(id.clone());
            } else {
                root_continuation = Some(id.clone());
            }
            previous = Some(id);
        }

        let mut pending = closure;
        let mut applied = BTreeSet::new();
        let mut deleted = HashSet::new();
        while !pending.is_empty() {
            let ready = pending
                .iter()
                .find(|id| {
                    self.deltas
                        .get(*id)
                        .is_some_and(|delta| delta.parents.is_subset(&applied))
                })
                .cloned()
                .ok_or(DocumentError::CausalCycle)?;
            let delta = self
                .deltas
                .get(&ready)
                .ok_or(DocumentError::UnknownParent)?;

            deleted.extend(delta.deletions.iter().cloned());
            for insertion in &delta.insertions {
                let Some((first_id, _)) = insertion.chars.first() else {
                    continue;
                };
                if let Some(after) = &insertion.after {
                    nodes
                        .get_mut(after)
                        .ok_or(DocumentError::MissingFragment)?
                        .branches
                        .insert(first_id.clone());
                } else {
                    root_branches.insert(first_id.clone());
                }

                for (index, (id, character)) in insertion.chars.iter().enumerate() {
                    let continuation = insertion
                        .chars
                        .get(index + 1)
                        .map(|(next_id, _)| next_id.clone());
                    nodes.insert(
                        id.clone(),
                        Node {
                            character: *character,
                            continuation,
                            branches: BTreeSet::new(),
                        },
                    );
                }
            }

            pending.remove(&ready);
            applied.insert(ready);
        }

        let mut text = String::new();
        let mut visible = Vec::new();
        for branch in root_branches {
            render_element(&branch, &nodes, &deleted, &mut text, &mut visible)?;
        }
        if let Some(base) = root_continuation {
            render_element(&base, &nodes, &deleted, &mut text, &mut visible)?;
        }

        Ok(Materialized { text, visible })
    }
}

fn render_element(
    id: &ElementId,
    nodes: &HashMap<ElementId, Node>,
    deleted: &HashSet<ElementId>,
    text: &mut String,
    visible: &mut Vec<ElementId>,
) -> Result<(), DocumentError> {
    let node = nodes.get(id).ok_or(DocumentError::MissingFragment)?;
    if !deleted.contains(id) {
        text.push(node.character);
        visible.push(id.clone());
    }
    for branch in &node.branches {
        render_element(branch, nodes, deleted, text, visible)?;
    }
    if let Some(continuation) = &node.continuation {
        render_element(continuation, nodes, deleted, text, visible)?;
    }
    Ok(())
}

fn utf8_boundaries(text: &str) -> Vec<usize> {
    let mut boundaries: Vec<_> = text.char_indices().map(|(index, _)| index).collect();
    boundaries.push(text.len());
    boundaries
}

fn validate_edits(edits: &[TextEdit]) -> Result<(), DocumentError> {
    let mut previous_end = 0;
    for (index, edit) in edits.iter().enumerate() {
        if edit.start_utf8 > edit.end_utf8 {
            return Err(DocumentError::RangeOutOfBounds);
        }
        if index > 0 && edit.start_utf8 < previous_end {
            return Err(DocumentError::OverlappingEdits);
        }
        previous_end = edit.end_utf8;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(replica: &str, sequence: u64) -> DeltaId {
        DeltaId {
            replica_id: replica.to_owned(),
            sequence,
        }
    }

    fn version(base: &str, heads: &[DeltaId]) -> CausalVersion {
        CausalVersion {
            base_digest: base.to_owned(),
            frontier: heads.iter().cloned().collect(),
        }
    }

    fn delta(
        replica: &str,
        sequence: u64,
        based_on: CausalVersion,
        start: usize,
        end: usize,
        text: &str,
    ) -> TextDelta {
        TextDelta {
            id: id(replica, sequence),
            based_on,
            edits: vec![TextEdit {
                start_utf8: start,
                end_utf8: end,
                inserted_text: text.to_owned(),
            }],
            attribution: Attribution::default(),
        }
    }

    #[test]
    fn applies_utf8_edits() {
        let mut document = DocumentState::new("git-a", "hello 世界");
        document
            .submit(delta("a", 1, version("git-a", &[]), 6, 12, "武当"))
            .unwrap();
        assert_eq!(document.current_text().unwrap(), "hello 武当");
    }

    #[test]
    fn concurrent_inserts_converge_in_any_arrival_order() {
        let base = version("git-a", &[]);
        let a = delta("a", 1, base.clone(), 0, 0, "REA");
        let b = delta("b", 1, base, 0, 0, "C");

        let mut left = DocumentState::new("git-a", "TIVITY");
        left.submit(a.clone()).unwrap();
        left.submit(b.clone()).unwrap();

        let mut right = DocumentState::new("git-a", "TIVITY");
        right.submit(b).unwrap();
        right.submit(a).unwrap();

        assert_eq!(left.current_text().unwrap(), right.current_text().unwrap());
        assert_eq!(left.current_text().unwrap(), "REACTIVITY");
    }

    #[test]
    fn deletion_does_not_remove_unseen_concurrent_insert() {
        let base = version("git-a", &[]);
        let delete = delta("a", 1, base.clone(), 0, 1, "");
        let insert = delta("b", 1, base, 0, 0, "X");

        let mut document = DocumentState::new("git-a", "A");
        document.submit(delete).unwrap();
        document.submit(insert).unwrap();

        assert_eq!(document.current_text().unwrap(), "X");
    }

    #[test]
    fn rejects_non_utf8_boundary() {
        let mut document = DocumentState::new("git-a", "🙂");
        let error = document
            .submit(delta("a", 1, version("git-a", &[]), 1, 1, "x"))
            .unwrap_err();
        assert_eq!(error, DocumentError::InvalidUtf8Boundary);
    }
}
