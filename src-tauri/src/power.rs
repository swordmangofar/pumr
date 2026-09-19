use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

enum PowerCommand {
    SetEnabled(bool),
    Acquire,
    Release,
}

/// Keeps the machine and display awake while one or more agent turns are running.
///
/// The actual OS assertion is owned by a dedicated thread. This matters on
/// Windows, where `SetThreadExecutionState` is bound to the calling thread:
/// creating and releasing the assertion from the same thread keeps the state
/// consistent even though agent turns run on the async runtime.
#[derive(Clone)]
pub struct PowerManager {
    tx: Sender<PowerCommand>,
}

impl PowerManager {
    pub fn new(enabled: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("pumr-keep-awake".to_string())
            .spawn(move || run(rx, enabled))
            .expect("failed to spawn keep-awake thread");
        Self { tx }
    }

    /// Applied when the setting changes; takes effect on the next acquire.
    pub fn set_enabled(&self, enabled: bool) {
        let _ = self.tx.send(PowerCommand::SetEnabled(enabled));
    }

    /// Prevents the screen from locking and the system from sleeping until the
    /// returned guard is dropped.
    pub fn acquire(&self) -> KeepAwakeGuard {
        let _ = self.tx.send(PowerCommand::Acquire);
        KeepAwakeGuard {
            tx: self.tx.clone(),
        }
    }
}

pub struct KeepAwakeGuard {
    tx: Sender<PowerCommand>,
}

impl Drop for KeepAwakeGuard {
    fn drop(&mut self) {
        let _ = self.tx.send(PowerCommand::Release);
    }
}

struct Controller {
    enabled: bool,
    active: usize,
    assertion: Option<keepawake::KeepAwake>,
}

impl Controller {
    fn refresh(&mut self) {
        let should_hold = self.enabled && self.active > 0;
        match (should_hold, self.assertion.is_some()) {
            (true, false) => match acquire_assertion() {
                Ok(assertion) => self.assertion = Some(assertion),
                Err(error) => log::warn!("could not prevent sleep: {error}"),
            },
            (false, true) => self.assertion = None,
            _ => {}
        }
    }
}

fn acquire_assertion() -> keepawake::Result<keepawake::KeepAwake> {
    keepawake::Builder::default()
        .display(true)
        .idle(true)
        .reason("pumr agent is running")
        .app_name("pumr")
        .app_reverse_domain("dev.pumr.app")
        .create()
}

fn run(rx: Receiver<PowerCommand>, enabled: bool) {
    let mut controller = Controller {
        enabled,
        active: 0,
        assertion: None,
    };
    while let Ok(command) = rx.recv() {
        match command {
            PowerCommand::SetEnabled(value) => controller.enabled = value,
            PowerCommand::Acquire => controller.active += 1,
            PowerCommand::Release => controller.active = controller.active.saturating_sub(1),
        }
        controller.refresh();
    }
}
