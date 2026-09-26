//! Splits one shell command segment into words while keeping track of what the
//! shell expands at run time.
//!
//! `shell_words::split` only removes quotes: `cat "$HOME"/.ssh/id_rsa` stays the
//! literal text `$HOME/.ssh/id_rsa`, and `$(…)` is cut apart at its spaces. The
//! permission checks need to know which parts of a word are parameters,
//! command substitutions or brace lists, so they can resolve the values they
//! know and ask about the ones they cannot. Word boundaries and quote removal
//! follow `shell_words::split`.

/// One piece of a word after quote removal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Part {
    /// Text the program receives as written.
    Text(String),
    /// `$NAME` or `${NAME}`. The shell splits an unquoted value into words.
    Variable { name: String, quoted: bool },
    /// A value only known at run time: `$(…)`, backticks, `${x#y}`, `$1`, `$@`.
    Dynamic,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Word {
    pub parts: Vec<Part>,
    /// The word as written, for prompts.
    pub raw: String,
    /// Holds an unquoted brace list (`{a,b}`, `{1..3}`) that the shell turns
    /// into several words.
    pub brace: bool,
    /// Bodies of the command substitutions in the word, including those
    /// inside `${…}` and `$((…))`.
    pub substitutions: Vec<String>,
}

impl Word {
    /// The word's text when nothing in it is expanded at run time.
    pub fn literal(&self) -> Option<String> {
        if self.brace {
            return None;
        }
        let mut text = String::new();
        for part in &self.parts {
            match part {
                Part::Text(value) => text.push_str(value),
                Part::Variable { .. } | Part::Dynamic => return None,
            }
        }
        Some(text)
    }

    pub fn is_dynamic(&self) -> bool {
        self.literal().is_none()
    }

