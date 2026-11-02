use gentree_chat::{route, system_prompt_with_skills};

/// Locks the assembled prompt for a synthetic request. Skill files are embedded
/// individually now, but the prompt must stay equivalent to the single-document
/// catalog apart from whitespace at block boundaries.
#[test]
fn assembled_prompt_matches_the_migrated_snapshot() {
    let skills = route("Расскажи всё о Петре Сидорове");
    let prompt = system_prompt_with_skills("ru", "Synthetic project", Some("project-id"), &skills);
    assert_eq!(prompt, include_str!("snapshots/prompt.txt"));
}
