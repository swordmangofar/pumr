use crate::error::{AppError, Result};
use crate::models::ProcessInfo;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::process::Child;

pub struct RunningProcess {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: i64,
    pub output: Arc<Mutex<String>>,
    pub child: Arc<Mutex<Option<Child>>>,
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
        let mut processes: Vec<ProcessInfo> = self
            .processes
            .lock()
            .unwrap()
            .values()
            .map(|process| process.to_info())
            .collect();
        processes.sort_by_key(|process| process.started_at);
        processes
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let process = self
            .processes
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("Unknown process: {id}")))?;
        if let Some(child) = process.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
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
            output: truncate(&self.output.lock().unwrap()),
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
