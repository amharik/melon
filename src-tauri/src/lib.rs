use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub struct AppState {
    pub agent_windows: Mutex<HashMap<String, String>>,
    pub agent_messages: Mutex<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentWindowConfig {
    pub id: String,
    pub title: String,
    pub url: String,
    pub visible: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CliRunRequest {
    pub run_id: String,
    pub agent_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub prompt: String,
    pub cwd: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CliChunkEvent {
    pub run_id: String,
    pub agent_name: String,
    pub chunk: String,
    pub is_done: bool,
    pub is_error: bool,
}

mod commands {
    use super::*;

    #[tauri::command]
    pub fn ping() -> String {
        "melon-tauri-ok".to_string()
    }

    #[tauri::command]
    pub async fn spawn_agent_window(
        app: AppHandle,
        state: tauri::State<'_, AppState>,
        config: AgentWindowConfig,
    ) -> Result<bool, String> {
        let mut wins = state.agent_windows.lock().map_err(|e| e.to_string())?;

        if let Some(existing) = app.get_webview_window(&config.id) {
            if config.visible.unwrap_or(true) {
                existing.show().map_err(|e| e.to_string())?;
                existing.set_focus().map_err(|e| e.to_string())?;
            } else {
                existing.hide().map_err(|e| e.to_string())?;
            }
            return Ok(true);
        }

        let parsed_url = Url::parse(&config.url).map_err(|e| e.to_string())?;
        let is_vis = config.visible.unwrap_or(false);
        let app_handle = app.clone();
        let agent_id = config.id.clone();

        let builder = WebviewWindowBuilder::new(
            &app,
            &config.id,
            WebviewUrl::External(parsed_url),
        )
        .title(&config.title)
        .inner_size(1024.0, 768.0)
        .visible(is_vis)
        .on_navigation(move |nav_url| {
            if nav_url.scheme() == "melon-bridge" {
                let id = nav_url.host_str().unwrap_or(&agent_id).to_string();
                let query = nav_url.query().unwrap_or("");
                let payload = if let Some(stripped) = query.strip_prefix("data=") {
                    stripped.to_string()
                } else {
                    query.to_string()
                };

                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut msgs) = state.agent_messages.lock() {
                        msgs.insert(id.clone(), payload.clone());
                    }
                }

                let _ = app_handle.emit(
                    "agent-message",
                    serde_json::json!({
                        "id": id,
                        "payload": payload
                    }),
                );

                return false;
            }
            true
        });
        let _win = builder.build().map_err(|e| e.to_string())?;

        wins.insert(config.id.clone(), config.url.clone());
        Ok(true)
    }

    #[tauri::command]
    pub async fn toggle_agent_window(
        app: AppHandle,
        id: String,
        visible: Option<bool>,
    ) -> Result<bool, String> {
        if let Some(win) = app.get_webview_window(&id) {
            let should_show = match visible {
                Some(v) => v,
                None => !win.is_visible().unwrap_or(false),
            };
            if should_show {
                win.show().map_err(|e| e.to_string())?;
                win.set_focus().map_err(|e| e.to_string())?;
            } else {
                win.hide().map_err(|e| e.to_string())?;
            }
            Ok(should_show)
        } else {
            Err(format!("Window {} not found", id))
        }
    }

    #[tauri::command]
    pub async fn eval_agent_script(
        app: AppHandle,
        id: String,
        script: String,
    ) -> Result<bool, String> {
        if let Some(win) = app.get_webview_window(&id) {
            win.eval(&script).map_err(|e| e.to_string())?;
            Ok(true)
        } else {
            Err(format!("Window {} not found", id))
        }
    }

    #[tauri::command]
    pub fn get_agent_window_title(app: AppHandle, id: String) -> Result<String, String> {
        if let Some(win) = app.get_webview_window(&id) {
            win.title().map_err(|e| e.to_string())
        } else {
            Err(format!("Window {} not found", id))
        }
    }

    #[tauri::command]
    pub fn is_agent_window_open(app: AppHandle, id: String) -> bool {
        app.get_webview_window(&id).is_some()
    }

    #[tauri::command]
    pub async fn close_agent_window(app: AppHandle, id: String) -> Result<bool, String> {
        if let Some(win) = app.get_webview_window(&id) {
            win.close().map_err(|e| e.to_string())?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[tauri::command]
    pub fn get_agent_message(
        state: tauri::State<'_, AppState>,
        id: String,
    ) -> Option<String> {
        let msgs = state.agent_messages.lock().ok()?;
        msgs.get(&id).cloned()
    }

    #[tauri::command]
    pub fn clear_agent_message(
        state: tauri::State<'_, AppState>,
        id: String,
    ) -> bool {
        if let Ok(mut msgs) = state.agent_messages.lock() {
            msgs.remove(&id);
            true
        } else {
            false
        }
    }

    #[tauri::command]
    pub async fn run_cli_agent(
        app: AppHandle,
        req: CliRunRequest,
    ) -> Result<(), String> {
        let run_id = req.run_id.clone();
        let agent_name = req.agent_name.clone();
        let command = req.command.clone();
        let args = req.args.clone();
        let prompt = req.prompt.clone();
        let cwd = req.cwd.clone();

        std::thread::spawn(move || {
            use std::io::Write;
            use std::process::{Command, Stdio};

            let mut cmd = Command::new(&command);
            cmd.args(&args);
            cmd.stdin(Stdio::piped());
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());

            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }

            match cmd.spawn() {
                Ok(mut child) => {
                    if let Some(mut stdin) = child.stdin.take() {
                        let _ = stdin.write_all(prompt.as_bytes());
                        let _ = stdin.write_all(b"\n");
                    }

                    if let Some(stdout) = child.stdout.take() {
                        use std::io::{BufRead, BufReader};
                        let reader = BufReader::new(stdout);
                        for line in reader.lines().flatten() {
                            let _ = app.emit(
                                "cli-output",
                                CliChunkEvent {
                                    run_id: run_id.clone(),
                                    agent_name: agent_name.clone(),
                                    chunk: line + "\n",
                                    is_done: false,
                                    is_error: false,
                                },
                            );
                        }
                    }

                    let status = child.wait();
                    let is_err = status.map(|s| !s.success()).unwrap_or(true);

                    let _ = app.emit(
                        "cli-output",
                        CliChunkEvent {
                            run_id: run_id.clone(),
                            agent_name: agent_name.clone(),
                            chunk: String::new(),
                            is_done: true,
                            is_error: is_err,
                        },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "cli-output",
                        CliChunkEvent {
                            run_id: run_id.clone(),
                            agent_name: agent_name.clone(),
                            chunk: format!("Failed to spawn {}: {}", command, e),
                            is_done: true,
                            is_error: true,
                        },
                    );
                }
            }
        });

        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::spawn_agent_window,
            commands::toggle_agent_window,
            commands::eval_agent_script,
            commands::get_agent_window_title,
            commands::is_agent_window_open,
            commands::close_agent_window,
            commands::get_agent_message,
            commands::clear_agent_message,
            commands::run_cli_agent
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
