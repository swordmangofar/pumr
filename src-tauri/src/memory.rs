//! pumr's memory: lasting preferences of the user about how they like to
//! work ("ask me for every finding whether to fix it"). What is remembered is
//! sent to the agent with every chat, in every project.
//!
//! The agent proposes an entry with the `remember` tool. The call never
//! waits: it leaves a suggestion on its session, and once the turn is over
//! the chat shows it on a card the user answers with "Remember", "No thanks"
//! or "Don't ask again". Nothing reaches the memory without that yes, or
//! without the user typing it into the settings themselves, so a page or a
//! file that talks the model into calling the tool gets no further than a
//! card showing its text.
//!
//! How often the user is asked is decided here and not by the model. An
//! *ask* is a call that put a card into a chat. What the agent proposes on
//! its own account passes once per chat, and only after a pause since the
//! newest ask: a day, doubled for every ask since the last save that was not
//! saved, up to thirty days. What the user asked to have remembered skips
//! both, until one such suggestion was turned down or three of them wait for
//! an answer: a model that claims a request falsely loses the claim with the
//! first "No thanks".
//!
//! The tool is offered whenever the memory is on, whatever the pause, so the
//! tool list and with it the provider's prompt cache stay as they are.

use crate::db::{new_id, now_ms, Db};
use crate::tools::ToolOutcome;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const TOOL: &str = "remember";

/// An entry is at most this many characters.
pub const MAX_CHARS: usize = 300;
/// The prompt carries at most this many entries, and the agent proposes none
/// beyond them.
pub const MAX_ENTRIES: usize = 30;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const LONGEST_PAUSE_MS: i64 = 30 * DAY_MS;
/// Suggestions the user asked for that may wait for an answer at once.
const REQUESTS_WAITING: usize = 3;
/// Share of their words two texts have in common from which they count as
/// saying the same.
const ALIKE: f64 = 0.6;

const SHOWN: &str = "Noted. Nothing is saved yet: pumr asks the user after your answer whether to keep it. Carry on with the task and do not say that it is remembered.";
const HELD_BACK: &str = "Not now: pumr asks about preferences only now and then. Carry on, and call remember again in this chat only when the user asks you to remember something. If they did ask this time, tell them they can add it under Settings > Memory.";
const KNOWN: &str = "This is already remembered, so there is nothing to save.";
const DECLINED: &str = "The user declined to have this remembered. Do not propose it again. What they asked for in this chat still applies here.";
const FULL: &str = "pumr's memory is full, so this was not proposed. If the user asked for it, tell them they can make room under Settings > Memory.";

/// One remembered preference.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryEntry {
    pub id: String,
    pub text: String,
}

/// The memory's part of the settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemorySettings {
    /// Whether what is remembered is sent to the agent at all. Off, the
    /// entries are kept and the `remember` tool is not offered.
    pub memory_enabled: bool,
    /// Whether the agent may propose entries on its own account. Off, it
    /// still takes what the user asks it to remember.
    pub memory_suggestions: bool,
    pub memories: Vec<MemoryEntry>,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            memory_enabled: true,
            memory_suggestions: true,
            memories: Vec::new(),
        }
    }
}

/// A preference the agent proposed and the user has not decided on yet. It
/// stays with its session (`sessions.memory_suggestions`) until it is
/// answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySuggestion {
    /// The ask it belongs to (`memory_asks.id`).
    pub id: i64,
    pub text: String,
    /// The user asked for it, as far as the agent says. The card shows which.
    #[serde(default)]
    pub requested: bool,
    /// The entry it corrects, when it names one.
    #[serde(default)]
    pub replaces: Option<MemoryEntry>,
    pub created_at: i64,
}

/// What a turn's agent is offered of the memory: the `remember` tool.
#[derive(Debug, Clone)]
pub struct Offer {
    /// The agent may propose on its own account, not only when asked to.
    pub suggestions: bool,
    /// What is remembered already.
    pub entries: Vec<MemoryEntry>,
}

