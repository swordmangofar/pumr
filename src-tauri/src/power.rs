use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use tokio::sync::watch;

enum PowerCommand {
    SetEnabled(bool),
    /// A turn of this chat started or ended.
    Acquire(String),
    Release(String),
    /// A turn of this chat does nothing but wait for its user, or stopped
    /// doing so.
    Park(String),
    Unpark(String),
}

/// Keeps the machine and display awake while one or more agent turns are running.
///
/// A turn that only waits for its user does not count: a permission prompt
/// nobody answers stays open for as long as it takes, and must not keep the
/// screen from locking and the machine from sleeping all that time.
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
    /// returned guard is dropped. `chat` names the chat the turn belongs to,
    /// so that [`Self::park`] can say which turn only waits.
    pub fn acquire(&self, chat: &str) -> KeepAwakeGuard {
        let _ = self.tx.send(PowerCommand::Acquire(chat.to_string()));
        KeepAwakeGuard {
            tx: self.tx.clone(),
            chat: chat.to_string(),
        }
    }

    /// Says that the turn of `chat` does nothing but wait for its user until
    /// the returned guard is dropped. A waiting turn does not keep the
    /// machine awake; every other running turn still does.
    pub fn park(&self, chat: &str) -> ParkGuard {
        let _ = self.tx.send(PowerCommand::Park(chat.to_string()));
        ParkGuard {
            tx: self.tx.clone(),
            chat: chat.to_string(),
        }
    }
}

pub struct KeepAwakeGuard {
    tx: Sender<PowerCommand>,
    chat: String,
}

impl Drop for KeepAwakeGuard {
    fn drop(&mut self) {
        let _ = self.tx.send(PowerCommand::Release(std::mem::take(&mut self.chat)));
    }
}

pub struct ParkGuard {
    tx: Sender<PowerCommand>,
    chat: String,
}

impl Drop for ParkGuard {
    fn drop(&mut self) {
        let _ = self.tx.send(PowerCommand::Unpark(std::mem::take(&mut self.chat)));
    }
}

/// Which turns run and which of them only wait, by chat.
#[derive(Default)]
struct Turns {
    active: HashMap<String, usize>,
    parked: HashMap<String, usize>,
}

impl Turns {
    fn apply(&mut self, command: PowerCommand) {
        let (counts, chat, more) = match command {
            PowerCommand::Acquire(chat) => (&mut self.active, chat, true),
            PowerCommand::Release(chat) => (&mut self.active, chat, false),
            PowerCommand::Park(chat) => (&mut self.parked, chat, true),
            PowerCommand::Unpark(chat) => (&mut self.parked, chat, false),
            PowerCommand::SetEnabled(_) => return,
        };
        if more {
            *counts.entry(chat).or_default() += 1;
        } else if let Some(count) = counts.get_mut(&chat) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&chat);
            }
        }
    }

    /// Whether a turn is running that does more than wait for its user.
    fn working(&self) -> bool {
        self.active.keys().any(|chat| !self.parked.contains_key(chat))
    }
}

struct Controller {
    enabled: bool,
    turns: Turns,
    assertion: Option<keepawake::KeepAwake>,
}

impl Controller {
    fn refresh(&mut self) {
        let should_hold = self.enabled && self.turns.working();
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
        turns: Turns::default(),
        assertion: None,
    };
    while let Ok(command) = rx.recv() {
        match command {
            PowerCommand::SetEnabled(value) => controller.enabled = value,
            command => controller.turns.apply(command),
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
    fn a_turn_that_only_waits_for_its_user_keeps_nothing_awake() {
        let mut turns = Turns::default();
        assert!(!turns.working());
        turns.apply(PowerCommand::Acquire("chat".into()));
        assert!(turns.working());

        // Its prompt went unanswered for a long time: the turn only waits.
        turns.apply(PowerCommand::Park("chat".into()));
        assert!(!turns.working());
        // Two prompts of the same turn wait; one answer is not both.
        turns.apply(PowerCommand::Park("chat".into()));
        turns.apply(PowerCommand::Unpark("chat".into()));
        assert!(!turns.working());

        // Another chat that works is not held back by the waiting one, and
        // a chat that waits without a turn changes nothing.
        turns.apply(PowerCommand::Acquire("other".into()));
        turns.apply(PowerCommand::Park("idle".into()));
        assert!(turns.working());
        turns.apply(PowerCommand::Release("other".into()));
        assert!(!turns.working());

        // The user answered: the turn works again until it ends.
        turns.apply(PowerCommand::Unpark("chat".into()));
        assert!(turns.working());
        turns.apply(PowerCommand::Release("chat".into()));
        assert!(!turns.working());
        // A release too many leaves nothing behind.
        turns.apply(PowerCommand::Release("chat".into()));
        turns.apply(PowerCommand::Unpark("idle".into()));
        assert!(turns.active.is_empty() && turns.parked.is_empty());
    }

    #[test]
    fn a_running_machine_has_not_just_woken() {
        let watch = SleepWatch::new();
        let woke = watch.subscribe();
        assert!(!watch.just_woke());
        assert_eq!(*woke.borrow(), 0);
    }
}
