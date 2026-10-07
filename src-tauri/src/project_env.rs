//! The variables a project gives the commands the agent runs in it.
//!
//! A project can need another toolchain than the one the user's shell starts
//! with: JDK 11 where the machine defaults to 25, an older Node. In a
//! terminal the user switches by hand, for that one shell. The agent's
//! commands each start a shell of their own, so it had to find the toolchain
//! first and then put `JAVA_HOME=… PATH=…` in front of every single command,
//! and each of those lines was a new one to approve.
//!
//! So the user writes the variables down once per project, the way a shell
//! profile would set them: one `NAME=value` per line. Every command of the
//! project starts with them, the permission check reads command lines with
//! them, and the agent is told that they are set.

/// Reads the text the user typed: one `NAME=value` per line, with `export`
/// in front if they like, the value in quotes or not. Empty lines and lines
/// that start with `#` say nothing. Returns each assignment in the order it
/// was written, with its value as written and whether it stood in single
/// quotes, which keep `$` and `~` as they are; or the numbers (from 1) of
/// the lines that are no assignment.
fn parse(text: &str) -> Result<Vec<(String, String, bool)>, Vec<usize>> {
    let mut variables: Vec<(String, String, bool)> = Vec::new();
    let mut bad: Vec<usize> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export")
            .filter(|rest| rest.starts_with(char::is_whitespace))
            .map_or(line, str::trim_start);
        let Some((name, value)) = line.split_once('=') else {
            bad.push(index + 1);
            continue;
        };
        // Spaces around the `=` are what people type; a shell would not
        // take them, a file of variables does.
        let name = name.trim();
        if !is_name(name) {
            bad.push(index + 1);
            continue;
        }
        let value = value.trim();
        let quoted =
            |quote: char| value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote);
        let (value, literal) = if quoted('\'') {
            (&value[1..value.len() - 1], true)
        } else if quoted('"') {
            (&value[1..value.len() - 1], false)
        } else {
            (value, false)
        };
        variables.push((name.to_string(), value.to_string(), literal));
    }
    if bad.is_empty() {
        Ok(variables)
    } else {
        Err(bad)
    }
}

fn is_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(|first: char| first.is_ascii_digit())
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// What is wrong with the text of a project's variables.
#[derive(Debug, PartialEq, Eq)]
pub enum Problem {
    /// These lines (from 1) are not `NAME=value`.
    Lines(Vec<usize>),
    /// `PATH` names this folder, which is empty or relative: it would stand
    /// for whichever folder a command runs in.
    RelativePath(String),
}

impl std::fmt::Display for Problem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Lines(lines) => {
                let lines: Vec<String> = lines.iter().map(usize::to_string).collect();
                write!(formatter, "Not NAME=value: line {}", lines.join(", "))
            }
            Self::RelativePath(entry) if entry.is_empty() => {
                write!(
                    formatter,
                    "PATH has an empty entry; every folder in it has to be absolute"
                )
            }
            Self::RelativePath(entry) => write!(
                formatter,
                "PATH names '{entry}'; every folder in it has to be absolute"
            ),
        }
    }
}

/// The variables of `text` as a command gets them. `$NAME`, `${NAME}` and a
/// `~` at the start of a value or of an entry in a list stand for what a
/// shell would put there: a variable set on a line above, else what `lookup`
/// knows (the environment commands run with anyway), else nothing.
pub fn resolve(
    text: &str,
    lookup: impl Fn(&str) -> Option<String>,
    home: Option<&str>,
) -> Result<Vec<(String, String)>, Problem> {
    let parsed = parse(text).map_err(Problem::Lines)?;
    let mut resolved: Vec<(String, String)> = Vec::new();
    for (name, value, literal) in parsed {
        let value = if literal {
            value
        } else {
            let known = |wanted: &str| {
                resolved
                    .iter()
                    .find(|(name, _)| name == wanted)
                    .map(|(_, value)| value.clone())
                    .or_else(|| lookup(wanted))
            };
            expand(&value, known, home)
        };
        if name == "PATH" {
            if let Some(entry) = std::env::split_paths(&value).find(|entry| !entry.is_absolute()) {
                return Err(Problem::RelativePath(entry.display().to_string()));
            }
        }
        // Set again further down, the later line counts, as in a shell.
        match resolved.iter_mut().find(|(known, _)| *known == name) {
            Some(entry) => entry.1 = value,
            None => resolved.push((name, value)),
        }
    }
    Ok(resolved)
}

