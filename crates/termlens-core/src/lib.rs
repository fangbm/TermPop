use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum TermType {
    Tech,
    Brand,
    Person,
    Place,
    Acronym,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum DetectionSource {
    Rule,
    Dictionary,
    Ner,
    User,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DetectedTerm {
    pub term: String,
    pub start: usize,
    pub end: usize,
    pub term_type: TermType,
    pub confidence: f32,
    pub source: DetectionSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Explanation {
    pub term: String,
    pub definition: String,
    pub category: String,
    pub related_terms: Vec<String>,
    pub usage_example: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DetectorConfig {
    pub user_terms: Vec<String>,
    pub min_confidence: f32,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self {
            user_terms: Vec::new(),
            min_confidence: 0.5,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TermDetector {
    config: DetectorConfig,
}

impl TermDetector {
    pub fn new(config: DetectorConfig) -> Self {
        Self { config }
    }

    pub fn detect(&self, text: &str) -> Vec<DetectedTerm> {
        if text.trim().is_empty() {
            return Vec::new();
        }

        let mut terms = Vec::new();

        for rule in RULES.iter() {
            for mat in rule.regex.find_iter(text) {
                terms.push(DetectedTerm {
                    term: mat.as_str().to_string(),
                    start: mat.start(),
                    end: mat.end(),
                    term_type: rule.term_type.clone(),
                    confidence: rule.confidence,
                    source: DetectionSource::Rule,
                });
            }
        }

        terms.extend(self.detect_user_terms(text));
        deduplicate_and_sort(terms, self.config.min_confidence)
    }

    fn detect_user_terms(&self, text: &str) -> Vec<DetectedTerm> {
        let mut results = Vec::new();
        let mut seen = HashSet::new();

        for raw_term in &self.config.user_terms {
            let term = raw_term.trim();
            if term.is_empty() || !seen.insert(term.to_lowercase()) {
                continue;
            }

            let pattern = if is_ascii_word(term) {
                format!(r"\b{}\b", regex::escape(term))
            } else {
                regex::escape(term)
            };

            if let Ok(regex) = Regex::new(&pattern) {
                for mat in regex.find_iter(text) {
                    results.push(DetectedTerm {
                        term: mat.as_str().to_string(),
                        start: mat.start(),
                        end: mat.end(),
                        term_type: TermType::Custom,
                        confidence: 0.99,
                        source: DetectionSource::User,
                    });
                }
            }
        }

        results
    }
}

#[derive(Clone, Debug)]
struct Rule {
    regex: Regex,
    term_type: TermType,
    confidence: f32,
}

static RULES: Lazy<Vec<Rule>> = Lazy::new(|| {
    vec![
        Rule {
            regex: Regex::new(
                r"\b(React|Vue\.js|Angular|Svelte|Next\.js|Nuxt|Django|Flask|Spring|TensorFlow|PyTorch|WASM|WebAssembly|Fabric|Paper|Minecraft|Bukkit|Spigot)\b",
            )
            .expect("valid framework regex"),
            term_type: TermType::Tech,
            confidence: 0.92,
        },
        Rule {
            regex: Regex::new(
                r"\b(Rust|Go|Python|TypeScript|JavaScript|Kotlin|Swift|Dart|Elixir|Haskell)\b",
            )
            .expect("valid language regex"),
            term_type: TermType::Tech,
            confidence: 0.95,
        },
        Rule {
            regex: Regex::new(r"\b(AWS|Azure|GCP|Vercel|Cloudflare)\b|阿里云|腾讯云")
                .expect("valid cloud regex"),
            term_type: TermType::Brand,
            confidence: 0.9,
        },
        Rule {
            regex: Regex::new(
                r"\b(API|SDK|CLI|GUI|SQL|NoSQL|CI/CD|GPU|TPU|LLM|NLP|CRUD|REST|GraphQL)\b|JAR|JVM|TPS|MSPT",
            )
                .expect("valid acronym regex"),
            term_type: TermType::Acronym,
            confidence: 0.88,
        },
        Rule {
            regex: Regex::new(r"\b(level\.dat(?:_old)?|region|save-all|server\.jar|paper\.jar|fabric-server-launch\.jar|bash|PowerShell)\b|\.mca")
                .expect("valid file and command regex"),
            term_type: TermType::Tech,
            confidence: 0.86,
        },
        Rule {
            regex: Regex::new(r"\b(Kimi|ChatGPT|Claude|Copilot|Notion|Figma|Linear|Raycast)\b")
                .expect("valid product regex"),
            term_type: TermType::Brand,
            confidence: 0.9,
        },
    ]
});

pub fn detect_terms(text: &str) -> Vec<DetectedTerm> {
    TermDetector::new(DetectorConfig::default()).detect(text)
}

pub fn explain_term(term: &str, context: Option<&str>) -> Explanation {
    let normalized = term.trim();
    let category = infer_category(normalized);
    let related_terms = related_terms_for(&category);
    let context_hint = context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            format!(
                " In this context, it appears near: \"{}\".",
                truncate(value, 120)
            )
        })
        .unwrap_or_default();

    Explanation {
        term: normalized.to_string(),
        definition: format!(
            "{} is a {} term that TermLens detected for explanation.{}",
            normalized,
            category.to_lowercase(),
            context_hint
        ),
        category,
        related_terms,
        usage_example: Some(format!(
            "When reading documentation, hover {} to quickly understand why it matters.",
            normalized
        )),
        source_url: None,
    }
}

fn deduplicate_and_sort(mut terms: Vec<DetectedTerm>, min_confidence: f32) -> Vec<DetectedTerm> {
    terms.retain(|term| term.confidence >= min_confidence && term.start < term.end);
    terms.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| right.confidence.total_cmp(&left.confidence))
            .then_with(|| (right.end - right.start).cmp(&(left.end - left.start)))
    });

    let mut deduped: Vec<DetectedTerm> = Vec::new();
    for term in terms {
        if let Some(existing) = deduped
            .iter_mut()
            .find(|existing| ranges_overlap(existing.start, existing.end, term.start, term.end))
        {
            if term.confidence > existing.confidence
                || (term.confidence == existing.confidence
                    && (term.end - term.start) > (existing.end - existing.start))
            {
                *existing = term;
            }
        } else {
            deduped.push(term);
        }
    }

    deduped.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| left.end.cmp(&right.end))
    });
    deduped
}

