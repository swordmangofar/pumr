//! Interactive terminals the user opens inside pumr. Each one is a login shell
//! on a pseudo-terminal, so full-screen programs, colours and job control work
//! as in a regular terminal app. Unlike `run_bash`, these are driven by the
//! user and never by the agent.

use crate::error::{AppError, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// Bytes read from the terminal per chunk sent to the webview.
const READ_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Output { data: String },
    Exit { code: Option<u32> },
}

pub type TerminalSink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// The shell's process id, which is also its session and process group.
    pid: Option<u32>,
}

impl Terminal {
    /// Hangs up the shell and whatever runs in the foreground, as closing a
    /// terminal window does, then kills the shell in case it ignored that.
    fn hang_up(&self) {
        #[cfg(unix)]
        {
            let foreground = self.master.lock().unwrap().process_group_leader();
            let shell = self.pid.and_then(|pid| libc::pid_t::try_from(pid).ok());
            for group in [foreground, shell].into_iter().flatten() {
                if group > 1 {
                    // SAFETY: plain signal delivery to a process group.
                    unsafe {
                        libc::killpg(group, libc::SIGHUP);
                    }
                }
            }
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[derive(Default)]
pub struct TerminalRegistry {
    terminals: Arc<Mutex<HashMap<String, Arc<Terminal>>>>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts the user's login shell in `cwd` and streams its output to
    /// `sink` until it exits.
    pub fn open(&self, cwd: &Path, cols: u16, rows: u16, sink: TerminalSink) -> Result<String> {
        self.spawn(shell_command(cwd), cols, rows, sink)
    }

    fn spawn(
        &self,
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        sink: TerminalSink,
    ) -> Result<String> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(pty_error)?;
        let mut child = pair.slave.spawn_command(command).map_err(pty_error)?;
        // Only the shell may hold the terminal's other end, so its output ends
        // once the shell and everything it started have exited.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let mut writer = pair.master.take_writer().map_err(pty_error)?;
        let id = uuid::Uuid::new_v4().to_string();
        let (input, pending) = mpsc::channel::<Vec<u8>>();
        let terminal = Arc::new(Terminal {
            master: Mutex::new(pair.master),
            input,
            killer: Mutex::new(child.clone_killer()),
            pid: child.process_id(),
        });
        self.terminals.lock().unwrap().insert(id.clone(), terminal);

        // Writes go through one thread so a program that stops reading its
        // input never blocks a command, and keystrokes stay in order.
        std::thread::spawn(move || {
            for bytes in pending {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });

        let terminals = self.terminals.clone();
        let terminal_id = id.clone();
        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut buffer = vec![0u8; READ_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    // Linux reports a hung-up terminal as an error, not EOF.
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let data = decoder.decode(&buffer[..read]);
                        if !data.is_empty() {
                            sink(TerminalEvent::Output { data });
                        }
                    }
                }
            }
            let code = child.wait().ok().map(|status| status.exit_code());
            terminals.lock().unwrap().remove(&terminal_id);
            sink(TerminalEvent::Exit { code });
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let terminal = self.get(id)?;
        terminal
            .input
            .send(data.as_bytes().to_vec())
            .map_err(|_| AppError::msg("The terminal has exited"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let terminal = self.get(id)?;
        let master = terminal.master.lock().unwrap();
        master.resize(size(cols, rows)).map_err(pty_error)
    }

    /// Whether a program the shell started holds the terminal's foreground,
    /// so input would reach that program and not the shell's prompt. Windows
    /// cannot tell and answers no.
    pub fn busy(&self, id: &str) -> Result<bool> {
        let terminal = self.get(id)?;
        #[cfg(unix)]
        {
            let foreground = terminal.master.lock().unwrap().process_group_leader();
            let shell = terminal.pid.and_then(|pid| libc::pid_t::try_from(pid).ok());
            Ok(foreground
                .zip(shell)
                .is_some_and(|(foreground, shell)| foreground != shell))
        }
        #[cfg(not(unix))]
        {
            let _ = terminal;
            Ok(false)
        }
    }

    pub fn close(&self, id: &str) {
        let terminal = self.terminals.lock().unwrap().remove(id);
        if let Some(terminal) = terminal {
            terminal.hang_up();
        }
    }

    pub fn close_all(&self) {
        let terminals: Vec<_> = self.terminals.lock().unwrap().drain().collect();
        for (_, terminal) in terminals {
            terminal.hang_up();
        }
    }

    fn get(&self, id: &str) -> Result<Arc<Terminal>> {
        self.terminals
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("Unknown terminal: {id}")))
    }
}

/// The user's default shell, started as a login shell so it loads their
/// profile (a GUI app is not started with the PATH a terminal has).
fn shell_command(cwd: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new_default_prog();
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "pumr");
    // Apps started from the macOS Finder get no locale, which leaves shells
    // unable to show non-ASCII text.
    if cfg!(unix) && std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    command
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn pty_error(error: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("Terminal error: {error}"))
}

