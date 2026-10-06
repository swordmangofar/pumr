use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use tokio::sync::watch;

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

    /// Applied when the setting changes; takes effect at once, also for turns
    /// that are already running.
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

/// How often [`SleepWatch`] looks at the clock.
const SLEEP_TICK: Duration = Duration::from_secs(5);
/// A tick that comes this much later than it should means the machine slept:
/// nothing else keeps a thread from running for that long.
const SLEEP_GAP: Duration = Duration::from_secs(60);

/// Notices when the machine comes back from sleep or hibernation.
///
/// The operating systems report that each in their own way, but a sleeping
/// machine runs no threads: a thread that looks at the wall clock every few
/// seconds sees it jump ahead once it runs again.
pub struct SleepWatch {
    woke: watch::Sender<u64>,
    /// When the watching thread last looked at the clock.
    last_tick: Arc<Mutex<SystemTime>>,
    /// Dropping it ends the watching thread.
    _alive: Sender<()>,
}

impl SleepWatch {
    pub fn new() -> Self {
        let (woke, _) = watch::channel(0u64);
        let (alive, dropped) = mpsc::channel::<()>();
        let last_tick = Arc::new(Mutex::new(SystemTime::now()));
        let (sender, last) = (woke.clone(), last_tick.clone());
        thread::Builder::new()
            .name("pumr-sleep-watch".to_string())
            .spawn(move || {
                while let Err(RecvTimeoutError::Timeout) = dropped.recv_timeout(SLEEP_TICK) {
                    let now = SystemTime::now();
                    let before = std::mem::replace(&mut *last.lock().unwrap(), now);
                    if slept(before, now) {
                        log::info!("the machine woke from sleep");
                        sender.send_modify(|wakes| *wakes += 1);
                    }
                }
            })
            .expect("failed to spawn sleep-watch thread");
        Self {
            woke,
            last_tick,
            _alive: alive,
        }
    }

    /// Changes each time the machine wakes from sleep.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.woke.subscribe()
    }

    /// Whether the machine woke from sleep so recently that `subscribe` has
    /// not told yet. A connection that broke in its sleep can fail first.
    pub fn just_woke(&self) -> bool {
        slept(*self.last_tick.lock().unwrap(), SystemTime::now())
    }
}

/// Whether the time from one tick of the watch to the next (or to now) means
/// the machine slept in between. A clock that was set back is not a sleep.
fn slept(tick: SystemTime, next: SystemTime) -> bool {
    next.duration_since(tick).unwrap_or_default() > SLEEP_TICK + SLEEP_GAP
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_long_gap_between_ticks_counts_as_sleep() {
        let tick = SystemTime::now();
        let after = |seconds: u64| tick + Duration::from_secs(seconds);
        assert!(!slept(tick, tick + SLEEP_TICK));
        // A busy machine runs the thread late, not a minute late.
        assert!(!slept(tick, after(25)));
        assert!(slept(tick, tick + SLEEP_TICK + SLEEP_GAP + Duration::from_secs(1)));
        assert!(slept(tick, after(8 * 60 * 60)));
        // The clock was set back.
        assert!(!slept(after(8 * 60 * 60), tick));
    }

    #[test]
    fn a_running_machine_has_not_just_woken() {
        let watch = SleepWatch::new();
        let woke = watch.subscribe();
        assert!(!watch.just_woke());
        assert_eq!(*woke.borrow(), 0);
    }
}