/// [`resolve`] against the environment the agent's commands run with.
pub fn resolve_for_commands(text: &str) -> Result<Vec<(String, String)>, Problem> {
    let lookup =
        |name: &str| crate::shell_env::command_var(name).and_then(|value| value.into_string().ok());
    let home = lookup("HOME").or_else(|| lookup("USERPROFILE"));
    resolve(text, lookup, home.as_deref())
}

fn expand(value: &str, known: impl Fn(&str) -> Option<String>, home: Option<&str>) -> String {
    let mut expanded = String::new();
    let mut characters = value.chars().peekable();
    // Whether the next character starts the value or an entry of a list.
    let mut entry_start = true;
    while let Some(character) = characters.next() {
        match character {
            '\\' if characters.peek() == Some(&'$') => {
                expanded.push('$');
                characters.next();
            }
            '$' if characters.peek() == Some(&'{') => {
                characters.next();
                let name: String = characters
                    .by_ref()
                    .take_while(|next| *next != '}')
                    .collect();
                expanded.push_str(&known(&name).unwrap_or_default());
            }
            '$' if characters
                .peek()
                .is_some_and(|next| next.is_ascii_alphabetic() || *next == '_') =>
            {
                let mut name = String::new();
                while let Some(next) = characters
                    .peek()
                    .copied()
                    .filter(|next| next.is_ascii_alphanumeric() || *next == '_')
                {
                    name.push(next);
                    characters.next();
                }
                expanded.push_str(&known(&name).unwrap_or_default());
            }
            '~' if entry_start && matches!(characters.peek(), None | Some('/' | ':')) => match home
            {
                Some(home) => expanded.push_str(home),
                None => expanded.push('~'),
            },
            other => expanded.push(other),
        }
        entry_start = character == ':';
    }
    expanded
}