fn ranges_overlap(
    left_start: usize,
    left_end: usize,
    right_start: usize,
    right_end: usize,
) -> bool {
    left_start < right_end && right_start < left_end
}

fn is_ascii_word(value: &str) -> bool {
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn infer_category(term: &str) -> String {
    let detector = TermDetector::new(DetectorConfig::default());
    if let Some(detected) = detector.detect(term).into_iter().next() {
        match detected.term_type {
            TermType::Tech => "Technology".to_string(),
            TermType::Brand => "Product or brand".to_string(),
            TermType::Acronym => "Acronym".to_string(),
            TermType::Custom => "Custom term".to_string(),
            TermType::Person => "Person".to_string(),
            TermType::Place => "Place".to_string(),
        }
    } else {
        "General concept".to_string()
    }
}

fn related_terms_for(category: &str) -> Vec<String> {
    match category {
        "Technology" => ["API", "SDK", "WebAssembly"].map(String::from).to_vec(),
        "Product or brand" => ["Platform", "Workflow", "Integration"]
            .map(String::from)
            .to_vec(),
        "Acronym" => ["Definition", "Context", "Usage"]
            .map(String::from)
            .to_vec(),
        _ => ["Background", "Usage", "Related concept"]
            .map(String::from)
            .to_vec(),
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for ch in value.chars().take(max_chars) {
        output.push(ch);
    }
    if value.chars().count() > max_chars {
        output.push_str("...");
    }
    output
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn detect_terms_json(input: &str) -> Result<String, JsValue> {
    serde_json::to_string(&detect_terms(input)).map_err(|err| JsValue::from_str(&err.to_string()))
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn explain_term_json(term: &str, context: Option<String>) -> Result<String, JsValue> {
    serde_json::to_string(&explain_term(term, context.as_deref()))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_phase_one_seed_terms() {
        let terms = detect_terms("Rust React AWS LLM ChatGPT");
        let labels: Vec<_> = terms.iter().map(|term| term.term.as_str()).collect();

        assert_eq!(labels, vec!["Rust", "React", "AWS", "LLM", "ChatGPT"]);
    }

    #[test]
    fn deduplicates_overlapping_matches_by_highest_confidence() {
        let detector = TermDetector::new(DetectorConfig {
            user_terms: vec!["React".to_string()],
            min_confidence: 0.5,
        });
        let terms = detector.detect("React");

        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].term, "React");
        assert_eq!(terms[0].source, DetectionSource::User);
        assert_eq!(terms[0].term_type, TermType::Custom);
    }

    #[test]
    fn detects_chinese_cloud_terms() {
        let terms = detect_terms("我们使用阿里云和腾讯云部署服务。");
        let labels: Vec<_> = terms.iter().map(|term| term.term.as_str()).collect();

        assert_eq!(labels, vec!["阿里云", "腾讯云"]);
    }

    #[test]
    fn detects_minecraft_server_terms() {
        let terms = detect_terms("JAR Paper Fabric level.dat region .mca save-all bash");
        let labels: Vec<_> = terms.iter().map(|term| term.term.as_str()).collect();

        assert_eq!(
            labels,
            vec![
                "JAR",
                "Paper",
                "Fabric",
                "level.dat",
                "region",
                ".mca",
                "save-all",
                "bash"
            ]
        );
    }

    #[test]
    fn detects_minecraft_terms_next_to_chinese_text() {
        let terms = detect_terms("JAR缺失导致崩溃，region 目录里的 .mca 文件");
        let labels: Vec<_> = terms.iter().map(|term| term.term.as_str()).collect();

        assert_eq!(labels, vec!["JAR", "region", ".mca"]);
    }

    #[test]
    fn user_terms_are_custom() {
        let detector = TermDetector::new(DetectorConfig {
            user_terms: vec!["TermLens".to_string()],
            min_confidence: 0.5,
        });
        let terms = detector.detect("TermLens explains vocabulary.");

        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].term_type, TermType::Custom);
        assert_eq!(terms[0].source, DetectionSource::User);
    }

    #[test]
    fn mock_explanation_has_stable_fields() {
        let explanation = explain_term("Rust", Some("Rust and WASM"));

        assert_eq!(explanation.term, "Rust");
        assert_eq!(explanation.category, "Technology");
        assert!(explanation.definition.contains("Rust"));
        assert!(explanation.usage_example.is_some());
        assert!(explanation.source_url.is_none());
    }

    #[test]
    fn empty_input_returns_no_terms() {
        assert!(detect_terms("").is_empty());
    }
}
