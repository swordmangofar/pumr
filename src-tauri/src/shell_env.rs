//! Gives pumr the `PATH` the user's terminal has.
//!
//! An app started from the macOS Finder or a Linux desktop launcher inherits
//! the session's bare `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), not
//! the one the shell profile builds. The commands the agent runs, MCP servers
//! and `git` would then find nothing that was installed with Homebrew, nvm,
//! cargo and the like. So the user's shell is asked once, at start, what its
//! `PATH` is.

/// Adopts the `PATH` of the user's login shell; a no-op on Windows, when
/// started from a terminal and when the shell cannot be asked. Must run before
/// any thread or webview exists, as it changes the environment.
pub fn adopt_login_shell_path() {
    #[cfg(unix)]
    if let Some(path) = unix::resolved_path() {
        std::env::set_var("PATH", path);
    }
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

    /// How long a slow profile may hold up the start of the app.
    const TIMEOUT: Duration = Duration::from_secs(5);

    pub fn resolved_path() -> Option<OsString> {
        // Started from a terminal, pumr already has that shell's PATH.
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
        let shell_path = ask_shell(&shell, TIMEOUT)?;
        let current = std::env::var_os("PATH");
        let merged = merge(&shell_path, current.as_deref())?;
        (Some(&merged) != current.as_ref()).then_some(merged)
    }

    /// The `PATH` of `shell` once it has loaded the user's profile, `None`
    /// when it does not answer in time or not in the expected form.
    fn ask_shell(shell: &Path, timeout: Duration) -> Option<OsString> {
        let mut command = Command::new(shell);
        command
            // Login and interactive, so both kinds of profile are read
            // (`.zprofile` and `.zshrc`, `.bash_profile` and `.bashrc`). The
            // script is one that zsh, bash and fish all understand.
            .args(["-i", "-l", "-c"])
            .arg(format!("printf '%s%s%s' {START} \"$PATH\" {END}"))
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
            let mut path = None;
            while path.is_none() {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => output.extend_from_slice(&chunk[..read]),
                }
                path = parse(&output);
            }
            let _ = sender.send(path);
        });
        let path = receiver.recv_timeout(timeout).ok().flatten();

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
        path
    }

    /// The text between the markers in the shell's output.
    fn parse(output: &[u8]) -> Option<OsString> {
        let start = find(output, START.as_bytes())? + START.len();
        let end = start + find(&output[start..], END.as_bytes())?;
        Some(OsStr::from_bytes(&output[start..end]).to_os_string())
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// The shell's directories, followed by those of pumr's own `PATH` the
    /// shell does not have. Relative entries of the shell are left out: they
    /// would resolve inside whichever project a command runs in, and the
    /// permission check trusts no executable while `PATH` has one.
    fn merge(shell: &OsStr, current: Option<&OsStr>) -> Option<OsString> {
        let mut directories: Vec<PathBuf> = Vec::new();
        let shell = std::env::split_paths(shell).filter(|directory| directory.is_absolute());
        let current = current.into_iter().flat_map(std::env::split_paths);
        for directory in shell.chain(current) {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
        std::env::join_paths(directories).ok()
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
                ask_shell(&shell, Duration::from_secs(10)),
                Some("/opt/homebrew/bin:/usr/bin:/bin".into())
            );
        }

        #[test]
        fn a_profile_that_leaves_something_running_does_not_hold_up_the_answer() {
            let directory = tempfile::tempdir().unwrap();
            let shell = fake_shell(directory.path(), "sleep 30 &\nPATH=/usr/bin:/bin");
            let started = Instant::now();
            assert_eq!(
                ask_shell(&shell, Duration::from_secs(10)),
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
        fn output_without_both_markers_is_not_a_path() {
            assert_eq!(parse(b""), None);
            assert_eq!(parse(format!("{START}/usr/bin").as_bytes()), None);
            assert_eq!(parse(format!("/usr/bin{END}").as_bytes()), None);
            assert_eq!(
                parse(format!("motd\n{START}/usr/bin:/bin{END}\n").as_bytes()),
                Some("/usr/bin:/bin".into())
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
        }
    }
}
