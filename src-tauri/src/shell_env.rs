//! Gives pumr the environment the user's terminal has.
//!
//! An app started from the macOS Finder or a Linux desktop launcher inherits
//! the session's bare environment, not the one the shell profile builds: a
//! `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin` on macOS and none of the
//! variables the profile exports. The commands the agent runs, MCP servers
//! and `git` would then find nothing that was installed with Homebrew, nvm,
//! cargo and the like, and a skill or project script that takes its settings
//! from the environment (`$OC_CREDENTIALS/jira-credentials`) would find them
//! empty. So the user's shell is asked once, at start, what its environment
//! is.
//!
//! The `PATH` becomes pumr's own. The other variables do not: they are kept
//! aside and given to the commands the agent runs, on top of pumr's own
//! environment. pumr itself, its webview and the MCP servers it starts keep
//! what the desktop session gave them.
//!
//! However pumr was started, its `PATH` loses the entries that are empty or
//! relative. Those name whichever folder a command runs in, so a file of the
//! project could stand in for a program, and the permission check trusts no
//! program found after such an entry.

use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

/// The variables of the user's shell that a command run by the agent gets on
/// top of pumr's own environment. Empty on Windows and when pumr was started
/// from a terminal, where its own environment is already the shell's.
static COMMAND_ENVIRONMENT: RwLock<Vec<(OsString, OsString)>> = RwLock::new(Vec::new());

/// Whether the environment of the user's login shell was taken over.
static FROM_LOGIN_SHELL: AtomicBool = AtomicBool::new(false);

/// Adopts the environment of the user's login shell. Started from a terminal,
/// or with a shell that cannot be asked, pumr keeps the environment it has
/// and only tidies its `PATH`. A no-op on Windows. Must run before any thread
/// or webview exists, as it changes the `PATH`.
pub fn adopt_login_shell_environment() {
    #[cfg(unix)]
    match unix::resolved() {
        Some(environment) => {
            if let Some(path) = environment.path {
                std::env::set_var("PATH", path);
            }
            *COMMAND_ENVIRONMENT.write().unwrap() = environment.variables;
            FROM_LOGIN_SHELL.store(true, Ordering::Relaxed);
        }
        None => {
            let current = std::env::var_os("PATH");
            if let Some(path) = current.as_deref().and_then(unix::tidied) {
                std::env::set_var("PATH", path);
            }
        }
    }
}

/// Whether commands run with the environment of the user's login shell
/// (`true`) or with the one pumr was started in.
pub fn from_login_shell() -> bool {
    FROM_LOGIN_SHELL.load(Ordering::Relaxed)
}

/// What a command run by the agent is given on top of pumr's own environment.
pub fn command_environment() -> Vec<(OsString, OsString)> {
    COMMAND_ENVIRONMENT.read().unwrap().clone()
}

/// The value a variable has in a command run by the agent. The permission
/// check resolves `$NAME` in a command line with this, so it judges the paths
/// the command will really touch.
pub fn command_var(name: &str) -> Option<OsString> {
    COMMAND_ENVIRONMENT
        .read()
        .unwrap()
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var_os(name))
}

/// Gives commands run by the agent a variable, as the user's shell would.
#[cfg(test)]
pub fn set_command_var(name: &str, value: &str) {
    let mut variables = COMMAND_ENVIRONMENT.write().unwrap();
    variables.retain(|(key, _)| key != name);
    variables.push((name.into(), value.into()));
}