    /// `NAME=value` (or `NAME+=value`) with an unquoted, valid name: the name,
    /// whether it appends, and the parts of the value.
    pub fn assignment(&self) -> Option<Assignment> {
        let Some(Part::Text(first)) = self.parts.first() else {
            return None;
        };
        let (target, value) = first.split_once('=')?;
        let (name, append) = match target.strip_suffix('+') {
            Some(name) => (name, true),
            None => (target, false),
        };
        // A quoted name is a command called `NAME=value`, not an assignment.
        if !is_name(name) || !self.raw.starts_with(&format!("{target}=")) {
            return None;
        }
        let mut parts = Vec::with_capacity(self.parts.len());
        if !value.is_empty() {
            parts.push(Part::Text(value.to_string()));
        }
        parts.extend(self.parts[1..].iter().cloned());
        Some(Assignment {
            name: name.to_string(),
            append,
            value: parts,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Assignment {
    pub name: String,
    pub append: bool,
    pub value: Vec<Part>,
}

/// A valid shell variable name.
pub(crate) fn is_name(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

/// The input is not a complete command: an unclosed quote, substitution or
/// parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LexError;

/// Splits `input` into words. Comments (`#` at the start of a word) and line
/// continuations are dropped like `shell_words::split` does.
pub(crate) fn lex_words(input: &str) -> Result<Vec<Word>, LexError> {
    Lexer {
        chars: input.chars().collect(),
        position: 0,
    }
    .words()
}

struct Lexer {
    chars: Vec<char>,
    position: usize,
}

#[derive(Default)]
struct Builder {
    parts: Vec<Part>,
    brace: bool,
    substitutions: Vec<String>,
    /// Set once the word has any content, including an empty `''`.
    started: bool,
}

impl Builder {
    fn push(&mut self, character: char) {
        self.started = true;
        match self.parts.last_mut() {
            Some(Part::Text(text)) => text.push(character),
            _ => self.parts.push(Part::Text(character.to_string())),
        }
    }

    fn push_str(&mut self, text: &str) {
        self.started = true;
        for character in text.chars() {
            self.push(character);
        }
    }

    fn part(&mut self, part: Part) {
        self.started = true;
        self.parts.push(part);
    }

    fn substitution(&mut self, body: String) {
        self.part(Part::Dynamic);
        self.substitutions.push(body);
    }
}

impl Lexer {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.position + offset).copied()
    }

    fn words(mut self) -> Result<Vec<Word>, LexError> {
        let mut words = Vec::new();
        loop {
            match self.peek() {
                None => return Ok(words),
                Some(' ' | '\t' | '\n') => self.position += 1,
                Some('\\') if self.peek_at(1) == Some('\n') => self.position += 2,
                Some('#') => {
                    while !matches!(self.peek(), None | Some('\n')) {
                        self.position += 1;
                    }
                }
                Some(_) => {
                    if let Some(word) = self.word()? {
                        words.push(word);
                    }
                }
            }
        }
    }

    fn word(&mut self) -> Result<Option<Word>, LexError> {
        let start = self.position;
        let mut word = Builder::default();
        while let Some(character) = self.peek() {
            match character {
                ' ' | '\t' | '\n' => break,
                '\\' => {
                    self.position += 1;
                    match self.peek() {
                        None => word.push('\\'),
                        Some('\n') => self.position += 1,
                        Some(escaped) => {
                            self.position += 1;
                            word.push(escaped);
                        }
                    }
                }
                '\'' => {
                    self.position += 1;
                    self.single_quoted(&mut word)?;
                }
                '"' => {
                    self.position += 1;
                    self.double_quoted(&mut word)?;
                }
                '$' => self.dollar(&mut word, false)?,
                '`' => {
                    self.position += 1;
                    let body = self.backtick()?;
                    word.substitution(body);
                }
                '{' => {
                    if self.brace_list_at(self.position) {
                        word.brace = true;
                    }
                    word.push('{');
                    self.position += 1;
                }
                other => {
                    word.push(other);
                    self.position += 1;
                }
            }
        }
        if !word.started {
            return Ok(None);
        }
        Ok(Some(Word {
            parts: word.parts,
            raw: self.chars[start..self.position].iter().collect(),
            brace: word.brace,
            substitutions: word.substitutions,
        }))
    }

    fn single_quoted(&mut self, word: &mut Builder) -> Result<(), LexError> {
        word.started = true;
        loop {
            match self.peek() {
                None => return Err(LexError),
                Some('\'') => {
                    self.position += 1;
                    return Ok(());
                }
                Some(character) => {
                    word.push(character);
                    self.position += 1;
                }
            }
        }
    }

    fn double_quoted(&mut self, word: &mut Builder) -> Result<(), LexError> {
        word.started = true;
        loop {
            match self.peek() {
                None => return Err(LexError),
                Some('"') => {
                    self.position += 1;
                    return Ok(());
                }
                Some('\\') => {
                    self.position += 1;
                    match self.peek() {
                        None => return Err(LexError),
                        Some('\n') => self.position += 1,
                        Some(escaped @ ('$' | '`' | '"' | '\\')) => {
                            self.position += 1;
                            word.push(escaped);
                        }
                        Some(other) => {
                            self.position += 1;
                            word.push('\\');
                            word.push(other);
                        }
                    }
                }
                Some('$') => self.dollar(word, true)?,
                Some('`') => {
                    self.position += 1;
                    let body = self.backtick()?;
                    word.substitution(body);
                }
                Some(character) => {
                    word.push(character);
                    self.position += 1;
                }
            }
        }
    }

    /// Reads an expansion starting at a `$`.
    fn dollar(&mut self, word: &mut Builder, quoted: bool) -> Result<(), LexError> {
        match self.peek_at(1) {
            // `$((…))` arithmetic: a number, but it can hold substitutions.
            Some('(') if self.peek_at(2) == Some('(') => {
                self.position += 3;
                let body = self.until_close(2)?;
                word.substitutions.extend(nested_substitutions(&body)?);
                word.push_str("0");
            }
            Some('(') => {
                self.position += 2;
                let body = self.until_close(1)?;
                word.substitution(body);
            }
            Some('{') => {
                self.position += 2;
                let body = self.parameter_body()?;
                if is_name(&body) {
                    word.part(Part::Variable {
                        name: body,
                        quoted,
                    });
                } else if body.strip_prefix('#').is_some_and(is_name)
                    || matches!(body.as_str(), "#" | "?" | "$" | "!" | "-")
                {
                    // A length or a status: digits only.
                    word.push_str("0");
                } else {
                    word.substitutions.extend(nested_substitutions(&body)?);
                    word.part(Part::Dynamic);
                }
            }
            // `$'…'` ANSI-C quoting: text with escape sequences.
            Some('\'') if !quoted => {
                self.position += 2;
                let text = self.ansi_c()?;
                word.started = true;
                word.push_str(&text);
            }
            // `$"…"` is a translatable double-quoted string.
            Some('"') if !quoted => self.position += 1,
            Some(first) if first == '_' || first.is_ascii_alphabetic() => {
                self.position += 1;
                let mut name = String::new();
                while let Some(character) = self.peek() {
                    if character == '_' || character.is_ascii_alphanumeric() {
                        name.push(character);
                        self.position += 1;
                    } else {
                        break;
                    }
                }
                word.part(Part::Variable { name, quoted });
            }
            // Positional parameters are whatever the shell was started with.
            Some(first) if first.is_ascii_digit() || first == '@' || first == '*' => {
                self.position += 2;
                word.part(Part::Dynamic);
            }
            // Exit status, process ids, argument count and flags.
            Some('?' | '$' | '#' | '!' | '-') => {
                self.position += 2;
                word.push_str("0");
            }
            _ => {
                self.position += 1;
                word.push('$');
            }
        }
        Ok(())
    }

    /// Reads up to the parenthesis that closes `opened` open ones and returns
    /// the text inside the first of them (without the closers).
    fn until_close(&mut self, opened: usize) -> Result<String, LexError> {
        let start = self.position;
        let mut depth = opened;
        let mut body_end = None;
        while let Some(character) = self.peek() {
            match character {
                '\\' => {
                    self.position += 2;
                    continue;
                }
                '\'' => {
                    self.position += 1;
                    self.skip_single()?;
                    continue;
                }
                '"' => {
                    self.position += 1;
                    self.skip_double()?;
                    continue;
                }
                '`' => {
                    self.position += 1;
                    self.backtick()?;
                    continue;
                }
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth + 1 == opened && body_end.is_none() {
                        body_end = Some(self.position);
                    }
                    if depth == 0 {
                        let end = body_end.unwrap_or(self.position);
                        self.position += 1;
                        return Ok(self.chars[start..end].iter().collect());
                    }
                }
                _ => {}
            }
            self.position += 1;
        }
        Err(LexError)
    }

    /// Reads a `${…}` body up to its closing brace.
    fn parameter_body(&mut self) -> Result<String, LexError> {
        let start = self.position;
        let mut depth = 1usize;
        while let Some(character) = self.peek() {
            match character {
                '\\' => {
                    self.position += 2;
                    continue;
                }
                '\'' => {
                    self.position += 1;
                    self.skip_single()?;
                    continue;
                }
                '"' => {
                    self.position += 1;
                    self.skip_double()?;
                    continue;
                }
                '`' => {
                    self.position += 1;
                    self.backtick()?;
                    continue;
                }
                '$' if self.peek_at(1) == Some('(') => {
                    self.position += 2;
                    self.until_close(1)?;
                    continue;
                }
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        let body = self.chars[start..self.position].iter().collect();
                        self.position += 1;
                        return Ok(body);
                    }
                }
                _ => {}
            }
            self.position += 1;
        }
        Err(LexError)
    }

