//! Finds the names a project defines, such as classes, structs and functions,
//! so the composer can complete them while a prompt is typed. A pattern per
//! language family reads a definition off the start of its line. That is no
//! parser and misses the odd definition, but it reads a project in a blink and
//! knows every language the same little way.

use crate::models::WorkspaceSymbol;
use ignore::WalkBuilder;
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

/// Source files read at most, as many as the composer lists paths.
const MAX_FILES: usize = 4000;
/// Larger source files are generated or bundled more often than written.
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Minified code is one long line; nothing on it is worth completing.
const MAX_LINE_BYTES: usize = 400;
const MAX_SYMBOLS: usize = 20_000;

/// Words a pattern takes for a name where a line calls or tests something.
const NOT_NAMES: &[&str] = &[
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "else",
    "do",
    "try",
    "with",
    "new",
    "constructor",
    "super",
    "this",
    "function",
    "await",
    "typeof",
    "sizeof",
    "delete",
    "throw",
    "case",
    "yield",
];

struct Pattern {
    regex: Regex,
    /// The kind of every match; without one, the captured keyword `kw` tells.
    kind: Option<&'static str>,
}

struct Language {
    extensions: &'static [&'static str],
    patterns: Vec<Pattern>,
}

fn pattern(regex: &str, kind: Option<&'static str>) -> Pattern {
    Pattern {
        regex: Regex::new(regex).expect("symbol pattern"),
        kind,
    }
}

static LANGUAGES: LazyLock<Vec<Language>> = LazyLock::new(|| {
    vec![
        Language {
            extensions: &[
                "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte",
            ],
            patterns: vec![
                pattern(
                    r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+)?(?P<kw>class|interface|enum|type|function\*?|namespace)\s+(?P<name>[A-Za-z_$][\w$]*)",
                    None,
                ),
                // Only at the top of a module: inside a function they are locals.
                pattern(
                    r"^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)\s*[:=]",
                    Some("constant"),
                ),
                pattern(
                    r"^\s+(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)+(?:get\s+|set\s+)?(?P<name>[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(",
                    Some("method"),
                ),
                // A method without modifiers: its parameters, maybe a return
                // type, and the brace that opens its body, all on one line. A
                // call that is handed a callback has parentheses inside.
                pattern(
                    r"^\s+(?:async\s+)?(?:get\s+|set\s+)?(?P<name>[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::\s*[^=;{}()]+)?\{\s*$",
                    Some("method"),
                ),
            ],
        },
        Language {
            extensions: &["rs"],
            patterns: vec![pattern(
                r#"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?(?P<kw>fn|struct|enum|trait|type|mod|union|const|static)\s+(?:mut\s+)?(?P<name>[A-Za-z_]\w*)"#,
                None,
            )],
        },
        Language {
            extensions: &["py", "pyi"],
            patterns: vec![
                pattern(
                    r"^\s*(?:async\s+)?(?P<kw>class|def)\s+(?P<name>[A-Za-z_]\w*)",
                    None,
                ),
                pattern(
                    r"^(?P<name>[A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=[^=]",
                    Some("constant"),
                ),
            ],
        },
        Language {
            extensions: &["go"],
            patterns: vec![
                pattern(
                    r"^func\s+\([^)]*\)\s*(?P<name>[A-Za-z_]\w*)",
                    Some("method"),
                ),
                pattern(r"^func\s+(?P<name>[A-Za-z_]\w*)", Some("function")),
                pattern(
                    r"^\s*type\s+(?P<name>[A-Za-z_]\w*)\s+(?P<kw>struct|interface)\b",
                    None,
                ),
                pattern(r"^\s*type\s+(?P<name>[A-Za-z_]\w*)\b", Some("type")),
            ],
        },
        Language {
            extensions: &[
                "java", "kt", "kts", "scala", "cs", "swift", "dart", "php", "groovy",
            ],
            patterns: vec![
                pattern(
                    r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|inner|partial|export|override|readonly|fileprivate|value|annotation|case|implicit|lazy|async|virtual)\s+)*(?P<kw>enum\s+class|class|interface|enum|struct|record|object|trait|protocol|func|fun|def|function|namespace|typealias)\s+(?:<[^>]*>\s*)?(?P<name>[A-Za-z_]\w*)",
                    None,
                ),
                pattern(
                    r"^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|async|virtual|sealed|native)\s+)+(?:<[^>]*>\s*)?[\w<>\[\],.?]+\s+(?P<name>[A-Za-z_]\w*)\s*\(",
                    Some("method"),
                ),
            ],
        },
        Language {
            extensions: &["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"],
            patterns: vec![
                pattern(
                    r"^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?(?P<kw>class|struct|enum\s+class|enum|union|namespace)\s+(?:[A-Z_][A-Z0-9_]*\s+)?(?P<name>[A-Za-z_]\w*)\s*(?:final\s*)?(?:[:{]|$)",
                    None,
                ),
                // A definition starts at the left margin and does not end in
                // a semicolon, which a prototype or a call does.
                pattern(
                    r"^(?:[A-Za-z_][\w:<>,*&]*\s+)+[*&]*(?:[A-Za-z_]\w*::)*(?P<name>~?[A-Za-z_]\w*)\s*\([^;]*$",
                    Some("function"),
                ),
            ],
        },
        Language {
            extensions: &["rb"],
            patterns: vec![pattern(
                r"^\s*(?P<kw>class|module|def)\s+(?:self\.)?(?P<name>[A-Za-z_]\w*[?!]?)",
                None,
            )],
        },
    ]
});

