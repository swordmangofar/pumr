//! Controls the window of a running pumr from the command line:
//! `pumr --toggle`, `--open`, `--minimize` and `--hide`.
//!
//! A start that carries one of these flags hands the action to the pumr that
//! is already running and ends before a window or webview exists. This is how
//! pumr gets a summon key on Wayland: applications cannot register system-wide
//! shortcuts there, so the key is bound in the desktop's keyboard settings to
//! run `pumr --toggle`. The compositor gives the command it starts an
//! activation token, the one thing that lets a window come to the front on
//! Wayland, and the token travels along with the action.
//!
//! An ordinary start does the same while a pumr is running, as if it carried
//! `--open`: two of them would work on one database and one settings file.
//!
//! The two processes talk over a Unix socket, or a named pipe on Windows, that
//! only the user's own processes can write to.

use serde::Serialize;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

/// A message is an action name and an activation token, far below this.
const MAX_MESSAGE: u64 = 4096;
/// How long a peer gets to send or take a message.
const TIMEOUT: Duration = Duration::from_secs(1);

/// What a command-line flag asks the window to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// What the window shortcut does: summon pumr, or hide/minimize it when it
    /// is the window in use.
    Toggle,
    Open,
    Minimize,
    Hide,
}

/// The flags without their `--`, which are also the names sent to the running
/// pumr.
const ACTIONS: [(&str, Action); 4] = [
    ("toggle", Action::Toggle),
    ("open", Action::Open),
    ("minimize", Action::Minimize),
    ("hide", Action::Hide),
];

impl Action {
    fn from_name(name: &str) -> Option<Self> {
        ACTIONS
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, action)| *action)
    }

    fn name(self) -> &'static str {
        ACTIONS
            .iter()
            .find(|(_, action)| *action == self)
            .map_or("", |(name, _)| name)
    }

    /// Whether the action starts pumr when it is not running yet.
    fn starts_pumr(self) -> bool {
        matches!(self, Self::Toggle | Self::Open)
    }
}

/// A window action on its way to the running pumr.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Request {
    action: Action,
    /// Wayland: lets the window take the focus on behalf of whoever started
    /// the command, such as the compositor's own shortcut.
    activation_token: Option<String>,
}