    fn skip_single(&mut self) -> Result<(), LexError> {
        loop {
            match self.peek() {
                None => return Err(LexError),
                Some('\'') => {
                    self.position += 1;
                    return Ok(());
                }
                Some(_) => self.position += 1,
            }
        }
    }

    fn skip_double(&mut self) -> Result<(), LexError> {
        loop {
            match self.peek() {
                None => return Err(LexError),
                Some('"') => {
                    self.position += 1;
                    return Ok(());
                }
                Some('\\') => self.position += 2,
                Some('$') if self.peek_at(1) == Some('(') => {
                    self.position += 2;
                    self.until_close(1)?;
                }
                Some('`') => {
                    self.position += 1;
                    self.backtick()?;
                }
                Some(_) => self.position += 1,
            }
        }
    }

    /// Reads a backtick substitution after its opening backtick.
    fn backtick(&mut self) -> Result<String, LexError> {
        let mut body = String::new();
        loop {
            match self.peek() {
                None => return Err(LexError),
                Some('`') => {
                    self.position += 1;
                    return Ok(body);
                }
                Some('\\') => {
                    match self.peek_at(1) {
                        None => return Err(LexError),
                        Some(escaped @ ('`' | '\\' | '$')) => body.push(escaped),
                        Some(other) => {
                            body.push('\\');
                            body.push(other);
                        }
                    }
                    self.position += 2;
                }
                Some(character) => {
                    body.push(character);
                    self.position += 1;
                }
            }
        }
    }

