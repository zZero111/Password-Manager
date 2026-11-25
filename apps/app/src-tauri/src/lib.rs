// All vault logic (encryption, sync) runs in the shared TypeScript core inside
// the webview, so desktop and mobile behave identically. The native layer only
// provides the window plus clipboard and file-save access.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Keyhold");
}