/// Decodes a byte stream as UTF-8 across reads: a character split between two
/// reads is held back until the rest arrives, and invalid bytes become U+FFFD.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    // SAFETY: `valid_up_to` marks the end of valid UTF-8.
                    text.push_str(unsafe { std::str::from_utf8_unchecked(valid) });
                    match error.error_len() {
                        Some(invalid) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[invalid..];
                        }
                        // An incomplete character at the end: wait for more.
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn utf8_stream_joins_characters_split_between_reads() {
        let mut stream = Utf8Stream::default();
        let bytes = "grüße".as_bytes();
        assert_eq!(stream.decode(&bytes[..3]), "gr");
        assert_eq!(stream.decode(&bytes[3..]), "üße");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.decode(b"a\xffb"), "a\u{fffd}b");
    }

    fn collect() -> (TerminalSink, Arc<Mutex<Vec<TerminalEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let sink: TerminalSink = Arc::new(move |event| recorded.lock().unwrap().push(event));
        (sink, events)
    }

    fn wait_for_exit(events: &Arc<Mutex<Vec<TerminalEvent>>>) -> Vec<TerminalEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = events.lock().unwrap().clone();
            if snapshot
                .iter()
                .any(|event| matches!(event, TerminalEvent::Exit { .. }))
            {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "terminal did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn output(events: &[TerminalEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data } => Some(data.as_str()),
                TerminalEvent::Exit { .. } => None,
            })
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_terminal_echoes_input_and_reports_its_exit() {
        let registry = TerminalRegistry::new();
        let (sink, events) = collect();
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("PS1", "");
        let id = registry.spawn(command, 80, 24, sink).unwrap();

        registry.resize(&id, 100, 30).unwrap();
        registry.write(&id, "echo pumr-$((20 + 22))\n").unwrap();
        registry.write(&id, "exit 3\n").unwrap();

        let events = wait_for_exit(&events);
        assert!(output(&events).contains("pumr-42"));
        assert_eq!(events.last(), Some(&TerminalEvent::Exit { code: Some(3) }));
        assert!(registry.write(&id, "echo late\n").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_terminal_is_busy_while_a_program_runs_in_its_foreground() {
        let registry = TerminalRegistry::new();
        let (sink, events) = collect();
        let id = registry
            .spawn(CommandBuilder::new("/bin/sh"), 80, 24, sink)
            .unwrap();
        assert!(!registry.busy(&id).unwrap());

        registry.write(&id, "sleep 30\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !registry.busy(&id).unwrap() {
            assert!(Instant::now() < deadline, "the terminal never got busy");
            std::thread::sleep(Duration::from_millis(20));
        }

        // Ctrl+C ends the program and hands the terminal back to the shell.
        registry.write(&id, "\x03").unwrap();
        while registry.busy(&id).unwrap() {
            assert!(Instant::now() < deadline, "the terminal stayed busy");
            std::thread::sleep(Duration::from_millis(20));
        }

        registry.close(&id);
        wait_for_exit(&events);
        assert!(registry.busy(&id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn closing_a_terminal_stops_what_runs_in_it() {
        let registry = TerminalRegistry::new();
        let (sink, events) = collect();
        let id = registry
            .spawn(CommandBuilder::new("/bin/sh"), 80, 24, sink)
            .unwrap();
        registry.write(&id, "sleep 30\n").unwrap();
        std::thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        registry.close(&id);
        wait_for_exit(&events);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