    /// Reads a `$'…'` string after its opening quote and decodes its escapes.
    fn ansi_c(&mut self) -> Result<String, LexError> {
        let mut text = String::new();
        loop {
            let character = self.peek().ok_or(LexError)?;
            self.position += 1;
            match character {
                '\'' => return Ok(text),
                '\\' => {
                    let escape = self.peek().ok_or(LexError)?;
                    self.position += 1;
                    match escape {
                        'a' => text.push('\u{7}'),
                        'b' => text.push('\u{8}'),
                        'e' | 'E' => text.push('\u{1b}'),
                        'f' => text.push('\u{c}'),
                        'n' => text.push('\n'),
                        'r' => text.push('\r'),
                        't' => text.push('\t'),
                        'v' => text.push('\u{b}'),
                        '\\' | '\'' | '"' | '?' => text.push(escape),
                        'x' => self.push_code(&mut text, "\\x", 16, 2),
                        'u' => self.push_code(&mut text, "\\u", 16, 4),
                        'U' => self.push_code(&mut text, "\\U", 16, 8),
                        'c' => {
                            let control = self.peek().ok_or(LexError)?;
                            self.position += 1;
                            text.push(char::from(control as u8 & 0x1f));
                        }
                        '0'..='7' => {
                            self.position -= 1;
                            self.push_code(&mut text, "\\", 8, 3);
                        }
                        other => {
                            text.push('\\');
                            text.push(other);
                        }
                    }
                }
                other => text.push(other),
            }
        }
    }

    /// Decodes up to `max` digits of `radix` into a character, or keeps the
    /// escape as written when no digit follows.
    fn push_code(&mut self, text: &mut String, escape: &str, radix: u32, max: usize) {
        let mut digits = String::new();
        while digits.len() < max {
            match self.peek() {
                Some(digit) if digit.is_digit(radix) => {
                    digits.push(digit);
                    self.position += 1;
                }
                _ => break,
            }
        }
        if digits.is_empty() {
            text.push_str(escape);
            return;
        }
        let code = u32::from_str_radix(&digits, radix).unwrap_or(0xFFFD);
        text.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
    }

    /// Whether the unquoted `{` at `start` opens a brace list the shell
    /// expands: it closes in the same word and holds a top-level comma or a
    /// `a..b` sequence.
    fn brace_list_at(&self, start: usize) -> bool {
        let mut depth = 0usize;
        let mut comma = false;
        let mut index = start;
        while let Some(&character) = self.chars.get(index) {
            match character {
                '\\' => {
                    index += 2;
                    continue;
                }
                '\'' | '"' => {
                    let quote = character;
                    index += 1;
                    while let Some(&inner) = self.chars.get(index) {
                        if inner == '\\' && quote == '"' {
                            index += 2;
                            continue;
                        }
                        index += 1;
                        if inner == quote {
                            break;
                        }
                    }
                    continue;
                }
                ' ' | '\t' | '\n' => return false,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        let inner: String = self.chars[start + 1..index].iter().collect();
                        return comma || is_sequence(&inner);
                    }
                }
                ',' if depth == 1 => comma = true,
                _ => {}
            }
            index += 1;
        }
        false
    }
}

/// `a..e`, `1..10` or `1..10..2`: a brace sequence expression.
fn is_sequence(inner: &str) -> bool {
    let parts: Vec<&str> = inner.split("..").collect();
    let number = |value: &str| {
        let digits = value.strip_prefix(['-', '+']).unwrap_or(value);
        !digits.is_empty() && digits.chars().all(|digit| digit.is_ascii_digit())
    };
    let letter = |value: &str| {
        value.chars().count() == 1 && value.chars().all(|character| character.is_ascii_alphabetic())
    };
    match parts.as_slice() {
        [from, to] => (number(from) && number(to)) || (letter(from) && letter(to)),
        [from, to, step] => {
            ((number(from) && number(to)) || (letter(from) && letter(to))) && number(step)
        }
        _ => false,
    }
}