#[cfg(unix)]
mod unix {
    use std::ffi::{OsStr, OsString};
    use std::io::{IsTerminal, Read};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Set off the `PATH` from whatever a profile prints (a greeting, a
    /// version manager's notice).
    const START: &str = "__PUMR_PATH_START__";
    const END: &str = "__PUMR_PATH_END__";
    /// Ends the list of variables that follows the `PATH`.
    const ENV_END: &str = "__PUMR_ENV_END__";

    /// Variables that describe the shell that was asked rather than the
    /// user's setup, and `PATH`, which is adopted on its own.
    const SHELL_ONLY: &[&str] = &[
        "_", "SHLVL", "PWD", "OLDPWD", "PATH", "TERM", "COLUMNS", "LINES",
    ];

    /// What the user's shell answered.
    #[derive(Debug, PartialEq, Eq)]
    pub struct ShellAnswer {
        pub path: OsString,
        /// Every variable the shell exports, as `env` lists them. Empty when
        /// its `env` cannot separate them safely.
        pub variables: Vec<(OsString, OsString)>,
    }

    /// What pumr takes over from the user's shell.
    pub struct ShellEnvironment {
        /// The new `PATH`, `None` when pumr's own is already complete.
        pub path: Option<OsString>,
        /// The variables for commands run by the agent.
        pub variables: Vec<(OsString, OsString)>,
    }

    /// How long a slow profile may hold up the start of the app.
    const TIMEOUT: Duration = Duration::from_secs(5);

    pub fn resolved() -> Option<ShellEnvironment> {
        // Started from a terminal, pumr already has that shell's environment.
        if std::io::stdin().is_terminal()
            || std::io::stdout().is_terminal()
            || std::io::stderr().is_terminal()
        {
            return None;
        }
        let shell = PathBuf::from(std::env::var_os("SHELL")?);
        if !shell.is_absolute() {
            return None;
        }
        let answer = ask_shell(&shell, TIMEOUT)?;
        let current = std::env::var_os("PATH");
        let path = merge(&answer.path, current.as_deref())
            .filter(|merged| Some(merged) != current.as_ref());
        Some(ShellEnvironment {
            path,
            variables: command_variables(answer.variables, |name| std::env::var_os(name)),
        })
    }

    /// The variables of the shell that a command run by the agent needs on
    /// top of pumr's own environment (`own` looks one up there): those the
    /// profile exports and pumr lacks or has with another value. Where the
    /// two differ the shell wins, as it would in the user's terminal.
    fn command_variables(
        shell: Vec<(OsString, OsString)>,
        own: impl Fn(&OsStr) -> Option<OsString>,
    ) -> Vec<(OsString, OsString)> {
        let mut variables: Vec<(OsString, OsString)> = Vec::new();
        for (name, value) in shell {
            // An exported bash function (`BASH_FUNC_name%%`) is not a
            // variable a command could be given under that name.
            let is_name = name.to_str().is_some_and(|name| {
                !name.is_empty()
                    && !name.starts_with(|first: char| first.is_ascii_digit())
                    && name
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_')
                    && !SHELL_ONLY.contains(&name)
            });
            if !is_name || own(&name).as_ref() == Some(&value) {
                continue;
            }
            variables.retain(|(known, _)| known != &name);
            variables.push((name, value));
        }
        variables
    }

    /// The `PATH` and the exported variables of `shell` once it has loaded
    /// the user's profile, `None` when it does not answer in time or not in
    /// the expected form.
    fn ask_shell(shell: &Path, timeout: Duration) -> Option<ShellAnswer> {
        let mut command = Command::new(shell);
        command
            // Login and interactive, so both kinds of profile are read
            // (`.zprofile` and `.zshrc`, `.bash_profile` and `.bashrc`). The
            // script is one that zsh, bash and fish all understand. `env -0`
            // ends each variable with a NUL, so a value may span lines; an
            // `env` without it prints nothing and only the `PATH` is taken.
            .args(["-i", "-l", "-c"])
            .arg(format!(
                "printf '%s%s%s' {START} \"$PATH\" {END}; env -0 2>/dev/null; printf '%s' {ENV_END}"
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: `setsid` is async-signal-safe. A session of its own keeps
        // the interactive shell away from any terminal pumr is attached to,
        // and makes it a process group that can be stopped as a whole.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = command.spawn().ok()?;
        let mut stdout = child.stdout.take()?;

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            // Read only up to the end marker: a profile may have started
            // something that keeps the pipe open long after the shell is done.
            let mut output = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut answer = None;
            while answer.is_none() {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => output.extend_from_slice(&chunk[..read]),
                }
                answer = parse(&output);
            }
            let _ = sender.send(answer);
        });
        let answer = receiver.recv_timeout(timeout).ok().flatten();

        // The answer is in, or it is not coming: stop the shell and whatever
        // its profile left running in its group.
        if let Ok(group) = libc::pid_t::try_from(child.id()) {
            // SAFETY: `kill` only sends a signal. The child is not reaped yet,
            // so the group id still belongs to it.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        answer
    }

    /// The `PATH` between its markers in the shell's output and the
    /// variables listed after it, once the list is complete.
    fn parse(output: &[u8]) -> Option<ShellAnswer> {
        let start = find(output, START.as_bytes())? + START.len();
        let end = start + find(&output[start..], END.as_bytes())?;
        let listed = end + END.len();
        let listed_end = listed + find(&output[listed..], ENV_END.as_bytes())?;
        let variables = output[listed..listed_end]
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let equals = entry.iter().position(|byte| *byte == b'=')?;
                Some((
                    OsStr::from_bytes(&entry[..equals]).to_os_string(),
                    OsStr::from_bytes(&entry[equals + 1..]).to_os_string(),
                ))
            })
            .collect();
        Some(ShellAnswer {
            path: OsStr::from_bytes(&output[start..end]).to_os_string(),
            variables,
        })
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// The shell's directories, followed by those of pumr's own `PATH` the
    /// shell does not have. Empty and relative entries of either are left
    /// out: they would resolve inside whichever project a command runs in,
    /// and the permission check trusts no executable while `PATH` has one.
    fn merge(shell: &OsStr, current: Option<&OsStr>) -> Option<OsString> {
        let mut directories: Vec<PathBuf> = Vec::new();
        let shell = std::env::split_paths(shell);
        let current = current.into_iter().flat_map(std::env::split_paths);
        for directory in shell.chain(current).filter(|directory| directory.is_absolute()) {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
        std::env::join_paths(directories).ok()
    }

    /// `path` without its empty and relative entries, `None` when it has
    /// none of those and can stay as it is.
    pub fn tidied(path: &OsStr) -> Option<OsString> {
        let entries = std::env::split_paths(path).count();
        let absolute: Vec<PathBuf> = std::env::split_paths(path)
            .filter(|directory| directory.is_absolute())
            .collect();
        // A `PATH` of relative entries only is left alone: without any entry
        // no command would be found at all.
        if absolute.len() == entries || absolute.is_empty() {
            return None;
        }
        std::env::join_paths(absolute).ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        /// A stand-in for the user's shell: prints what a profile would, then
        /// runs the script it is given after `-i -l -c`.
        fn fake_shell(directory: &Path, profile: &str) -> PathBuf {
            let shell = directory.join("shell");
            std::fs::write(&shell, format!("#!/bin/sh\n{profile}\neval \"$4\"\n")).unwrap();
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
            shell
        }

        #[test]
        fn the_path_is_read_past_what_the_profile_prints() {
            let directory = tempfile::tempdir().unwrap();
            let shell = fake_shell(
                directory.path(),
                "echo 'Welcome back'\nPATH=/opt/homebrew/bin:/usr/bin:/bin",
            );
            assert_eq!(
                asked_path(&shell, Duration::from_secs(10)),
                Some("/opt/homebrew/bin:/usr/bin:/bin".into())
            );
        }

        fn asked_path(shell: &Path, timeout: Duration) -> Option<OsString> {
            ask_shell(shell, timeout).map(|answer| answer.path)
        }

        #[test]
        fn the_variables_a_profile_exports_come_with_the_path() {
            let directory = tempfile::tempdir().unwrap();
            let shell = fake_shell(
                directory.path(),
                "export OC_CREDENTIALS=/home/me/secrets/credentials\n\
                 export GREETING='two\nlines = fine'\n\
                 NOT_EXPORTED=1\n\
                 PATH=/usr/bin:/bin",
            );
            let answer = ask_shell(&shell, Duration::from_secs(10)).unwrap();
            assert_eq!(answer.path, "/usr/bin:/bin");
            let value = |name: &str| {
                answer
                    .variables
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.to_string_lossy().into_owned())
            };
            assert_eq!(
                value("OC_CREDENTIALS").as_deref(),
                Some("/home/me/secrets/credentials")
            );
            // A value that spans lines and holds an equals sign stays whole.
            assert_eq!(value("GREETING").as_deref(), Some("two\nlines = fine"));
            assert_eq!(value("NOT_EXPORTED"), None);
        }

        #[test]
        fn a_shell_whose_env_cannot_list_safely_still_gives_its_path() {
            let directory = tempfile::tempdir().unwrap();
            let shell = fake_shell(
                directory.path(),
                "env() { echo 'env: illegal option -- 0' >&2; return 1; }\nPATH=/usr/bin:/bin",
            );
            assert_eq!(
                ask_shell(&shell, Duration::from_secs(10)),
                Some(ShellAnswer {
                    path: "/usr/bin:/bin".into(),
                    variables: Vec::new(),
                })
            );
        }

        #[test]
        fn commands_get_what_the_shell_exports_beyond_pumrs_own_environment() {
            let pair = |name: &str, value: &str| (OsString::from(name), OsString::from(value));
            let own = |name: &OsStr| match name.to_str()? {
                "HOME" => Some(OsString::from("/home/me")),
                "LANG" => Some(OsString::from("C")),
                _ => None,
            };
            let variables = command_variables(
                vec![
                    pair("OC_CREDENTIALS", "/home/me/secrets"),
                    // The same as pumr has: nothing to add.
                    pair("HOME", "/home/me"),
                    // Set differently by the profile: the shell wins.
                    pair("LANG", "de_DE.UTF-8"),
                    // About the shell that was asked, not the user's setup.
                    pair("SHLVL", "2"),
                    pair("PWD", "/"),
                    pair("_", "/usr/bin/env"),
                    pair("TERM", "dumb"),
                    pair("PATH", "/usr/bin"),
                    // An exported bash function and other non-names.
                    pair("BASH_FUNC_nvm%%", "() { :; }"),
                    pair("1ST", "x"),
                    pair("", "x"),
                ],
                own,
            );
            assert_eq!(
                variables,
                vec![
                    pair("OC_CREDENTIALS", "/home/me/secrets"),
                    pair("LANG", "de_DE.UTF-8"),
                ]
            );
        }

        #[test]
        fn a_profile_that_leaves_something_running_does_not_hold_up_the_answer() {
            let directory = tempfile::tempdir().unwrap();
            let shell = fake_shell(directory.path(), "sleep 30 &\nPATH=/usr/bin:/bin");
            let started = Instant::now();
            assert_eq!(
                asked_path(&shell, Duration::from_secs(10)),
                Some("/usr/bin:/bin".into())
            );
            assert!(started.elapsed() < Duration::from_secs(10));
        }

        #[test]
        fn a_shell_that_does_not_answer_is_given_up_on() {
            let directory = tempfile::tempdir().unwrap();
            let hangs = fake_shell(directory.path(), "sleep 30");
            let started = Instant::now();
            assert_eq!(ask_shell(&hangs, Duration::from_millis(200)), None);
            assert!(started.elapsed() < Duration::from_secs(10));

            let other_syntax = fake_shell(directory.path(), "echo 'unknown option'; exit 1");
            assert_eq!(ask_shell(&other_syntax, Duration::from_secs(10)), None);
            assert_eq!(ask_shell(&directory.path().join("missing"), TIMEOUT), None);
        }

        #[test]
        fn output_without_every_marker_is_not_an_answer() {
            assert_eq!(parse(b""), None);
            assert_eq!(parse(format!("{START}/usr/bin").as_bytes()), None);
            assert_eq!(parse(format!("/usr/bin{END}").as_bytes()), None);
            // The list of variables is still being printed.
            assert_eq!(
                parse(format!("{START}/usr/bin{END}A=1\0B=").as_bytes()),
                None
            );
            assert_eq!(
                parse(format!("motd\n{START}/usr/bin:/bin{END}A=1\0B=x=y\0{ENV_END}\n").as_bytes()),
                Some(ShellAnswer {
                    path: "/usr/bin:/bin".into(),
                    variables: vec![("A".into(), "1".into()), ("B".into(), "x=y".into())],
                })
            );
        }

        #[test]
        fn the_shell_comes_first_and_nothing_of_the_own_path_is_lost() {
            let merged = |shell: &str, current: Option<&str>| {
                merge(OsStr::new(shell), current.map(OsStr::new))
                    .unwrap()
                    .into_string()
                    .unwrap()
            };
            assert_eq!(
                merged(
                    "/opt/homebrew/bin:/usr/bin:/bin:/opt/homebrew/bin",
                    Some("/usr/bin:/bin:/tmp/.mount_pumr/usr/bin"),
                ),
                "/opt/homebrew/bin:/usr/bin:/bin:/tmp/.mount_pumr/usr/bin"
            );
            assert_eq!(
                merged(".:node_modules/.bin:/usr/bin::bin", Some("/bin")),
                "/usr/bin:/bin"
            );
            assert_eq!(merged("/usr/bin", None), "/usr/bin");
            assert_eq!(merged("", Some("/usr/bin:/bin")), "/usr/bin:/bin");
            // pumr's own half is tidied like the shell's.
            assert_eq!(
                merged("/opt/tools/bin", Some("/usr/bin::bin:.:/bin:")),
                "/opt/tools/bin:/usr/bin:/bin"
            );
        }

        #[test]
        fn a_path_pumr_keeps_loses_its_empty_and_relative_entries() {
            let kept = |path: &str| {
                tidied(OsStr::new(path)).map(|path| path.into_string().unwrap())
            };
            assert_eq!(
                kept("/home/me/.nvm/bin::/usr/bin:node_modules/.bin:/bin:").as_deref(),
                Some("/home/me/.nvm/bin:/usr/bin:/bin")
            );
            assert_eq!(kept(".:/usr/bin").as_deref(), Some("/usr/bin"));
            // Nothing to leave out, and nothing that would be left.
            assert_eq!(kept("/usr/bin:/bin"), None);
            assert_eq!(kept(".:bin"), None);
            assert_eq!(kept(""), None);
        }
    }
}
