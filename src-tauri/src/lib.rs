mod agent;
mod broker;
mod commands;
mod config;
mod db;
mod discovery;
mod error;
mod git;
mod mcp;
mod mentions;
mod models;
mod permissions;
mod power;
mod processes;
mod providers;
mod state;
mod tools;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            app.manage(state::AppState::new(db, data_dir, settings_path, settings));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_default_system_prompts,
            commands::get_default_modes,
            commands::save_settings,
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
            commands::create_session,
            commands::update_session,
            commands::archive_session,
            commands::delete_session,
            commands::list_messages,
            commands::get_spend,
            commands::get_spend_stats,
            commands::stop_generation,
            commands::resolve_permission,
            commands::resolve_question,
            commands::add_command_rule,
            commands::delete_command_rule,
            commands::add_website_rule,
            commands::delete_website_rule,
            commands::discover_mcp_sources,
            commands::discover_skills,
            commands::list_workspace_entries,
            commands::read_workspace_file,
            commands::write_workspace_file,
            commands::list_processes,
            commands::stop_process,
            commands::get_git_info,
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
