mod agent;
mod broker;
mod commands;
mod config;
mod db;
mod discovery;
mod error;
mod git;
mod marketplace;
mod mcp;
mod mentions;
mod models;
mod permissions;
mod power;
mod processes;
mod providers;
mod state;
mod tools;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let data_dir = app.path().app_data_dir()?;
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
            app.manage(state::AppState::new(db, data_dir, settings_path, settings));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_default_system_prompts,
            commands::get_default_modes,
            commands::save_settings,
            commands::suspend_window_shortcut,
            commands::set_api_key,
            commands::delete_api_key,
            commands::has_api_key,
            commands::list_models,
            commands::list_endpoints,
            commands::list_providers,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::update_project,
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
            commands::resolve_permission,
            commands::list_permission_audit,
            commands::clear_permission_audit,
            commands::resolve_question,
            commands::add_command_rule,
            commands::delete_command_rule,
            commands::get_file_ignore_catalog,
            commands::add_website_rule,
            commands::delete_website_rule,
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
            commands::list_workspace_entries,
            commands::read_workspace_file,
            commands::write_workspace_file,
            commands::list_processes,
            commands::stop_process,
            commands::get_git_info,
            commands::get_git_status,
            commands::get_git_refs,
            commands::get_git_commits,
            commands::get_git_commit,
            commands::get_git_commit_file_diff,
            commands::get_git_file_diff,
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
            commands::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