/// The kind a definition keyword stands for.
fn kind_of(keyword: &str) -> &'static str {
    match keyword
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches('*')
    {
        "class" | "object" | "record" => "class",
        "interface" | "protocol" => "interface",
        "struct" | "union" => "struct",
        "enum" => "enum",
        "trait" => "trait",
        "type" | "typealias" => "type",
        "namespace" | "mod" | "module" => "module",
        "const" | "static" => "constant",
        _ => "function",
    }
}

fn language_of(path: &Path) -> Option<&'static Language> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    LANGUAGES
        .iter()
        .find(|language| language.extensions.contains(&extension.as_str()))
}

/// The name and kind a line defines, if it defines one.
fn definition<'a>(line: &'a str, language: &Language) -> Option<(&'a str, &'static str)> {
    for pattern in &language.patterns {
        let Some(captures) = pattern.regex.captures(line) else {
            continue;
        };
        let Some(name) = captures.name("name").map(|name| name.as_str()) else {
            continue;
        };
        if NOT_NAMES.contains(&name) {
            continue;
        }
        let kind = match pattern.kind {
            Some(kind) => kind,
            None => match kind_of(captures.name("kw").map_or("", |kw| kw.as_str())) {
                // An indented function belongs to a class, an impl or the like.
                "function" if line.starts_with(char::is_whitespace) => "method",
                kind => kind,
            },
        };
        return Some((name, kind));
    }
    None
}

/// The first definition of each name in one file.
fn symbols_in(text: &str, language: &Language, path: &str) -> Vec<WorkspaceSymbol> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut symbols = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Some((name, kind)) = definition(line, language) else {
            continue;
        };
        if seen.insert(name) {
            symbols.push(WorkspaceSymbol {
                name: name.to_string(),
                kind: kind.to_string(),
                path: path.to_string(),
                line: index + 1,
            });
        }
    }
    symbols
}