/// One line for the system prompt that says which variables are set, so the
/// agent neither sets them again nor goes looking for the toolchain. Only
/// the names are told, and the folders `PATH` gains over `base_path`: a
/// value can be a key the model has no business seeing.
pub fn describe(variables: &[(String, String)], base_path: Option<&str>) -> Option<String> {
    if variables.is_empty() {
        return None;
    }
    let names: Vec<&str> = variables.iter().map(|(name, _)| name.as_str()).collect();
    let mut line = format!(
        "\n- The user set these variables for every command in this project: {}. Programs are found accordingly (`java`, `node` and the like are the project's). Do not set them again in a command and do not look for another toolchain.",
        names.join(", ")
    );
    // Entries are told apart the way a Unix shell lists them.
    if let Some((_, path)) = variables
        .iter()
        .find(|(name, _)| cfg!(unix) && name == "PATH")
    {
        let inherited: Vec<&str> = match base_path {
            Some(base) if !base.is_empty() => base.split(':').collect(),
            _ => Vec::new(),
        };
        let added = crate::permissions::added_path_entries(path, &inherited);
        if !added.is_empty() && added.len() <= 8 {
            line.push_str(&format!(" PATH has in front: {}.", added.join(", ")));
        }
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(text: &str) -> Result<Vec<(String, String)>, Problem> {
        let lookup = |name: &str| match name {
            "PATH" => Some("/usr/bin:/bin".to_string()),
            "LANG" => Some("de_DE.UTF-8".to_string()),
            _ => None,
        };
        resolve(text, lookup, Some("/home/me"))
    }

    fn pairs(entries: &[(&str, &str)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn lines_are_read_the_way_a_shell_profile_sets_variables() {
        let text = "# JDK 11 for the build\n\
                    JAVA_HOME=~/.sdkman/candidates/java/11.0.32-amzn\n\
                    \n\
                    export PATH=\"$JAVA_HOME/bin:${PATH}\"\n\
                    GREETING='costs $5 at ~/shop'\n\
                    SPACED = with spaces \n\
                    EMPTY=";
        assert_eq!(
            resolved(text),
            Ok(pairs(&[
                ("JAVA_HOME", "/home/me/.sdkman/candidates/java/11.0.32-amzn"),
                (
                    "PATH",
                    "/home/me/.sdkman/candidates/java/11.0.32-amzn/bin:/usr/bin:/bin"
                ),
                // Single quotes keep everything as it is written.
                ("GREETING", "costs $5 at ~/shop"),
                ("SPACED", "with spaces"),
                ("EMPTY", ""),
            ]))
        );
    }

    #[test]
    fn values_stand_for_what_a_shell_would_put_there() {
        assert_eq!(
            resolved("A=$LANG\nB=${LANG}x\nC=$MISSING.\nD=\\$LANG\nE=5$\nF=a~b"),
            Ok(pairs(&[
                ("A", "de_DE.UTF-8"),
                ("B", "de_DE.UTF-8x"),
                ("C", "."),
                ("D", "$LANG"),
                ("E", "5$"),
                ("F", "a~b"),
            ]))
        );
        // `~` is the home folder at the start of a value and of a list entry.
        assert_eq!(
            resolved("X=~\nY=~/a:~/b:/c~\nZ=~user/x"),
            Ok(pairs(&[
                ("X", "/home/me"),
                ("Y", "/home/me/a:/home/me/b:/c~"),
                ("Z", "~user/x"),
            ]))
        );
        // A line further down sees the ones above, and replaces an earlier
        // one of the same name.
        assert_eq!(
            resolved("A=1\nB=$A$A\nA=2"),
            Ok(pairs(&[("A", "2"), ("B", "11")]))
        );
    }

    #[test]
    fn what_is_no_assignment_is_named_by_its_line() {
        assert_eq!(
            resolved("JAVA_HOME=/opt/jdk\nnvm use 14\n1ST=x\n=y\nexport\nOK=1"),
            Err(Problem::Lines(vec![2, 3, 4, 5]))
        );
        assert_eq!(resolved(""), Ok(Vec::new()));
        assert_eq!(resolved("  \n# nothing\n"), Ok(Vec::new()));
    }

    #[test]
    fn a_path_takes_absolute_folders_only() {
        assert_eq!(
            resolved("PATH=node_modules/.bin:$PATH"),
            Err(Problem::RelativePath("node_modules/.bin".to_string()))
        );
        assert_eq!(
            resolved("PATH=$PATH:"),
            Err(Problem::RelativePath(String::new()))
        );
        assert!(resolved("PATH=~/bin:$PATH").is_ok());
        assert_eq!(
            Problem::Lines(vec![2, 5]).to_string(),
            "Not NAME=value: line 2, 5"
        );
    }

    #[test]
    fn the_agent_is_told_the_names_and_what_path_gains() {
        assert_eq!(describe(&[], Some("/usr/bin")), None);
        let variables = pairs(&[
            ("JAVA_HOME", "/opt/jdks/11"),
            ("API_TOKEN", "secret-value"),
            ("PATH", "/opt/jdks/11/bin:/usr/bin:/bin"),
        ]);
        let line = describe(&variables, Some("/usr/bin:/bin")).unwrap();
        assert!(line.contains("JAVA_HOME, API_TOKEN, PATH"), "{line}");
        if cfg!(unix) {
            assert!(
                line.contains("PATH has in front: /opt/jdks/11/bin."),
                "{line}"
            );
        }
        // No value is told, a key least of all.
        assert!(!line.contains("secret-value"), "{line}");
        assert!(!line.contains("/opt/jdks/11,"), "{line}");
        // Without a `PATH` of its own there is nothing to say about it.
        let line = describe(&pairs(&[("JAVA_HOME", "/opt/jdks/11")]), Some("/usr/bin")).unwrap();
        assert!(!line.contains("PATH has"), "{line}");
    }
}
