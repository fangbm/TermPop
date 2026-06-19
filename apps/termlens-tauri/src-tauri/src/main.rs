use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmSettingsPayload {
    provider: String,
    api_key: String,
    model: String,
    base_url: String,
    temperature: f32,
    max_tokens: u32,
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
async fn fetch_llm_text(
    settings: LlmSettingsPayload,
    system: String,
    prompt: String,
) -> Result<String, String> {
    if settings.provider == "anthropic" {
        return fetch_anthropic_text(settings, system, prompt).await;
    }

    fetch_openai_compatible_text(settings, system, prompt).await
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

async fn fetch_openai_compatible_text(
    settings: LlmSettingsPayload,
    system: String,
    prompt: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", normalize_base_url(&settings.base_url));
    let response = client
        .post(url)
        .bearer_auth(settings.api_key)
        .json(&json!({
            "model": settings.model,
            "temperature": settings.temperature,
            "max_tokens": settings.max_tokens,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt }
            ]
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(format_provider_error(status.as_u16(), &text));
    }

    let payload = serde_json::from_str::<Value>(&text).map_err(|err| err.to_string())?;
    extract_openai_compatible_text(&payload)
        .ok_or_else(|| format!("LLM response did not include usable text. Raw response: {}", truncate(&text, 600)))
}

async fn fetch_anthropic_text(
    settings: LlmSettingsPayload,
    system: String,
    prompt: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/messages", normalize_base_url(&settings.base_url));
    let response = client
        .post(url)
        .header("x-api-key", settings.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": settings.model,
            "max_tokens": settings.max_tokens,
            "temperature": settings.temperature,
            "system": system,
            "messages": [{ "role": "user", "content": prompt }]
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(format_provider_error(status.as_u16(), &text));
    }

    let payload = serde_json::from_str::<Value>(&text).map_err(|err| err.to_string())?;
    payload
        .get("content")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .and_then(|part| part.get("text").and_then(Value::as_str))
        })
        .map(str::to_string)
        .ok_or_else(|| format!("LLM response did not include text content. Raw response: {}", truncate(&text, 600)))
}

fn extract_openai_compatible_text(payload: &Value) -> Option<String> {
    let choice = payload.get("choices")?.as_array()?.first()?;
    [
        choice.pointer("/message/content"),
        choice.pointer("/message/reasoning_content"),
        choice.pointer("/message/reasoning"),
        choice.get("text"),
    ]
    .into_iter()
    .flatten()
    .filter_map(stringify_provider_text)
    .map(|text| text.trim().to_string())
    .find(|text| !text.is_empty())
}

fn stringify_provider_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }

    value.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_string)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn normalize_base_url(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn format_provider_error(status: u16, text: &str) -> String {
    if let Ok(payload) = serde_json::from_str::<Value>(text) {
        if let Some(message) = payload.pointer("/error/message").and_then(Value::as_str) {
            return message.to_string();
        }
        if let Some(message) = payload.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    if text.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", truncate(text, 600))
    }
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    format!("{}...", value.chars().take(max_len).collect::<String>())
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
            fetch_llm_text,
            set_overlay_clickthrough
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TermLens Tauri app");
}