/// Reads the definitions of the project's source files. Git-ignored paths are
/// skipped, as for the files the composer lists.
pub fn scan(root: &Path) -> Vec<WorkspaceSymbol> {
    let mut symbols: Vec<WorkspaceSymbol> = Vec::new();
    let mut files = 0;
    let walker = WalkBuilder::new(root).hidden(false).build();
    for entry in walker.flatten() {
        if files >= MAX_FILES || symbols.len() >= MAX_SYMBOLS {
            break;
        }
        let path = entry.path();
        if !entry.file_type().is_some_and(|kind| kind.is_file())
            || path
                .components()
                .any(|component| component.as_os_str() == ".git")
        {
            continue;
        }
        let Some(language) = language_of(path) else {
            continue;
        };
        if entry
            .metadata()
            .map_or(true, |metadata| metadata.len() > MAX_FILE_BYTES)
        {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        files += 1;
        let relative = relative.to_string_lossy().replace('\\', "/");
        symbols.extend(symbols_in(&text, language, &relative));
    }
    symbols.truncate(MAX_SYMBOLS);
    symbols.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defined(extension: &str, line: &str) -> Option<(String, &'static str)> {
        let language = language_of(Path::new(&format!("file.{extension}"))).unwrap();
        definition(line, language).map(|(name, kind)| (name.to_string(), kind))
    }

    fn is(name: &str, kind: &'static str) -> Option<(String, &'static str)> {
        Some((name.to_string(), kind))
    }

    #[test]
    fn reads_typescript_definitions() {
        assert_eq!(
            defined("ts", "export class Composer {"),
            is("Composer", "class")
        );
        assert_eq!(
            defined("ts", "export default abstract class Base<T> {"),
            is("Base", "class")
        );
        assert_eq!(
            defined("ts", "interface MentionItem {"),
            is("MentionItem", "interface")
        );
        assert_eq!(
            defined("ts", "export const enum Mode {"),
            is("Mode", "enum")
        );
        assert_eq!(
            defined("ts", "export type SavedPill = { a: 1 };"),
            is("SavedPill", "type")
        );
        assert_eq!(
            defined(
                "ts",
                "export async function trimEdges(text: string): string {"
            ),
            is("trimEdges", "function")
        );
        assert_eq!(
            defined("ts", "const MAX_ATTACHMENTS = 10;"),
            is("MAX_ATTACHMENTS", "constant")
        );
        assert_eq!(
            defined("ts", "  protected onKeydown(event: KeyboardEvent): void {"),
            is("onKeydown", "method")
        );
        assert_eq!(
            defined(
                "ts",
                "  private async loadMentionData(kind: MentionKind): Promise<void> {"
            ),
            is("loadMentionData", "method")
        );
        assert_eq!(
            defined("ts", "  ngOnInit(): void {"),
            is("ngOnInit", "method")
        );
    }

    #[test]
    fn leaves_typescript_calls_fields_and_locals_alone() {
        for line in [
            "  if (query) {",
            "  for (const entry of list) {",
            "  } else if (x) {",
            "  describe('the menu', () => {",
            "  it('opens', async () => {",
            "  effect(() => {",
            "  protected readonly mentionOpen = signal(false);",
            "    const query = this.detectQuery();",
            "  constructor(private readonly api: Api) {",
            "  type: 'file',",
            "        @if (mentionOpen()) {",
        ] {
            assert_eq!(defined("ts", line), None, "{line}");
        }
    }

    #[test]
    fn reads_rust_definitions() {
        assert_eq!(
            defined("rs", "pub fn scan(root: &Path) -> Vec<Symbol> {"),
            is("scan", "function")
        );
        assert_eq!(
            defined("rs", "    pub(crate) async fn run(&self) {"),
            is("run", "method")
        );
        assert_eq!(
            defined("rs", "pub struct WorkspaceSymbol {"),
            is("WorkspaceSymbol", "struct")
        );
        assert_eq!(defined("rs", "pub(super) enum Kind {"), is("Kind", "enum"));
        assert_eq!(
            defined("rs", "pub trait LlmClient: Send {"),
            is("LlmClient", "trait")
        );
        assert_eq!(
            defined("rs", "const MAX_FILES: usize = 4000;"),
            is("MAX_FILES", "constant")
        );
        assert_eq!(
            defined("rs", "pub const fn limit() -> usize {"),
            is("limit", "function")
        );
        assert_eq!(
            defined("rs", "static mut COUNTER: u32 = 0;"),
            is("COUNTER", "constant")
        );
        assert_eq!(defined("rs", "mod tests {"), is("tests", "module"));
        assert_eq!(defined("rs", "    let value = fn_call();"), None);
    }

    #[test]
    fn reads_other_languages() {
        assert_eq!(defined("py", "class Agent(Base):"), is("Agent", "class"));
        assert_eq!(
            defined("py", "async def fetch(url):"),
            is("fetch", "function")
        );
        assert_eq!(defined("py", "    def run(self):"), is("run", "method"));
        assert_eq!(
            defined("py", "MAX_TOKENS = 4096"),
            is("MAX_TOKENS", "constant")
        );
        assert_eq!(defined("py", "MAX_TOKENS == 4096"), None);
        assert_eq!(
            defined("go", "func (s *Server) Serve() error {"),
            is("Serve", "method")
        );
        assert_eq!(defined("go", "func main() {"), is("main", "function"));
        assert_eq!(
            defined("go", "type Server struct {"),
            is("Server", "struct")
        );
        assert_eq!(
            defined("go", "type Handler func(w Writer)"),
            is("Handler", "type")
        );
        assert_eq!(
            defined("java", "public final class Parser implements Reader {"),
            is("Parser", "class")
        );
        assert_eq!(
            defined("java", "    public static void main(String[] args) {"),
            is("main", "method")
        );
        assert_eq!(defined("java", "    public Parser(int size) {"), None);
        assert_eq!(
            defined("kt", "data class User(val name: String)"),
            is("User", "class")
        );
        assert_eq!(defined("kt", "enum class Color {"), is("Color", "enum"));
        assert_eq!(
            defined("swift", "protocol Drawable {"),
            is("Drawable", "interface")
        );
        assert_eq!(
            defined("cs", "    public async Task<int> CountAsync() {"),
            is("CountAsync", "method")
        );
        assert_eq!(
            defined("cpp", "class API_EXPORT Widget : public Base {"),
            is("Widget", "class")
        );
        assert_eq!(defined("cpp", "enum class Color {"), is("Color", "enum"));
        assert_eq!(
            defined("cpp", "void Widget::paint(Canvas& canvas) const {"),
            is("paint", "function")
        );
        assert_eq!(
            defined("c", "int main(int argc, char **argv)"),
            is("main", "function")
        );
        assert_eq!(defined("c", "int helper(int value);"), None);
        assert_eq!(defined("c", "struct node *next = head;"), None);
        assert_eq!(defined("rb", "  def valid?"), is("valid?", "method"));
        assert_eq!(defined("rb", "module Billing"), is("Billing", "module"));
    }

    #[test]
    fn scans_source_files_of_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/app.ts"),
            "export class App {\n  run(): void {\n  }\n}\n\nexport class App {}\n",
        )
        .unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn start() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "class NotCode\n").unwrap();
        std::fs::write(
            root.join("src/bundle.js"),
            format!("function {}() {{}}\n", "x".repeat(MAX_LINE_BYTES)),
        )
        .unwrap();

        let symbols = scan(root);
        let found: Vec<(&str, &str, &str, usize)> = symbols
            .iter()
            .map(|symbol| {
                (
                    symbol.name.as_str(),
                    symbol.kind.as_str(),
                    symbol.path.as_str(),
                    symbol.line,
                )
            })
            .collect();
        assert_eq!(
            found,
            vec![
                ("App", "class", "src/app.ts", 1),
                ("run", "method", "src/app.ts", 2),
                ("start", "function", "src/lib.rs", 1),
            ]
        );
    }
}