/// Command substitutions inside a `${…}` or `$((…))` body.
fn nested_substitutions(body: &str) -> Result<Vec<String>, LexError> {
    Ok(lex_words(body)?
        .into_iter()
        .flat_map(|word| word.substitutions)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Part {
        Part::Text(value.to_string())
    }

    fn variable(name: &str, quoted: bool) -> Part {
        Part::Variable {
            name: name.to_string(),
            quoted,
        }
    }

    fn parts(input: &str) -> Vec<Vec<Part>> {
        lex_words(input)
            .unwrap()
            .into_iter()
            .map(|word| word.parts)
            .collect()
    }

    #[test]
    fn literal_words_match_shell_words() {
        for line in [
            "git commit -m 'fix: a \"b\" c'",
            "echo \"a\\\"b\" c\\ d 'e f' \"g\\$h\"",
            "grep -rn 'TODO|FIXME' --include='*.ts' .",
            "cat notes.txt 2>/dev/null",
            "printf '%s\\n' x",
            "a\\\nb c",
            "ls # a comment",
            "echo '' \"\" x",
        ] {
            let lexed: Vec<String> = lex_words(line)
                .unwrap()
                .iter()
                .map(|word| word.literal().expect(line))
                .collect();
            assert_eq!(lexed, shell_words::split(line).unwrap(), "{line}");
        }
    }

    #[test]
    fn parameters_keep_their_quoting() {
        assert_eq!(
            parts("cat $HOME/.ssh/id_rsa \"${HOME}\"/x '$HOME'"),
            vec![
                vec![text("cat")],
                vec![variable("HOME", false), text("/.ssh/id_rsa")],
                vec![variable("HOME", true), text("/x")],
                vec![text("$HOME")],
            ],
        );
        // An escaped dollar is text.
        assert_eq!(parts("echo \\$HOME \"\\$HOME\""), vec![vec![text("echo")], vec![text("$HOME")], vec![text("$HOME")]]);
    }

    #[test]
    fn quote_boundaries_end_a_variable_name() {
        assert_eq!(
            parts("\"$HO\"\"ME\""),
            vec![vec![variable("HO", true), text("ME")]],
        );
        assert_eq!(parts("$HO\\ME"), vec![vec![variable("HO", false), text("ME")]]);
    }

    #[test]
    fn substitutions_stay_whole_and_are_recorded() {
        let words = lex_words("echo \"$(cat ~/.ssh/id_rsa | base64)\" `id` x").unwrap();
        assert_eq!(words.len(), 4);
        assert_eq!(words[1].parts, vec![Part::Dynamic]);
        assert_eq!(words[1].substitutions, vec!["cat ~/.ssh/id_rsa | base64".to_string()]);
        assert_eq!(words[2].substitutions, vec!["id".to_string()]);
        let nested = lex_words("x=$(echo \"$(pwd)\" \")\")").unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].substitutions, vec!["echo \"$(pwd)\" \")\"".to_string()]);
        // Parameter operators and arithmetic can hide substitutions too.
        assert_eq!(
            lex_words("echo ${X:-$(id)} $(( $(wc -l < f) + 1 ))").unwrap()[1..]
                .iter()
                .flat_map(|word| word.substitutions.clone())
                .collect::<Vec<_>>(),
            vec!["id".to_string(), "wc -l < f".to_string()],
        );
    }

    #[test]
    fn special_parameters_and_arithmetic_are_numbers() {
        assert_eq!(
            lex_words("echo $? $$ ${#x} $((1 + 2))")
                .unwrap()
                .iter()
                .map(|word| word.literal().unwrap())
                .collect::<Vec<_>>(),
            vec!["echo", "0", "0", "0", "0"],
        );
        assert!(lex_words("echo $1 $@ ${x%.*}").unwrap()[1..]
            .iter()
            .all(|word| word.parts == vec![Part::Dynamic]));
    }

    #[test]
    fn ansi_c_strings_are_decoded() {
        assert_eq!(
            lex_words("cat $'\\x2e\\x2e/secret' $'a\\'b' $'\\101'").unwrap()[1..]
                .iter()
                .map(|word| word.literal().unwrap())
                .collect::<Vec<_>>(),
            vec!["../secret", "a'b", "A"],
        );
    }

    #[test]
    fn brace_lists_are_flagged() {
        let flagged = |line: &str| lex_words(line).unwrap().iter().map(|word| word.brace).collect::<Vec<_>>();
        assert_eq!(flagged("{rm,-rf,~}"), vec![true]);
        assert_eq!(flagged("echo a{1..3}b"), vec![false, true]);
        assert_eq!(flagged("find . -exec rm {} ;"), vec![false; 6]);
        assert_eq!(flagged("git show HEAD@{1} '{a,b}' \"{a,b}\" { x"), vec![false; 7]);
        assert_eq!(flagged("echo ${a,b}"), vec![false, false]);
    }

    #[test]
    fn assignments_need_an_unquoted_name() {
        let words = lex_words("P=~/.ssh/id_rsa X+=\"$HOME\" \"Q\"=1 R=").unwrap();
        let first = words[0].assignment().unwrap();
        assert_eq!((first.name.as_str(), first.append), ("P", false));
        assert_eq!(first.value, vec![text("~/.ssh/id_rsa")]);
        let second = words[1].assignment().unwrap();
        assert_eq!((second.name.as_str(), second.append), ("X", true));
        assert_eq!(second.value, vec![variable("HOME", true)]);
        assert!(words[2].assignment().is_none());
        assert_eq!(words[3].assignment().unwrap().value, Vec::<Part>::new());
    }

    #[test]
    fn unclosed_constructs_are_errors() {
        for line in ["echo 'a", "echo \"a", "echo $(a", "echo ${a", "echo `a", "echo $'a"] {
            assert_eq!(lex_words(line), Err(LexError), "{line}");
        }
    }
}
