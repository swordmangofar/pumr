use crate::error::{AppError, Result};
use crate::models::ProcessInfo;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::process::Child;

/// Output kept from the start of a command.
const OUTPUT_HEAD_BYTES: usize = 64 * 1024;
/// Latest output kept once a command has written more than the head holds.
const OUTPUT_TAIL_BYTES: usize = 256 * 1024;

/// A command's output in memory: its beginning and its latest part. What lies
/// between is dropped, so a dev server that logs for hours keeps a bounded
/// buffer.
#[derive(Debug, Default)]
pub struct OutputBuffer {
    head: String,
    tail: String,
    dropped: usize,
}

impl OutputBuffer {
    pub fn push(&mut self, text: &str) {
        let mut rest = text;
        if self.tail.is_empty() && self.head.len() < OUTPUT_HEAD_BYTES {
            let room = floor_char_boundary(rest, OUTPUT_HEAD_BYTES - self.head.len());
            self.head.push_str(&rest[..room]);
            rest = &rest[room..];
        }
        if rest.is_empty() {
            return;
        }
        self.tail.push_str(rest);
        // Trim only once the tail has doubled, so pushes stay cheap.
        if self.tail.len() > OUTPUT_TAIL_BYTES * 2 {
            let cut = ceil_char_boundary(&self.tail, self.tail.len() - OUTPUT_TAIL_BYTES);
            self.tail.drain(..cut);
            self.dropped += cut;
        }
    }

    /// The kept output, with a note where some was dropped.
    pub fn text(&self) -> String {
        if self.dropped == 0 {
            return format!("{}{}", self.head, self.tail);
        }
        format!(
            "{}\n\n…({} bytes of output omitted)…\n\n{}",
            self.head, self.dropped, self.tail
        )
    }
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// Stops a shell command together with everything it started. `run_bash`
/// starts each command in its own process group, so on Unix the whole group
/// is killed (a `npm run dev` would otherwise leave its server running); on
/// Windows `taskkill /T` ends the process tree.
pub fn kill_tree(child: &mut Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(group) = pid
        .and_then(|pid| libc::pid_t::try_from(pid).ok())
        .filter(|pid| *pid > 1)
    {
        // SAFETY: `kill` only sends a signal. A group that no longer exists
        // makes it fail with ESRCH, which changes nothing.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.start_kill();
}

pub struct RunningProcess {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub output: Arc<Mutex<OutputBuffer>>,
    pub child: Arc<Mutex<Option<Child>>>,
    /// The shell's process id, which is also its process group on Unix.
    pub pid: Option<u32>,
    pub running: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ProcessRegistry {
    processes: Mutex<HashMap<String, Arc<RunningProcess>>>,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, process: Arc<RunningProcess>) {
        self.processes
            .lock()
            .unwrap()
            .insert(process.id.clone(), process);
    }

    pub fn list(&self) -> Vec<ProcessInfo> {
        let mut guard = self.processes.lock().unwrap();
        guard.retain(|_, process| process.running.load(Ordering::SeqCst));
        let mut processes: Vec<ProcessInfo> =
            guard.values().map(|process| process.to_info()).collect();
        processes.sort_by_key(|process| process.started_at);
        processes
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let process = self
            .processes
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| AppError::msg(format!("Unknown process: {id}")))?;
        if let Some(child) = process.child.lock().unwrap().as_mut() {
            kill_tree(child, process.pid);
        }
        process.running.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn stop_for_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .processes
            .lock()
            .unwrap()
            .values()
            .filter(|process| process.session_id == session_id)
            .map(|process| process.id.clone())
            .collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
}

impl RunningProcess {
    pub fn to_info(&self) -> ProcessInfo {
        ProcessInfo {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at: self.started_at,
            running: self.running.load(Ordering::SeqCst),
            output: truncate(&self.output.lock().unwrap().text()),
        }
    }
}

fn truncate(output: &str) -> String {
    const MAX: usize = 20_000;
    if output.len() <= MAX {
        return output.to_string();
    }
    let mut start = output.len() - MAX;
    while !output.is_char_boundary(start) {
        start += 1;
    }
    format!("…(truncated)\n{}", &output[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_buffer_keeps_the_start_and_the_latest_output() {
        let mut buffer = OutputBuffer::default();
        buffer.push("start\n");
        let line = "x".repeat(1023) + "\n";
        for _ in 0..2_000 {
            buffer.push(&line);
        }
        buffer.push("end\n");
        let text = buffer.text();
        assert!(text.starts_with("start\n"));
        assert!(text.ends_with("end\n"));
        assert!(text.contains("bytes of output omitted"));
        assert!(text.len() < OUTPUT_HEAD_BYTES + 2 * OUTPUT_TAIL_BYTES + 100);
    }

    #[test]
    fn output_buffer_splits_on_character_boundaries() {
        let mut buffer = OutputBuffer::default();
        buffer.push(&"a".repeat(OUTPUT_HEAD_BYTES - 1));
        buffer.push("ü tail");
        assert_eq!(buffer.text(), format!("{}ü tail", "a".repeat(OUTPUT_HEAD_BYTES - 1)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn killing_a_command_stops_the_processes_it_started() {
        let marker = tempfile::tempdir().unwrap();
        let pid_file = marker.path().join("pid");
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()))
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let mut grandchild = None;
        for _ in 0..50 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(value) = text.trim().parse::<i32>() {
                    grandchild = Some(value);
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let grandchild = grandchild.expect("the background sleep started");
        kill_tree(&mut child, pid);
        let _ = child.wait().await;
        let mut gone = false;
        for _ in 0..50 {
            // SAFETY: signal 0 only checks whether the process exists.
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(gone, "the background sleep must be killed with its shell");
    }
}