/// How the user answered a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Saved,
    Declined,
    /// "Don't ask again": the suggestions were switched off with it.
    Disabled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Saved => "saved",
            Outcome::Declined => "declined",
            Outcome::Disabled => "disabled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "saved" => Some(Outcome::Saved),
            "declined" => Some(Outcome::Declined),
            "disabled" => Some(Outcome::Disabled),
            _ => None,
        }
    }
}

/// One time the user was asked: a `remember` call that put a card into a
/// chat (a row of `memory_asks`).
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub id: i64,
    pub created_at: i64,
    pub conversation_id: String,
    pub text: String,
    pub requested: bool,
    /// `None` while the card waits for an answer.
    pub outcome: Option<Outcome>,
    pub resolved_at: Option<i64>,
}

/// What becomes of a proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The user is asked.
    Ask,
    /// The user was asked not long ago, or in this chat before.
    NotNow,
    /// The user said no to this before.
    Declined,
}

/// The text of an entry as it is stored and shown: one line, without
/// characters that cannot be seen, and no longer than an entry may be.
pub fn tidy(text: &str) -> String {
    visible(text)
        .chars()
        .take(MAX_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// `text` on one line and without what cannot be seen, at its full length.
fn visible(text: &str) -> String {
    let seen: String = text
        .chars()
        .filter(|c| !invisible(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    seen.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Characters a model reads and a person does not see: the tag block, which
/// spells out ASCII invisibly, the controls that make text display in another
/// order than it is stored in, and zero-width fillers. The two joiners stay:
/// Persian and the Indic scripts spell words with them, and emoji are built
/// from them.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{200B}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// Tidies the entries the settings are saved with: the user edits them as
/// free text, and a settings file can be written by hand.
pub fn tidy_entries(entries: &mut Vec<MemoryEntry>) {
    for entry in entries.iter_mut() {
        entry.text = tidy(&entry.text);
        if entry.id.trim().is_empty() {
            entry.id = new_id();
        }
    }
    entries.retain(|entry| !entry.text.is_empty());
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether two texts are the same but for case, spacing and punctuation.
pub fn same(a: &str, b: &str) -> bool {
    let a = words(a);
    !a.is_empty() && a == words(b)
}

/// Whether two texts say the same in mostly the same words. This goes by
/// wording, not by meaning: a preference put quite differently is not
/// recognised, and one that only adds a "never" is.
pub fn alike(a: &str, b: &str) -> bool {
    let a: BTreeSet<String> = words(a).into_iter().collect();
    let b: BTreeSet<String> = words(b).into_iter().collect();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let shared = a.intersection(&b).count() as f64;
    let all = a.union(&b).count() as f64;
    shared / all >= ALIKE
}

/// How long after the newest ask the agent proposes nothing on its own
/// account, given how many asks since the last save were not saved.
pub fn pause_ms(unsaved: usize) -> i64 {
    DAY_MS
        .saturating_mul(1 << unsaved.min(10))
        .min(LONGEST_PAUSE_MS)
}

/// Whether a proposal may be put to the user at `now`, going by the `asks`
/// made so far (see the module's rules).
pub fn may_ask(
    now: i64,
    asks: &[Ask],
    conversation_id: &str,
    text: &str,
    requested: bool,
) -> Verdict {
    // A card can be answered long after it was shown, so a save counts from
    // when it was made.
    let saved_at = asks
        .iter()
        .filter(|ask| ask.outcome == Some(Outcome::Saved))
        .map(|ask| ask.resolved_at.unwrap_or(ask.created_at))
        .max()
        .unwrap_or(i64::MIN);
    let unsaved: Vec<&Ask> = asks
        .iter()
        .filter(|ask| ask.outcome != Some(Outcome::Saved) && ask.created_at > saved_at)
        .collect();

    if requested {
        let turned_down = unsaved
            .iter()
            .any(|ask| ask.requested && ask.outcome.is_some());
        let waiting = unsaved
            .iter()
            .filter(|ask| ask.requested && ask.outcome.is_none())
            .count();
        if !turned_down && waiting < REQUESTS_WAITING {
            return Verdict::Ask;
        }
    }

    if asks
        .iter()
        .any(|ask| ask.outcome == Some(Outcome::Declined) && alike(&ask.text, text))
    {
        return Verdict::Declined;
    }
    let asked_here = asks
        .iter()
        .any(|ask| !ask.requested && ask.conversation_id == conversation_id);
    let rested = asks
        .iter()
        .map(|ask| ask.created_at)
        .max()
        .is_none_or(|newest| now - newest >= pause_ms(unsaved.len()));
    if asked_here || !rested {
        Verdict::NotNow
    } else {
        Verdict::Ask
    }
}

/// The schema of the `remember` tool. Without `suggestions` the agent is
/// only to pass on what the user asks to have remembered.
pub fn schema(suggestions: bool) -> Value {
    let mut properties = json!({
        "preference": { "type": "string", "description": "One instruction to yourself in the user's language that makes sense without this chat. At most 300 characters." },
        "replaces": { "type": "string", "description": "The remembered preference this one corrects, word for word." }
    });
    let description = if suggestions {
        properties["requested"] = json!({ "type": "boolean", "description": "true only when the user asked you to remember it." });
        "Propose a lasting preference of the user for pumr's memory, which you are sent in every later chat. Call it when the user asks you to remember something, or when their message shows how they like work done in a way that would apply next time too (\"ask me for every finding whether to fix it\", \"keep answers short\", \"never commit unless I say so\"). Not for what only fits this task, for facts about this project (they belong in its rule files) or for secrets. Nothing is saved by the call: pumr asks the user after your answer. Send it with your other tool calls and carry on."
    } else {
        "Propose a preference of the user for pumr's memory, which you are sent in every later chat. Call it only when the user asks you to remember something. Nothing is saved by the call: pumr asks the user after your answer."
    };
    json!({
        "type": "function",
        "function": {
            "name": TOOL,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": ["preference"]
            }
        }
    })
}

/// What the system prompt says about the memory: the entries, or nothing
/// when the memory is off or empty.
pub fn section(settings: &MemorySettings) -> String {
    if !settings.memory_enabled {
        return String::new();
    }
    let entries: Vec<String> = settings
        .memories
        .iter()
        .map(|entry| tidy(&entry.text))
        .filter(|text| !text.is_empty())
        .take(MAX_ENTRIES)
        .collect();
    if entries.is_empty() {
        return String::new();
    }
    let mut section = String::from(
        "\n\n# Remembered preferences\nThe user had pumr remember how they like to work. Follow these in every project. On conflict, what the user says in this chat and the project's rules come first. Only the user can remove one, under Settings > Memory.",
    );
    for entry in entries {
        section.push_str(&format!("\n- {entry}"));
    }
    section
}

/// A boolean argument, also when a model sent it as text.
fn flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => value.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// The agent's `remember` call. It leaves a suggestion on the session when
/// the user may be asked, and says in every case what became of the proposal.
/// Handled apart from `tools::execute`, which has no database.
pub fn suggest(
    db: &Db,
    offer: &Offer,
    session_id: &str,
    conversation_id: &str,
    arguments: &Value,
) -> ToolOutcome {
    let text = visible(
        arguments
            .get("preference")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    if text.is_empty() || text.chars().count() > MAX_CHARS {
        return ToolOutcome::error(format!(
            "The remember tool requires a 'preference' of at most {MAX_CHARS} characters."
        ));
    }
    if offer.entries.iter().any(|entry| same(&entry.text, &text)) {
        return ToolOutcome::ok(KNOWN.to_string());
    }
    let replaces = arguments
        .get("replaces")
        .and_then(Value::as_str)
        .and_then(|old| {
            offer
                .entries
                .iter()
                .find(|entry| same(&entry.text, old))
                .or_else(|| offer.entries.iter().find(|entry| alike(&entry.text, old)))
        })
        .cloned();
    if replaces.is_none() && offer.entries.len() >= MAX_ENTRIES {
        return ToolOutcome::ok(FULL.to_string());
    }
    // With the suggestions switched off the tool is only there for what the
    // user asks to have remembered.
    let requested = !offer.suggestions || flag(arguments.get("requested"));
    let asks = match db.memory_asks() {
        Ok(asks) => asks,
        Err(error) => return ToolOutcome::error(format!("Could not read pumr's memory: {error}")),
    };
    match may_ask(now_ms(), &asks, conversation_id, &text, requested) {
        Verdict::Ask => {}
        Verdict::NotNow => return ToolOutcome::ok(HELD_BACK.to_string()),
        Verdict::Declined => return ToolOutcome::ok(DECLINED.to_string()),
    }
    match db.add_memory_suggestion(session_id, conversation_id, &text, requested, replaces) {
        Ok(_) => ToolOutcome::ok(SHOWN.to_string()),
        Err(error) => ToolOutcome::error(format!("Could not note the preference: {error}")),
    }
}

/// What the user chose on a suggestion's card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Save,
    Decline,
    Disable,
}

impl Decision {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "save" => Some(Decision::Save),
            "decline" => Some(Decision::Decline),
            "disable" => Some(Decision::Disable),
            _ => None,
        }
    }

    pub fn outcome(self) -> Outcome {
        match self {
            Decision::Save => Outcome::Saved,
            Decision::Decline => Outcome::Declined,
            Decision::Disable => Outcome::Disabled,
        }
    }
}

/// Carries out the user's answer to a card in the settings. `text` is the
/// suggestion as the user edited it on the card.
pub fn apply(
    settings: &mut MemorySettings,
    suggestion: &MemorySuggestion,
    decision: Decision,
    text: Option<&str>,
) -> std::result::Result<(), String> {
    match decision {
        Decision::Decline => {}
        Decision::Disable => settings.memory_suggestions = false,
        Decision::Save => {
            let text = tidy(text.unwrap_or(&suggestion.text));
            if text.is_empty() {
                return Err("There is nothing to remember.".to_string());
            }
            let corrected = suggestion
                .replaces
                .as_ref()
                .and_then(|old| settings.memories.iter().position(|entry| entry.id == old.id));
            match corrected {
                Some(index) => settings.memories[index].text = text,
                None if settings.memories.iter().any(|entry| same(&entry.text, &text)) => {}
                None => settings.memories.push(MemoryEntry {
                    id: new_id(),
                    text,
                }),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 60 * 60 * 1000;

    fn ask(id: i64, at: i64, chat: &str, text: &str) -> Ask {
        Ask {
            id,
            created_at: at,
            conversation_id: chat.to_string(),
            text: text.to_string(),
            requested: false,
            outcome: None,
            resolved_at: None,
        }
    }

    fn answered(mut ask: Ask, outcome: Outcome, at: i64) -> Ask {
        ask.outcome = Some(outcome);
        ask.resolved_at = Some(at);
        ask
    }

    fn requested(mut ask: Ask) -> Ask {
        ask.requested = true;
        ask
    }

    fn entry(id: &str, text: &str) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            text: text.to_string(),
        }
    }

    fn chat() -> (tempfile::TempDir, Db, String) {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("test.db")).unwrap();
        db.migrate().unwrap();
        let project = db.upsert_project("/tmp/pumr-memory").unwrap();
        let chat = db
            .create_session(&project.id, "chat", None, None, None, None, None)
            .unwrap();
        (directory, db, chat.id)
    }

    fn offer(suggestions: bool, entries: Vec<MemoryEntry>) -> Offer {
        Offer {
            suggestions,
            entries,
        }
    }

    #[test]
    fn tidying_collapses_whitespace_and_drops_what_cannot_be_seen() {
        assert_eq!(tidy("  Keep\tanswers\n\nshort. "), "Keep answers short.");
        // A zero-width space, a right-to-left override and a word spelled in
        // the tag block, which shows as nothing.
        let hidden = "Keep\u{200B} answers\u{202E} short.\u{E0072}\u{E006D}";
        assert_eq!(tidy(hidden), "Keep answers short.");
        // The joiner that holds a Persian word together stays.
        assert_eq!(tidy("می\u{200C}خواهم"), "می\u{200C}خواهم");
        assert_eq!(tidy(&"a".repeat(400)).chars().count(), MAX_CHARS);
        assert_eq!(tidy(" \n\u{200B}"), "");
    }

    #[test]
    fn saving_the_settings_tidies_the_entries() {
        let mut entries = vec![
            entry("a", " Keep answers\nshort. "),
            entry("b", "   "),
            entry("", "Never commit unless I say so."),
        ];
        tidy_entries(&mut entries);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], entry("a", "Keep answers short."));
        assert_eq!(entries[1].text, "Never commit unless I say so.");
        assert!(!entries[1].id.is_empty());
    }

    #[test]
    fn the_pause_doubles_with_every_ask_that_was_not_saved_and_stops_at_thirty_days() {
        assert_eq!(pause_ms(0), DAY_MS);
        assert_eq!(pause_ms(1), 2 * DAY_MS);
        assert_eq!(pause_ms(2), 4 * DAY_MS);
        assert_eq!(pause_ms(4), 16 * DAY_MS);
        assert_eq!(pause_ms(5), 30 * DAY_MS);
        assert_eq!(pause_ms(500), 30 * DAY_MS);

        let day = DAY_MS;
        let said_no = vec![answered(
            ask(1, 0, "a", "Keep answers short."),
            Outcome::Declined,
            HOUR_MS,
        )];
        let other = "Never commit unless I say so.";
        assert_eq!(may_ask(day, &said_no, "b", other, false), Verdict::NotNow);
        assert_eq!(may_ask(2 * day, &said_no, "b", other, false), Verdict::Ask);

        // A card nobody answered counts like a no.
        let ignored = vec![ask(1, 0, "a", "Keep answers short.")];
        assert_eq!(may_ask(day, &ignored, "b", other, false), Verdict::NotNow);
        assert_eq!(may_ask(2 * day, &ignored, "b", other, false), Verdict::Ask);

        // A save takes the pause back to a day, also when it comes late.
        let saved = vec![
            ask(2, day, "b", other),
            answered(
                ask(1, 0, "a", "Keep answers short."),
                Outcome::Saved,
                day + HOUR_MS,
            ),
        ];
        assert_eq!(
            may_ask(day + 23 * HOUR_MS, &saved, "c", "Use tabs.", false),
            Verdict::NotNow
        );
        assert_eq!(
            may_ask(2 * day, &saved, "c", "Use tabs.", false),
            Verdict::Ask
        );
    }

    #[test]
    fn the_first_proposal_is_put_to_the_user() {
        assert_eq!(
            may_ask(0, &[], "a", "Keep answers short.", false),
            Verdict::Ask
        );
    }

    #[test]
    fn a_chat_is_asked_once_but_a_request_gets_through() {
        let asks = vec![answered(
            ask(1, 0, "a", "Keep answers short."),
            Outcome::Saved,
            HOUR_MS,
        )];
        let later = 10 * DAY_MS;
        let other = "Never commit unless I say so.";
        // The pause is long over, but this chat was asked before.
        assert_eq!(may_ask(later, &asks, "a", other, false), Verdict::NotNow);
        assert_eq!(may_ask(later, &asks, "b", other, false), Verdict::Ask);
        // What the user asks for is held back by neither the chat nor the pause.
        assert_eq!(may_ask(later, &asks, "a", other, true), Verdict::Ask);
        assert_eq!(may_ask(2 * HOUR_MS, &asks, "a", other, true), Verdict::Ask);
    }

    #[test]
    fn a_request_that_was_declined_puts_the_next_one_under_the_pause() {
        let declined = vec![answered(
            requested(ask(1, 0, "a", "Keep answers short.")),
            Outcome::Declined,
            HOUR_MS,
        )];
        let other = "Never commit unless I say so.";
        assert_eq!(
            may_ask(2 * HOUR_MS, &declined, "b", other, true),
            Verdict::NotNow
        );
        assert_eq!(
            may_ask(2 * DAY_MS, &declined, "b", other, true),
            Verdict::Ask
        );

        // A save restores the claim.
        let mut saved = declined.clone();
        saved.insert(
            0,
            answered(ask(2, 3 * DAY_MS, "b", other), Outcome::Saved, 3 * DAY_MS),
        );
        assert_eq!(
            may_ask(3 * DAY_MS + HOUR_MS, &saved, "c", "Use tabs.", true),
            Verdict::Ask
        );
    }

    #[test]
    fn three_requests_waiting_for_an_answer_hold_back_the_fourth() {
        let waiting: Vec<Ask> = (1..=3)
            .map(|id| requested(ask(id, id, "a", &format!("Preference number {id}."))))
            .collect();
        assert_eq!(
            may_ask(HOUR_MS, &waiting[..2], "a", "Use tabs.", true),
            Verdict::Ask
        );
        assert_eq!(
            may_ask(HOUR_MS, &waiting, "a", "Use tabs.", true),
            Verdict::NotNow
        );
    }

    #[test]
    fn a_reworded_decline_is_recognised() {
        let declined = vec![answered(
            ask(1, 0, "a", "Ask me for every finding whether to fix or skip it."),
            Outcome::Declined,
            HOUR_MS,
        )];
        let later = 40 * DAY_MS;
        assert_eq!(
            may_ask(
                later,
                &declined,
                "b",
                "Ask for every finding whether to fix it or skip it",
                false
            ),
            Verdict::Declined
        );
        assert_eq!(
            may_ask(later, &declined, "b", "Keep answers short.", false),
            Verdict::Ask
        );
        // Asked for in so many words, it is put to the user again.
        assert_eq!(
            may_ask(
                later,
                &declined,
                "b",
                "Ask me for every finding whether to fix or skip it.",
                true
            ),
            Verdict::Ask
        );
    }

    #[test]
    fn texts_are_compared_by_their_words() {
        assert!(same("Keep answers short.", "keep  answers short"));
        assert!(!same("Keep answers short.", "Keep answers long."));
        assert!(!same("", ""));
        assert!(alike(
            "When reviewing code, ask me per finding whether to fix or skip it.",
            "When reviewing code, ask per finding whether to fix or skip it"
        ));
        assert!(!alike("Ask before committing.", "Ask before pushing."));
    }

    #[test]
    fn settings_without_memory_fields_load_with_memory_on() {
        let settings: crate::config::Settings = serde_json::from_value(json!({})).unwrap();
        assert!(settings.memory.memory_enabled);
        assert!(settings.memory.memory_suggestions);
        assert!(settings.memory.memories.is_empty());

        // The fields sit flat next to the others, as the frontend reads them.
        let mut settings = crate::config::Settings::default();
        settings.memory.memories = vec![entry("a", "Keep answers short.")];
        let stored = serde_json::to_value(&settings).unwrap();
        assert_eq!(stored["memoryEnabled"], json!(true));
        assert_eq!(stored["memorySuggestions"], json!(true));
        assert_eq!(
            stored["memories"],
            json!([{ "id": "a", "text": "Keep answers short." }])
        );
    }

    #[test]
    fn the_section_lists_the_entries_and_is_left_out_without_any() {
        let mut settings = MemorySettings::default();
        assert_eq!(section(&settings), "");
        settings.memories = vec![
            entry("a", "Keep answers short."),
            entry("b", " "),
            entry("c", "Never commit\nunless I say so."),
        ];
        let text = section(&settings);
        assert!(text.starts_with("\n\n# Remembered preferences\n"));
        assert!(text.ends_with("\n- Keep answers short.\n- Never commit unless I say so."));
        settings.memory_enabled = false;
        assert_eq!(section(&settings), "");
    }

    #[test]
    fn the_tool_asks_for_the_request_flag_only_while_it_may_propose() {
        let proposing = schema(true);
        assert_eq!(proposing["function"]["name"], "remember");
        assert_eq!(
            proposing["function"]["parameters"]["required"],
            json!(["preference"])
        );
        assert!(proposing["function"]["parameters"]["properties"]["requested"].is_object());
        let asked_only = schema(false);
        assert!(asked_only["function"]["parameters"]["properties"]["requested"].is_null());
        assert_ne!(
            proposing["function"]["description"],
            asked_only["function"]["description"]
        );
    }

    #[test]
    fn a_remember_call_leaves_a_suggestion_and_says_nothing_is_saved() {
        let (_directory, db, chat) = chat();
        let outcome = suggest(
            &db,
            &offer(true, Vec::new()),
            &chat,
            &chat,
            &json!({ "preference": "Ask me for every finding\nwhether to fix it." }),
        );
        assert_eq!(outcome.status, "ok");
        assert_eq!(outcome.result, SHOWN);

        let open = db.get_session(&chat).unwrap().memory_suggestions;
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].text, "Ask me for every finding whether to fix it.");
        assert!(!open[0].requested);
        assert_eq!(open[0].replaces, None);
        assert_eq!(db.memory_asks().unwrap().len(), 1);
    }

    #[test]
    fn a_call_that_was_held_back_does_not_move_the_pause() {
        let (_directory, db, chat) = chat();
        let memory = offer(true, Vec::new());
        suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "Keep answers short." }),
        );
        let asked = db.memory_asks().unwrap();

        // The same chat, minutes later: neither a card nor an ask.
        let again = suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "Never commit unless I say so." }),
        );
        assert_eq!(again.status, "ok");
        assert_eq!(again.result, HELD_BACK);
        assert_eq!(db.memory_asks().unwrap(), asked);
        assert_eq!(
            db.get_session(&chat).unwrap().memory_suggestions.len(),
            1
        );

        // The user asking for it gets a second card.
        let asked_for = suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "Never commit unless I say so.", "requested": "true" }),
        );
        assert_eq!(asked_for.result, SHOWN);
        let open = db.get_session(&chat).unwrap().memory_suggestions;
        assert_eq!(open.len(), 2);
        assert!(open[1].requested);
    }

    #[test]
    fn what_is_remembered_already_is_not_asked_about() {
        let (_directory, db, chat) = chat();
        let memory = offer(true, vec![entry("a", "Keep answers short.")]);
        let known = suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "keep answers short" }),
        );
        assert_eq!(known.result, KNOWN);
        assert!(db.memory_asks().unwrap().is_empty());

        // A correction names the entry it replaces.
        let corrected = suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "Keep answers to one paragraph.", "replaces": "Keep answers short." }),
        );
        assert_eq!(corrected.result, SHOWN);
        let open = db.get_session(&chat).unwrap().memory_suggestions;
        assert_eq!(open[0].replaces, Some(entry("a", "Keep answers short.")));
    }

    #[test]
    fn a_preference_that_is_missing_or_too_long_is_an_error() {
        let (_directory, db, chat) = chat();
        let memory = offer(true, Vec::new());
        for arguments in [
            json!({}),
            json!({ "preference": " \n " }),
            json!({ "preference": "a".repeat(MAX_CHARS + 1) }),
        ] {
            let outcome = suggest(&db, &memory, &chat, &chat, &arguments);
            assert_eq!(outcome.status, "error");
        }
        assert!(db.memory_asks().unwrap().is_empty());
    }

    #[test]
    fn a_full_memory_takes_corrections_only() {
        let (_directory, db, chat) = chat();
        let entries: Vec<MemoryEntry> = (0..MAX_ENTRIES)
            .map(|index| entry(&index.to_string(), &format!("Preference number {index}.")))
            .collect();
        let memory = offer(true, entries);
        let more = suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "Keep answers short." }),
        );
        assert_eq!(more.result, FULL);
        let corrected = suggest(
            &db,
            &memory,
            &chat,
            &chat,
            &json!({ "preference": "Keep answers short.", "replaces": "Preference number 3." }),
        );
        assert_eq!(corrected.result, SHOWN);
    }

    #[test]
    fn without_suggestions_every_call_counts_as_asked_for() {
        let (_directory, db, chat) = chat();
        let memory = offer(false, Vec::new());
        for text in ["Keep answers short.", "Never commit unless I say so."] {
            let outcome = suggest(&db, &memory, &chat, &chat, &json!({ "preference": text }));
            assert_eq!(outcome.result, SHOWN);
        }
        let open = db.get_session(&chat).unwrap().memory_suggestions;
        assert!(open.iter().all(|suggestion| suggestion.requested));
    }

    fn suggestion(text: &str, replaces: Option<MemoryEntry>) -> MemorySuggestion {
        MemorySuggestion {
            id: 1,
            text: text.to_string(),
            requested: false,
            replaces,
            created_at: 0,
        }
    }

    #[test]
    fn saving_stores_the_text_as_the_user_edited_it() {
        let mut settings = MemorySettings::default();
        let proposed = suggestion("Ask me for every finding.", None);
        apply(
            &mut settings,
            &proposed,
            Decision::Save,
            Some("  Ask me for every\nfinding in a review. "),
        )
        .unwrap();
        assert_eq!(settings.memories.len(), 1);
        assert_eq!(
            settings.memories[0].text,
            "Ask me for every finding in a review."
        );
        assert!(!settings.memories[0].id.is_empty());

        // The same once more adds nothing, and without an edit the proposal
        // is taken as it was.
        apply(
            &mut settings,
            &proposed,
            Decision::Save,
            Some("ask me for every finding in a review"),
        )
        .unwrap();
        assert_eq!(settings.memories.len(), 1);
        apply(&mut settings, &proposed, Decision::Save, None).unwrap();
        assert_eq!(settings.memories[1].text, "Ask me for every finding.");

        assert!(apply(&mut settings, &proposed, Decision::Save, Some("  ")).is_err());
    }

    #[test]
    fn a_correction_replaces_the_entry_it_names() {
        let mut settings = MemorySettings {
            memories: vec![
                entry("a", "Keep answers short."),
                entry("b", "Use tabs."),
            ],
            ..MemorySettings::default()
        };
        let corrected = suggestion(
            "Keep answers to one paragraph.",
            Some(entry("a", "Keep answers short.")),
        );
        apply(&mut settings, &corrected, Decision::Save, None).unwrap();
        assert_eq!(
            settings.memories,
            vec![
                entry("a", "Keep answers to one paragraph."),
                entry("b", "Use tabs.")
            ]
        );

        // The entry was removed in the meantime: the correction is added.
        let gone = suggestion("Use spaces.", Some(entry("z", "Use tabs, always.")));
        apply(&mut settings, &gone, Decision::Save, None).unwrap();
        assert_eq!(settings.memories.len(), 3);
        assert_eq!(settings.memories[2].text, "Use spaces.");
    }

    #[test]
    fn dont_ask_again_turns_suggestions_off_and_leaves_memory_on() {
        let mut settings = MemorySettings {
            memories: vec![entry("a", "Keep answers short.")],
            ..MemorySettings::default()
        };
        let proposed = suggestion("Use tabs.", None);
        apply(&mut settings, &proposed, Decision::Decline, None).unwrap();
        assert!(settings.memory_suggestions);
        apply(&mut settings, &proposed, Decision::Disable, None).unwrap();
        assert!(!settings.memory_suggestions);
        assert!(settings.memory_enabled);
        assert_eq!(settings.memories, vec![entry("a", "Keep answers short.")]);
    }
}
