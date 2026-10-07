mod agent;
mod app_icon;
mod appimage;
mod broker;
mod commands;
mod config;
mod control;
mod db;
mod debug_log;
mod discovery;
mod environment;
mod error;
mod git;
mod hooks;
mod marketplace;
mod mcp;
mod memory;
mod mentions;
mod model_match;
mod models;
mod permissions;
mod power;
mod processes;
mod project_env;
mod providers;
mod read_formats;
mod rendering;
mod sandbox;
mod screenshot;
mod shell_env;
mod shell_lex;
mod state;
mod terminal;
mod tools;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // `pumr --toggle` and its siblings end here when pumr is already running.
    // So does an ordinary start, which brings up that pumr's window: a second
    // one would open the same database, mark the turns running in the first
    // as cut off, and overwrite its settings.
    if control::handed_over(&context.config().identifier) {
        return;
    }
    let control = control::bind(&context.config().identifier);
    // Another start claimed the channel in the meantime, so that one is pumr.
    if control.is_none() && control::handed_over(&context.config().identifier) {
        return;
    }
    #[cfg(target_os = "linux")]
    window::init_x11_threads();
    appimage::isolate_gstreamer_registry(&context.config().identifier);
    shell_env::adopt_login_shell_environment();
    let startup = rendering::prepare(&context.config().identifier);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    log::info!("global shortcut event {shortcut} ({:?})", event.state());
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::toggle(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_data_dir = app.path().app_data_dir()?;
            let data_dir = config::data_folder(app_data_dir.clone());
            std::fs::create_dir_all(&data_dir)?;
            config::init_dev_store(&data_dir);
            let db = db::Db::open(&data_dir.join("pumr.sqlite"))?;
            db.migrate()?;
            let settings_path = data_dir.join("settings.json");
            let settings = config::load_settings(&settings_path);
            // Grant the asset protocol access to any user-selected background
            // image or custom sound that was saved previously.
            for path in [
                settings.appearance.background_image.as_str(),
                settings.interface.done_sound_path.as_str(),
                settings.interface.permission_sound_path.as_str(),
                settings.interface.error_sound_path.as_str(),
            ] {
                commands::allow_asset_path(app.handle(), path);
            }
            window::apply(app.handle(), &settings.window);
            #[cfg(target_os = "linux")]
            window::follow_desktop_dpi(app.handle());
            let state = state::AppState::new(db, data_dir, settings_path, settings);
            // The data folders hold every chat, the settings and the
            // snapshots, so the sandbox closes them to the agent's commands.
            // The skills the user installed lie in there as well, and the
            // agent runs their scripts, so those stay readable.
            state.permissions.set_private(sandbox::Private {
                folders: config::data_folders(&app_data_dir),
                shared: vec![state.marketplace.skills_dir()],
            });
            // Each chat gets a scratch folder here (see `LivePermissions`);
            // ones whose chat is gone are cleared on start.
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                // A debug build knows only its own chats (see
                // `config::data_folder`) and would clear the folders of the
                // installed pumr's, so it keeps its folders apart as well.
                let scratch = if cfg!(debug_assertions) {
                    "scratch.dev"
                } else {
                    "scratch"
                };
                state.permissions.set_scratch_root(cache_dir.join(scratch));
                let db = state.db.clone();
                state
                    .permissions
                    .prune_scratch_dirs(|id| db.get_session(id).is_ok());
            }
            app.manage(state);
            if let Some(control) = control {
                control.serve(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_default_system_prompts,
            commands::get_default_modes,
            commands::save_settings,
            commands::suspend_window_shortcut,
            commands::get_window_control,
            commands::get_sandbox_support,
            commands::is_software_rendered,
            commands::set_interface_zoom,
            commands::set_api_key,
            commands::delete_api_key,
            commands::has_api_key,
            commands::list_models,
            commands::list_endpoints,
            commands::list_providers,
            commands::list_llm_providers,
            commands::update_provider,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::update_project,
            commands::set_project_environment,
            commands::list_sessions,
            commands::list_sub_sessions,
            commands::list_sub_sessions_for_project,
            commands::create_session,
            commands::update_session,
            commands::set_session_auto_continue,
            commands::archive_session,
            commands::delete_session,
            commands::list_messages,
            commands::get_spend,
            commands::get_spend_stats,
            commands::stop_generation,
            commands::list_running_turns,
            commands::attach_session,
            commands::resolve_permission,
            commands::list_permission_audit,
            commands::clear_permission_audit,
            commands::resolve_question,
            commands::resolve_model_choice,
            commands::resolve_memory_suggestion,
            commands::add_command_rule,
            commands::delete_command_rule,
            commands::get_file_ignore_catalog,
            commands::add_website_rule,
            commands::delete_website_rule,
            commands::delete_mcp_tool_grant,
            commands::delete_secret_folder,
            commands::delete_path_folder,
            commands::discover_mcp_sources,
            commands::discover_skills,
            commands::search_mcp_marketplace,
            commands::browse_mcp_directory,
            commands::list_skill_marketplaces,
            commands::add_skill_marketplace,
            commands::remove_skill_marketplace,
            commands::install_marketplace_skills,
            commands::list_installed_marketplace_skills,
            commands::uninstall_marketplace_skills,
            commands::list_installed_mcp_servers,
            commands::install_mcp_server,
            commands::uninstall_mcp_server,
            commands::list_workspace_entries,
            commands::read_workspace_file,
            commands::write_workspace_file,
            commands::list_processes,
            commands::stop_process,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_busy,
            commands::terminal_close,
            commands::terminal_close_all,
            commands::get_git_info,
            commands::get_git_status,
            commands::get_git_refs,
            commands::get_git_commits,
            commands::get_git_commit,
            commands::get_git_commit_file_diff,
            commands::get_git_file_diff,
            commands::get_git_file_hunks,
            commands::git_apply_lines,
            commands::git_resolve_conflict,
            commands::git_cherry_pick,
            commands::git_revert,
            commands::git_reset,
            commands::git_checkout_commit,
            commands::git_generate_commit_message,
            commands::git_stage,
            commands::git_stage_paths,
            commands::git_unstage,
            commands::git_unstage_paths,
            commands::git_discard_paths,
            commands::get_git_blame,
            commands::git_ignore,
            commands::reveal_path,
            commands::git_commit,
            commands::git_checkout,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::git_fast_forward,
            commands::git_merge,
            commands::git_rebase,
            commands::git_rebase_interactive,
            commands::get_git_rebase_commits,
            commands::git_branch_create,
            commands::git_tag_create,
            commands::git_branch_rename,
            commands::git_branch_delete,
            commands::git_set_upstream,
            commands::git_push_branch,
            commands::git_pull_request_url,
            commands::open_external_url,
            commands::pick_asset_file,
            commands::git_operation_abort,
            commands::git_operation_continue,
            commands::git_stash_push,
            commands::git_stash_apply,
            commands::git_stash_pop,
            commands::git_stash_drop,
            commands::git_init,
            commands::git_clone,
            commands::git_tag_delete,
            commands::git_tag_push,
            commands::git_submodule_update,
            commands::get_session_changes,
            commands::get_file_diff,
            commands::get_project_rules,
            commands::revert_to_message,
            commands::summarize_session,
            commands::ask_side_question,
            commands::compact_session,
            commands::get_system_info,
            commands::get_permission_state,
            commands::find_sensitive_data,
            commands::save_debug_log,
            commands::send_message,
        ])
        .build(context)
        .expect("error while running tauri application")
        .run(move |app, event| match event {
            // Tauri puts the DEV badge icon in the Dock right before this, so
            // a logo picked in the settings has to follow it.
            tauri::RunEvent::Ready => {
                let logo = app.state::<state::AppState>().settings().appearance.logo;
                app_icon::apply(app, &logo);
            }
            tauri::RunEvent::Exit => {
                // Quitting before the start has settled is not a failed start.
                startup.settled();
                // A restart, as after an update, starts the next pumr from
                // here, which must find nobody to hand its start over to.
                control::release();
                // Nothing could show or stop them once pumr is gone: the
                // commands still running in the background and the MCP
                // servers end with it. A start that failed has no state yet.
                if let Some(state) = app.try_state::<state::AppState>() {
                    state.processes.stop_all();
                    state.mcp.shutdown();
                }
            }
            _ => {}
        });
}