impl Request {
    /// Reads the action from a process's arguments, where the first flag wins,
    /// and the activation token from its environment.
    fn from_args(
        args: impl IntoIterator<Item = String>,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> Option<Self> {
        let action = args
            .into_iter()
            .find_map(|arg| Action::from_name(arg.strip_prefix("--")?))?;
        Some(Self {
            action,
            activation_token: activation_token(var),
        })
    }

    /// What a start asks of a pumr that is already running: the action of its
    /// flag, or its window when it is an ordinary start. Starting pumr again
    /// is meant to bring it up, and two of them would work on one database
    /// and one settings file.
    fn of_start(
        args: impl IntoIterator<Item = String>,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> Self {
        Self::from_args(args, &var).unwrap_or_else(|| Self {
            action: Action::Open,
            activation_token: activation_token(&var),
        })
    }

    /// Offers the request to the running pumr through `send`. Returns whether
    /// the process that asks is done: the request was delivered, or there is
    /// no pumr to hide or minimize. Otherwise this process becomes the pumr.
    fn hand_over(&self, send: impl FnOnce(&str) -> bool) -> bool {
        send(&self.encode()) || !self.action.starts_pumr()
    }

    fn encode(&self) -> String {
        format!(
            "{}\n{}\n",
            self.action.name(),
            self.activation_token.as_deref().unwrap_or_default()
        )
    }

    fn decode(message: &str) -> Option<Self> {
        let mut lines = message.lines();
        let action = Action::from_name(lines.next()?)?;
        let activation_token = lines
            .next()
            .filter(|token| !token.is_empty())
            .map(str::to_string);
        Some(Self {
            action,
            activation_token,
        })
    }
}

/// The token that lets a window take the focus on behalf of this process, from
/// the environment the desktop started it with.
fn activation_token(var: impl Fn(&str) -> Option<OsString>) -> Option<String> {
    ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"]
        .iter()
        .filter_map(|key| var(key)?.into_string().ok())
        .find(|token| !token.is_empty() && !token.contains(['\n', '\r']))
}

/// The name the control channel is derived from. A debug build has a channel
/// of its own: it shares the identifier with an installed pumr, and `tauri
/// dev` has to start next to that one instead of bringing up its window.
fn channel(identifier: &str) -> String {
    if cfg!(debug_assertions) {
        format!("{identifier}.dev")
    } else {
        identifier.to_string()
    }
}

/// Passes what this start asks for on to the pumr that is already running: the
/// window action of its flag, or, for an ordinary start, to open the window.
/// Returns whether this process is done: the request was delivered, or there
/// is no pumr to hide or minimize. Anything else without a running pumr is an
/// ordinary start.
pub fn handed_over(identifier: &str) -> bool {
    let request = Request::of_start(std::env::args().skip(1), env);
    request.hand_over(|message| transport::send(&channel(identifier), message))
}

/// The end the running pumr takes window actions on.
pub struct Listener(transport::Listener);

/// Claims the control channel for this process. Done before the slow part of a
/// start, so a second press of the key waits for this pumr instead of starting
/// another. `None` when another pumr already answers on the channel, or it
/// cannot be set up.
pub fn bind(identifier: &str) -> Option<Listener> {
    transport::bind(&channel(identifier)).map(Listener)
}

/// Gives the control channel up when this pumr ends. A pumr that restarts
/// itself, as after an update, starts its successor before it is gone, and
/// the successor would hand its start over to it and end as well.
pub fn release() {
    transport::release();
}

impl Listener {
    /// Starts carrying out the actions that arrive, including the ones that
    /// queued up since [`bind`].
    pub fn serve(self, app: AppHandle) {
        transport::serve(self.0, move |message| {
            // An empty message is another pumr checking whether this one answers.
            if let Some(request) = Request::decode(&message) {
                crate::window::perform(&app, request.action, request.activation_token);
            }
        });
    }
}

/// How the window can be summoned on this desktop, for the settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControl {
    /// The command line that toggles the window, to bind to a key in the
    /// desktop's keyboard settings.
    pub toggle_command: String,
    /// False on Wayland, whose compositors keep system-wide shortcuts to
    /// themselves: the one pumr registers only fires while an X11 application
    /// has the keyboard.
    pub global_shortcut: bool,
    /// Why the system-wide shortcut could not be registered the last time it
    /// was applied, typically because another application holds the
    /// combination. `None` while it is registered or switched off.
    pub shortcut_error: Option<String>,
}

pub fn window_control() -> WindowControl {
    // The AppImage is mounted at a new path on each launch; the file is what
    // a shortcut has to run.
    let executable = env("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok());
    WindowControl {
        toggle_command: toggle_command(executable),
        global_shortcut: !(cfg!(target_os = "linux") && crate::rendering::wayland_session(env)),
        shortcut_error: crate::window::shortcut_error(),
    }
}

fn toggle_command(executable: Option<PathBuf>) -> String {
    let program = executable.map_or_else(
        || "pumr".to_string(),
        |path| path.to_string_lossy().into_owned(),
    );
    let flag = Action::Toggle.name();
    if program.contains(char::is_whitespace) {
        format!("\"{program}\" --{flag}")
    } else {
        format!("{program} --{flag}")
    }
}

fn env(key: &str) -> Option<OsString> {
    std::env::var_os(key)
}

#[cfg(unix)]
mod transport {
    use super::{env, MAX_MESSAGE, TIMEOUT};
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    pub type Listener = UnixListener;

    /// Where the socket lives: the runtime directory on Linux, which is the
    /// user's own, local and cleared at logout, and the app's data directory
    /// otherwise.
    pub(super) fn socket_path(
        identifier: &str,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> Option<PathBuf> {
        let absolute = |key: &str| {
            var(key)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        if cfg!(target_os = "linux") {
            if let Some(runtime) = absolute("XDG_RUNTIME_DIR") {
                return Some(runtime.join(format!("{identifier}.sock")));
            }
        }
        let home = absolute("HOME")?;
        let data = if cfg!(target_os = "macos") {
            home.join("Library/Application Support")
        } else {
            absolute("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share"))
        };
        Some(data.join(identifier).join("control.sock"))
    }

    pub fn send(identifier: &str, message: &str) -> bool {
        socket_path(identifier, env).is_some_and(|path| send_to(&path, message))
    }

    pub(super) fn send_to(path: &Path, message: &str) -> bool {
        let Ok(mut stream) = UnixStream::connect(path) else {
            return false;
        };
        let _ = stream.set_write_timeout(Some(TIMEOUT));
        stream.write_all(message.as_bytes()).is_ok()
    }

    /// The socket this pumr answers on, until it gives it up.
    static OWNED: Mutex<Option<PathBuf>> = Mutex::new(None);

    pub fn bind(identifier: &str) -> Option<Listener> {
        let path = socket_path(identifier, env)?;
        let listener = bind_at(&path)?;
        *OWNED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path);
        Some(listener)
    }

    pub fn release() {
        let owned = OWNED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(path) = owned {
            release_at(&path);
        }
    }

    /// Without its file the socket takes no new connections: the next pumr
    /// finds nobody to hand over to and binds a socket of its own.
    pub(super) fn release_at(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    pub(super) fn bind_at(path: &Path) -> Option<Listener> {
        // The socket file outlives a pumr that crashed. One that still answers
        // belongs to a running pumr, which keeps it.
        if UnixStream::connect(path).is_ok() {
            return None;
        }
        let _ = std::fs::remove_file(path);
        std::fs::create_dir_all(path.parent()?).ok()?;
        let listener = UnixListener::bind(path).ok()?;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        Some(listener)
    }

    pub fn serve(listener: Listener, handle: impl Fn(String) + Send + 'static) {
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    std::thread::sleep(TIMEOUT);
                    continue;
                };
                let _ = stream.set_read_timeout(Some(TIMEOUT));
                let mut message = Vec::new();
                let _ = stream.take(MAX_MESSAGE).read_to_end(&mut message);
                handle(String::from_utf8_lossy(&message).into_owned());
            }
        });
    }
}

