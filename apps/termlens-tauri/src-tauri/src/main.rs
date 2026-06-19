use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};
use termlens_core::{DetectedTerm, Explanation, explain_term};

#[allow(dead_code)]
#[path = "../../../termlens-windows/src/text_sources.rs"]
mod text_sources;

use text_sources::{ScreenRect, TermSourceRect, TextSource, UiaPointedElementTextSource};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureResponse {
    text: String,
    terms: Vec<DetectedTerm>,
    highlights: Vec<HighlightPayload>,
    explanation: Option<Explanation>,
    source_rect: Option<ScreenRectPayload>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HighlightPayload {
    term: String,
    rect: ScreenRectPayload,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenRectPayload {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl From<ScreenRect> for ScreenRectPayload {
    fn from(rect: ScreenRect) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

#[tauri::command]
fn capture_terms() -> Result<CaptureResponse, String> {
    let capture = UiaPointedElementTextSource.capture()?;
    let terms = termlens_core::detect_terms(&capture.text);
    let highlights = matched_highlights(&capture.term_rects, &terms);
    let explanation = terms
        .first()
        .map(|term| explain_term(&term.term, Some(&capture.text)));

    Ok(CaptureResponse {
        text: capture.text,
        terms,
        highlights,
        explanation,
        source_rect: capture.source_rect.map(ScreenRectPayload::from),
    })
}

#[tauri::command]
fn explain(term: String, context: String) -> Explanation {
    explain_term(&term, Some(&context))
}

#[tauri::command]
fn set_overlay_clickthrough(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_ignore_cursor_events(enabled)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn matched_highlights(term_rects: &[TermSourceRect], terms: &[DetectedTerm]) -> Vec<HighlightPayload> {
    term_rects
        .iter()
        .filter(|rect| {
            terms
                .iter()
                .any(|term| term.term.eq_ignore_ascii_case(&rect.term))
        })
        .take(24)
        .map(|rect| HighlightPayload {
            term: rect.term.clone(),
            rect: rect.rect.into(),
        })
        .collect()
}

fn configure_overlay(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("overlay") {
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let position = monitor.position();
            let size = monitor.size();
            let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
            let _ = window.set_size(PhysicalSize::new(size.width, size.height));
        }
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.set_always_on_top(true);
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            configure_overlay(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_terms,
            explain,
            set_overlay_clickthrough
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TermLens Tauri app");
}