#[cfg(windows)]
mod transport {
    use super::{MAX_MESSAGE, TIMEOUT};
    use std::io::Write;
    use std::sync::Mutex;
    use tokio::io::AsyncReadExt;
    use tokio::net::windows::named_pipe::ServerOptions;

    /// The pipe's name. The pipe itself is created in [`serve`], inside the
    /// async runtime it needs.
    pub type Listener = String;

    const ERROR_PIPE_BUSY: i32 = 231;

    fn pipe_name(identifier: &str) -> String {
        // Pipe names are shared by everyone signed in to the machine.
        let user = std::env::var("USERNAME").unwrap_or_default();
        format!(r"\\.\pipe\{identifier}.{user}.control")
    }

    pub fn send(identifier: &str, message: &str) -> bool {
        let name = pipe_name(identifier);
        // The pipe is busy for a moment while pumr takes another message.
        for _ in 0..20 {
            match std::fs::OpenOptions::new().write(true).open(&name) {
                Ok(mut pipe) => return pipe.write_all(message.as_bytes()).is_ok(),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    std::thread::sleep(TIMEOUT / 20);
                }
                Err(_) => return false,
            }
        }
        false
    }

    pub fn bind(identifier: &str) -> Option<Listener> {
        Some(pipe_name(identifier))
    }

    /// The task that answers on the pipe, until this pumr gives the pipe up.
    static SERVING: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

    pub fn release() {
        let serving = SERVING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(task) = serving {
            // The task holds every instance of the pipe, so the pipe is gone
            // once the task is. One that is busy with a message is not waited
            // for longer than the message may take.
            task.abort();
            let _ = tauri::async_runtime::block_on(async {
                tokio::time::timeout(TIMEOUT, task).await
            });
        }
    }

    pub fn serve(name: Listener, handle: impl Fn(String) + Send + 'static) {
        let task = tauri::async_runtime::spawn(async move {
            // Fails when another pumr owns the pipe, which keeps it.
            let Ok(mut server) = ServerOptions::new().first_pipe_instance(true).create(&name)
            else {
                return;
            };
            loop {
                if server.connect().await.is_err() {
                    return;
                }
                // The next client needs an instance to connect to while this
                // one is read.
                let Ok(next) = ServerOptions::new().create(&name) else {
                    return;
                };
                let mut pipe = std::mem::replace(&mut server, next).take(MAX_MESSAGE);
                let mut message = Vec::new();
                let _ = tokio::time::timeout(TIMEOUT, pipe.read_to_end(&mut message)).await;
                handle(String::from_utf8_lossy(&message).into_owned());
            }
        });
        *SERVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(task);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(vars: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<OsString> {
        move |key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.into())
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn flags_name_the_window_action() {
        for (flag, action) in [
            ("--toggle", Action::Toggle),
            ("--open", Action::Open),
            ("--minimize", Action::Minimize),
            ("--hide", Action::Hide),
        ] {
            let request = Request::from_args(args(&[flag]), lookup(vec![])).unwrap();
            assert_eq!(request.action, action);
            assert_eq!(request.activation_token, None);
        }
        // The first one wins; anything else on the command line is not pumr's.
        let request = Request::from_args(args(&["-psn_0_1", "--open", "--hide"]), lookup(vec![]));
        assert_eq!(request.unwrap().action, Action::Open);
    }

    #[test]
    fn an_ordinary_start_carries_no_action() {
        let starts: [&[&str]; 5] = [&[], &["toggle"], &["--toggled"], &["-toggle"], &["--"]];
        for list in starts {
            assert_eq!(Request::from_args(args(list), lookup(vec![])), None);
        }
    }

    #[test]
    fn an_ordinary_start_asks_the_running_pumr_for_its_window() {
        let request = Request::of_start(
            args(&["-psn_0_1"]),
            lookup(vec![("XDG_ACTIVATION_TOKEN", "launcher")]),
        );
        assert_eq!(
            request,
            Request {
                action: Action::Open,
                activation_token: Some("launcher".to_string()),
            }
        );
        // A flag still says what the start is for.
        let request = Request::of_start(args(&["--hide"]), lookup(vec![]));
        assert_eq!(request.action, Action::Hide);
    }

    #[test]
    fn a_start_becomes_the_pumr_only_when_none_takes_its_request() {
        let start = |list: &[&str]| Request::of_start(args(list), lookup(vec![]));
        let starts: [&[&str]; 5] = [&[], &["--toggle"], &["--open"], &["--minimize"], &["--hide"]];
        // A running pumr took the request, so this process is done.
        for list in starts {
            assert!(start(list).hand_over(|_| true), "{list:?}");
        }
        // Nobody answers: opening starts pumr, and there is nothing to hide.
        for (list, done) in starts.into_iter().zip([false, false, false, true, true]) {
            assert_eq!(start(list).hand_over(|_| false), done, "{list:?}");
        }
    }

    #[test]
    fn a_debug_build_keeps_a_channel_of_its_own() {
        let expected = if cfg!(debug_assertions) {
            "dev.pumr.app.dev"
        } else {
            "dev.pumr.app"
        };
        assert_eq!(channel("dev.pumr.app"), expected);
    }

    #[test]
    fn the_settings_are_told_why_the_shortcut_is_not_registered() {
        let control = |shortcut_error: Option<&str>| {
            serde_json::to_value(WindowControl {
                toggle_command: "pumr --toggle".to_string(),
                global_shortcut: true,
                shortcut_error: shortcut_error.map(str::to_string),
            })
            .unwrap()
        };
        assert_eq!(
            control(None),
            serde_json::json!({
                "toggleCommand": "pumr --toggle",
                "globalShortcut": true,
                "shortcutError": null,
            })
        );
        assert_eq!(
            control(Some("HotKey already registered"))["shortcutError"],
            "HotKey already registered"
        );
    }

    #[test]
    fn the_activation_token_comes_from_the_environment() {
        let token = |vars| {
            Request::from_args(args(&["--toggle"]), lookup(vars))
                .unwrap()
                .activation_token
        };
        assert_eq!(
            token(vec![
                ("DESKTOP_STARTUP_ID", "startup"),
                ("XDG_ACTIVATION_TOKEN", "activation"),
            ])
            .as_deref(),
            Some("activation")
        );
        assert_eq!(
            token(vec![("DESKTOP_STARTUP_ID", "startup")]).as_deref(),
            Some("startup")
        );
        assert_eq!(
            token(vec![
                ("XDG_ACTIVATION_TOKEN", ""),
                ("DESKTOP_STARTUP_ID", "startup"),
            ])
            .as_deref(),
            Some("startup")
        );
        // A token that would not survive the trip is left behind.
        assert_eq!(token(vec![("XDG_ACTIVATION_TOKEN", "two\nlines")]), None);
    }

    #[test]
    fn requests_survive_the_trip() {
        for action in [Action::Toggle, Action::Open, Action::Minimize, Action::Hide] {
            for activation_token in [None, Some("cosmic-1f3a_TIME42".to_string())] {
                let request = Request {
                    action,
                    activation_token,
                };
                assert_eq!(Request::decode(&request.encode()), Some(request));
            }
        }
    }

    #[test]
    fn anything_else_on_the_channel_is_ignored() {
        for message in ["", "\n", "quit\n", "toggle now\n", "--toggle\n"] {
            assert_eq!(Request::decode(message), None);
        }
    }

    #[test]
    fn only_opening_starts_pumr() {
        assert!(Action::Toggle.starts_pumr());
        assert!(Action::Open.starts_pumr());
        assert!(!Action::Minimize.starts_pumr());
        assert!(!Action::Hide.starts_pumr());
    }

    #[test]
    fn the_toggle_command_runs_this_install() {
        assert_eq!(
            toggle_command(Some("/usr/bin/pumr".into())),
            "/usr/bin/pumr --toggle"
        );
        assert_eq!(
            toggle_command(Some("/home/ada/My Apps/pumr.AppImage".into())),
            "\"/home/ada/My Apps/pumr.AppImage\" --toggle"
        );
        assert_eq!(toggle_command(None), "pumr --toggle");
    }

    #[cfg(unix)]
    mod socket {
        use super::super::transport::{bind_at, release_at, send_to, serve, socket_path};
        use super::super::{Action, Request};
        use super::lookup;
        use std::path::PathBuf;
        use std::sync::mpsc;
        use std::time::Duration;

        #[test]
        fn the_socket_is_the_users_own() {
            let path = |vars| socket_path("dev.pumr.app", lookup(vars));
            let home = if cfg!(target_os = "macos") {
                "/home/ada/Library/Application Support/dev.pumr.app/control.sock"
            } else {
                "/home/ada/.local/share/dev.pumr.app/control.sock"
            };
            assert_eq!(path(vec![("HOME", "/home/ada")]), Some(PathBuf::from(home)));
            // A relative directory would depend on where pumr was started.
            assert_eq!(
                path(vec![("HOME", "/home/ada"), ("XDG_RUNTIME_DIR", "run")]),
                Some(PathBuf::from(home))
            );
            assert_eq!(path(vec![]), None);

            if cfg!(target_os = "linux") {
                assert_eq!(
                    path(vec![
                        ("HOME", "/home/ada"),
                        ("XDG_RUNTIME_DIR", "/run/user/1000")
                    ]),
                    Some(PathBuf::from("/run/user/1000/dev.pumr.app.sock"))
                );
                assert_eq!(
                    path(vec![("HOME", "/home/ada"), ("XDG_DATA_HOME", "/data")]),
                    Some(PathBuf::from("/data/dev.pumr.app/control.sock"))
                );
            }
        }

        #[test]
        fn a_running_pumr_takes_the_messages_sent_to_it() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("pumr/control.sock");

            // Nothing is running: there is nobody to take the message.
            assert!(!send_to(&path, "toggle\n\n"));

            let listener = bind_at(&path).unwrap();
            // Sent before pumr is ready, taken once it is.
            assert!(send_to(&path, "open\ntoken\n"));
            let (tx, rx) = mpsc::channel();
            serve(listener, move |message| tx.send(message).unwrap());
            assert!(send_to(&path, "toggle\n\n"));

            let wait = Duration::from_secs(5);
            assert_eq!(rx.recv_timeout(wait).unwrap(), "open\ntoken\n");
            assert_eq!(rx.recv_timeout(wait).unwrap(), "toggle\n\n");
        }

        #[test]
        fn a_second_pumr_leaves_the_channel_to_the_first() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("control.sock");

            let first = bind_at(&path).unwrap();
            assert!(bind_at(&path).is_none());
            // The first still answers after the second one's attempt.
            assert!(send_to(&path, "toggle\n\n"));

            // Its socket file stays behind when it ends; the next pumr takes over.
            drop(first);
            assert!(path.exists());
            // A test running next to this one may be starting a program just
            // now, which holds a copy of the socket until it has started.
            let mut closed = false;
            for _ in 0..100 {
                if !send_to(&path, "toggle\n\n") {
                    closed = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(closed);
            assert!(bind_at(&path).is_some());
        }

        #[test]
        fn a_second_ordinary_start_brings_up_the_first_pumr_and_ends() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("control.sock");
            let start = || Request::of_start(Vec::new(), lookup(vec![]));

            // Nobody answers, so this start is the pumr.
            assert!(!start().hand_over(|message| send_to(&path, message)));
            let (tx, rx) = mpsc::channel();
            serve(bind_at(&path).unwrap(), move |message| {
                tx.send(message).unwrap()
            });

            // The next one is done once the first has its request.
            assert!(start().hand_over(|message| send_to(&path, message)));
            let taken = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                Request::decode(&taken).map(|request| request.action),
                Some(Action::Open)
            );
        }

        #[test]
        fn a_pumr_that_restarts_itself_leaves_the_channel_to_its_successor() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("control.sock");
            let ending = bind_at(&path).unwrap();
            assert!(send_to(&path, "open\n\n"));

            // It starts its successor before it is gone. Still answering, it
            // would be handed that start, and both would end.
            release_at(&path);
            assert!(!send_to(&path, "open\n\n"));
            let successor = bind_at(&path);
            assert!(successor.is_some());
            drop(ending);
            assert!(send_to(&path, "open\n\n"));
        }
    }
}
