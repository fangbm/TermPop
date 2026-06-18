use eframe::egui::{
    self, Color32, Frame, Pos2, RichText, ScrollArea, TextEdit, Ui, Vec2, ViewportCommand,
    ViewportId,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
mod text_sources;
use termlens_core::{
    DetectedTerm, DetectorConfig, Explanation, TermDetector, TermType, detect_terms, explain_term,
};
use text_sources::{
    ClipboardTextSource, ScreenRect, SelectionCopyTextSource, TextCapture, TextSource,
    UiaPointedElementTextSource, capture_smart_text,
};

const SAMPLE_TEXT: &str = "Rust and React can compile shared logic to WASM. \
Kimi, ChatGPT, and Claude can explain LLM terms in context. \
If Fabric cannot read a Paper world, check level.dat and region .mca files.";
const AUTO_SCREEN_POLL_INTERVAL: Duration = Duration::from_millis(850);

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1180.0, 760.0])
            .with_min_inner_size([860.0, 560.0]),
        ..Default::default()
    };

    eframe::run_native(
        "词镜 TermLens",
        options,
        Box::new(|_cc| Ok(Box::new(TermLensWindowsApp::default()))),
    )
}

struct TermLensWindowsApp {
    input: String,
    custom_terms: String,
    terms: Vec<DetectedTerm>,
    selected: Option<usize>,
    explanation: Option<Explanation>,
    auto_detect: bool,
    last_detected_input: String,
    last_detected_custom_terms: String,
    status: String,
    capture_rx: Option<Receiver<Result<TextCapture, String>>>,
    auto_screen_detect: bool,
    auto_capture_rx: Option<Receiver<Result<TextCapture, String>>>,
    last_auto_capture_key: Option<u64>,
    next_auto_capture_at: Instant,
    source_overlay: Option<SourceOverlay>,
}

#[derive(Clone)]
struct SourceOverlay {
    explanation: Explanation,
    source_rect: ScreenRect,
}

impl Default for TermLensWindowsApp {
    fn default() -> Self {
        let mut app = Self {
            input: SAMPLE_TEXT.to_string(),
            custom_terms: "TermLens,词镜".to_string(),
            terms: Vec::new(),
            selected: None,
            explanation: None,
            auto_detect: true,
            last_detected_input: String::new(),
            last_detected_custom_terms: String::new(),
            status: String::new(),
            capture_rx: None,
            auto_screen_detect: false,
            auto_capture_rx: None,
            last_auto_capture_key: None,
            next_auto_capture_at: Instant::now(),
            source_overlay: None,
        };
        app.detect();
        app
    }
}

impl eframe::App for TermLensWindowsApp {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        self.poll_capture_result();
        self.poll_auto_capture_result();
        self.schedule_auto_screen_capture();
        if self.capture_rx.is_some() || self.auto_screen_detect {
            ui.ctx().request_repaint_after(Duration::from_millis(100));
        }

        if self.auto_detect
            && (self.input != self.last_detected_input
                || self.custom_terms != self.last_detected_custom_terms)
        {
            self.detect();
        }

        egui::Panel::top("header").show_inside(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("词镜 TermLens").heading().strong());
                ui.separator();
                ui.label("Windows 测试版");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(&self.status);
                });
            });
        });

        egui::Panel::right("terms")
            .resizable(true)
            .default_size(360.0)
            .size_range(300.0..=520.0)
            .show_inside(ui, |ui| self.render_terms_panel(ui));

        egui::CentralPanel::default().show_inside(ui, |ui| self.render_editor_panel(ui));
        self.render_source_overlay(ui.ctx());
    }
}

impl TermLensWindowsApp {
    fn render_editor_panel(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            if ui.button("从剪贴板导入").clicked() {
                self.import_clipboard_text();
            }
            let capture_enabled = self.capture_rx.is_none();
            if ui
                .add_enabled(capture_enabled, egui::Button::new("2秒后智能提取"))
                .clicked()
            {
                self.capture_smart();
            }
            if ui
                .add_enabled(
                    capture_enabled,
                    egui::Button::new("2秒后读取鼠标下文本(UIA)"),
                )
                .clicked()
            {
                self.capture_uia_pointed_text();
            }
            if ui
                .add_enabled(capture_enabled, egui::Button::new("2秒后抓取选区"))
                .clicked()
            {
                self.capture_selection_after_delay();
            }
            if ui.button("检测词条").clicked() {
                self.detect();
            }
            if ui.button("解释选中词").clicked() {
                self.explain_selected();
            }
            if ui.button("清空").clicked() {
                self.input.clear();
                self.terms.clear();
                self.selected = None;
                self.explanation = None;
                self.source_overlay = None;
                self.last_auto_capture_key = None;
                self.status = "已清空".to_string();
            }
            ui.checkbox(&mut self.auto_detect, "自动检测");
            let auto_response = ui.checkbox(&mut self.auto_screen_detect, "自动读屏(UIA)");
            if auto_response.changed() {
                self.last_auto_capture_key = None;
                self.next_auto_capture_at = Instant::now();
                self.status = if self.auto_screen_detect {
                    "自动读屏已开启：把鼠标停在目标文本上".to_string()
                } else {
                    "自动读屏已关闭".to_string()
                };
            }
        });

        ui.add_space(4.0);
        ui.label(
            RichText::new("提示：自动读屏和智能提取会先尝试 UI Automation；OCR 仍默认关闭。")
                .color(Color32::from_rgb(95, 105, 120)),
        );

        ui.add_space(8.0);
        ui.label("自定义词，逗号或换行分隔");
        ui.add(
            TextEdit::singleline(&mut self.custom_terms)
                .hint_text("TermLens, 词镜, 你的领域词")
                .desired_width(f32::INFINITY),
        );

        ui.add_space(8.0);
        ui.columns(2, |columns| {
            columns[0].label("输入文本");
            columns[0].add(
                TextEdit::multiline(&mut self.input)
                    .desired_width(f32::INFINITY)
                    .desired_rows(22)
                    .hint_text("粘贴一段网页、文档或日志文本..."),
            );

            columns[1].label("高亮预览");
            ScrollArea::vertical()
                .id_salt("highlight_preview")
                .max_height(470.0)
                .show(&mut columns[1], |ui| self.render_interactive_preview(ui));
        });

        ui.separator();
        self.render_explanation(ui);
    }

    fn render_terms_panel(&mut self, ui: &mut Ui) {
        ui.heading("词条");
        ui.horizontal(|ui| {
            ui.label(format!("共 {} 个", self.terms.len()));
            if ui.button("重新检测").clicked() {
                self.detect();
            }
        });
        ui.separator();

        ScrollArea::vertical().show(ui, |ui| {
            for index in 0..self.terms.len() {
                let selected = self.selected == Some(index);
                let term = &self.terms[index];
                let label = format!(
                    "{}  ·  {:?}  ·  {:.0}%",
                    term.term,
                    term.term_type,
                    term.confidence * 100.0
                );
                let response = ui
                    .selectable_label(
                        selected,
                        RichText::new(label).color(color_for_type(&term.term_type)),
                    )
                    .on_hover_text(format!("{}..{} · {:?}", term.start, term.end, term.source));
                if response.clicked() {
                    self.selected = Some(index);
                    self.explain_selected();
                }
            }
        });
    }

    fn render_interactive_preview(&mut self, ui: &mut Ui) {
        if self.input.trim().is_empty() {
            ui.label(RichText::new("等待输入文本...").color(Color32::from_rgb(110, 118, 130)));
            return;
        }

        let segments = preview_segments(&self.input, &self.terms);
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            ui.spacing_mut().item_spacing.y = 4.0;

            for segment in segments {
                match segment {
                    PreviewSegment::Text(text) => {
                        render_plain_segment(ui, &text);
                    }
                    PreviewSegment::Term { index, text } => {
                        self.render_preview_term(ui, index, &text);
                    }
                }
            }
        });
    }

    fn render_preview_term(&mut self, ui: &mut Ui, index: usize, text: &str) {
        let Some(term) = self.terms.get(index).cloned() else {
            render_plain_segment(ui, text);
            return;
        };

        let color = color_for_type(&term.term_type);
        let selected = self.selected == Some(index);
        let label = RichText::new(text)
            .color(color)
            .background_color(if selected {
                color.linear_multiply(0.26)
            } else {
                color.linear_multiply(0.16)
            })
            .underline();

        let response = ui
            .add(egui::Label::new(label).sense(egui::Sense::click()))
            .on_hover_ui(|ui| {
                let explanation = explain_term(&term.term, Some(&self.input));
                render_explanation_card(ui, &explanation);
            });

        if response.hovered() {
            self.selected = Some(index);
            self.explanation = Some(explain_term(&term.term, Some(&self.input)));
            self.status = format!("正在查看 {}", term.term);
        }

        if response.clicked() {
            self.selected = Some(index);
            self.explanation = Some(explain_term(&term.term, Some(&self.input)));
            self.status = format!("已生成 {} 的释义", term.term);
        }
    }

    fn render_explanation(&mut self, ui: &mut Ui) {
        ui.heading("释义");
        if let Some(explanation) = &self.explanation {
            render_explanation_card(ui, explanation);
        } else {
            ui.label("悬停预览区高亮词，或选择右侧词条。");
        }
    }

    fn detect(&mut self) {
        let custom_terms = parse_custom_terms(&self.custom_terms);
        self.terms = if custom_terms.is_empty() {
            detect_terms(&self.input)
        } else {
            TermDetector::new(DetectorConfig {
                user_terms: custom_terms,
                min_confidence: 0.5,
            })
            .detect(&self.input)
        };
        self.selected = self.selected.filter(|index| *index < self.terms.len());
        self.explanation = None;
        self.last_detected_input = self.input.clone();
        self.last_detected_custom_terms = self.custom_terms.clone();
        self.status = format!("检测到 {} 个词条", self.terms.len());
    }

    fn import_clipboard_text(&mut self) {
        self.apply_capture_result(ClipboardTextSource.capture());
    }

    fn capture_smart(&mut self) {
        self.status = "请在 2 秒内把鼠标移到目标文本上，或保持文本选中...".to_string();
        self.spawn_capture(|| {
            thread::sleep(Duration::from_secs(2));
            capture_smart_text()
        });
    }

    fn capture_uia_pointed_text(&mut self) {
        self.status = "请在 2 秒内把鼠标移到目标文本上...".to_string();
        self.spawn_capture(|| {
            thread::sleep(Duration::from_secs(2));
            UiaPointedElementTextSource.capture()
        });
    }

    fn capture_selection_after_delay(&mut self) {
        self.status = "请在 2 秒内切回目标窗口并保持文本选中...".to_string();
        self.spawn_capture(|| {
            SelectionCopyTextSource {
                delay: Duration::from_secs(2),
            }
            .capture()
        });
    }

    fn spawn_capture<F>(&mut self, capture: F)
    where
        F: FnOnce() -> Result<TextCapture, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        self.capture_rx = Some(rx);
        thread::spawn(move || {
            let _ = tx.send(capture());
        });
    }

    fn poll_capture_result(&mut self) {
        let Some(rx) = &self.capture_rx else {
            return;
        };

        let Ok(result) = rx.try_recv() else {
            return;
        };
        self.capture_rx = None;

        self.apply_capture_result(result);
    }

    fn schedule_auto_screen_capture(&mut self) {
        if !self.auto_screen_detect || self.auto_capture_rx.is_some() || self.capture_rx.is_some() {
            return;
        }

        let now = Instant::now();
        if now < self.next_auto_capture_at {
            return;
        }

        self.next_auto_capture_at = now + AUTO_SCREEN_POLL_INTERVAL;
        let (tx, rx) = mpsc::channel();
        self.auto_capture_rx = Some(rx);
        thread::spawn(move || {
            let _ = tx.send(UiaPointedElementTextSource.capture());
        });
    }

    fn poll_auto_capture_result(&mut self) {
        let Some(rx) = &self.auto_capture_rx else {
            return;
        };

        let Ok(result) = rx.try_recv() else {
            return;
        };
        self.auto_capture_rx = None;
        self.apply_auto_capture_result(result);
    }

    fn apply_auto_capture_result(&mut self, result: Result<TextCapture, String>) {
        let Ok(capture) = result else {
            return;
        };

        if capture.text.trim().is_empty() {
            return;
        }

        let key = capture_key(&capture);
        if self.last_auto_capture_key == Some(key) {
            return;
        }
        self.last_auto_capture_key = Some(key);

        let source_rect = capture.source_rect;
        self.input = capture.text;
        self.detect();

        if let (Some(rect), Some(term)) = (source_rect, self.terms.first()) {
            self.selected = Some(0);
            let explanation = explain_term(&term.term, Some(&self.input));
            self.explanation = Some(explanation.clone());
            self.source_overlay = Some(SourceOverlay {
                explanation,
                source_rect: rect,
            });
            self.status = format!("自动读屏：检测到 {} 个词条", self.terms.len());
        } else {
            self.source_overlay = None;
            self.status = "自动读屏：未发现可解释词条".to_string();
        }
    }

    fn apply_capture_result(&mut self, result: Result<TextCapture, String>) {
        match result {
            Ok(capture) if !capture.text.trim().is_empty() => {
                let source_rect = capture.source_rect;
                self.input = capture.text;
                self.detect();
                self.source_overlay = source_rect.and_then(|rect| {
                    self.terms.first().map(|term| SourceOverlay {
                        explanation: explain_term(&term.term, Some(&self.input)),
                        source_rect: rect,
                    })
                });
                self.status = format!(
                    "已通过{}导入，检测到 {} 个词条",
                    capture.source.label(),
                    self.terms.len()
                );
            }
            Ok(capture) => {
                self.source_overlay = None;
                self.status = format!("{}没有返回文本", capture.source.label());
            }
            Err(message) => {
                self.source_overlay = None;
                self.status = format!("提取失败：{message}");
            }
        }
    }

    fn render_source_overlay(&mut self, ctx: &egui::Context) {
        let Some(overlay) = self.source_overlay.clone() else {
            return;
        };

        let viewport_id = ViewportId::from_hash_of("termlens_source_overlay");
        let builder = egui::ViewportBuilder::default()
            .with_title("TermLens Overlay")
            .with_position(overlay_position(overlay.source_rect))
            .with_inner_size(Vec2::new(380.0, 210.0))
            .with_min_inner_size(Vec2::new(320.0, 160.0))
            .with_decorations(false)
            .with_resizable(false)
            .with_taskbar(false)
            .with_always_on_top();

        ctx.show_viewport_deferred(viewport_id, builder, move |ui, _class| {
            Frame::popup(ui.style()).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("词镜 TermLens").strong());
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("×").clicked() {
                            ui.ctx().send_viewport_cmd(ViewportCommand::Close);
                        }
                    });
                });
                ui.separator();
                render_explanation_card(ui, &overlay.explanation);
            });
        });
    }

    fn explain_selected(&mut self) {
        if let Some(index) = self.selected {
            if let Some(term) = self.terms.get(index) {
                self.explanation = Some(explain_term(&term.term, Some(&self.input)));
                self.status = format!("已生成 {} 的释义", term.term);
            }
        } else if let Some(first) = self.terms.first() {
            self.selected = Some(0);
            self.explanation = Some(explain_term(&first.term, Some(&self.input)));
            self.status = format!("已生成 {} 的释义", first.term);
        }
    }
}

fn capture_key(capture: &TextCapture) -> u64 {
    let mut hasher = DefaultHasher::new();
    capture.source.hash(&mut hasher);
    capture.text.hash(&mut hasher);
    if let Some(rect) = capture.source_rect {
        rect.left.to_bits().hash(&mut hasher);
        rect.top.to_bits().hash(&mut hasher);
        rect.right.to_bits().hash(&mut hasher);
        rect.bottom.to_bits().hash(&mut hasher);
    }
    hasher.finish()
}

fn overlay_position(rect: ScreenRect) -> Pos2 {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let x = if rect.right.is_finite() && width >= 0.0 {
        rect.right + 10.0
    } else if rect.left.is_finite() {
        rect.left + 10.0
    } else {
        12.0
    };
    let y = if rect.top.is_finite() {
        rect.top
    } else if rect.bottom.is_finite() && height >= 0.0 {
        rect.bottom + 10.0
    } else {
        12.0
    };
    Pos2::new(x.max(12.0), y.max(12.0))
}

fn parse_custom_terms(input: &str) -> Vec<String> {
    input
        .split([',', '，', '\n', ';', '；'])
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

enum PreviewSegment {
    Text(String),
    Term { index: usize, text: String },
}

fn preview_segments(text: &str, terms: &[DetectedTerm]) -> Vec<PreviewSegment> {
    let mut segments = Vec::new();
    let mut cursor = 0;

    for (index, term) in terms.iter().enumerate() {
        if term.start < cursor
            || term.end > text.len()
            || !text.is_char_boundary(term.start)
            || !text.is_char_boundary(term.end)
        {
            continue;
        }

        if term.start > cursor {
            segments.push(PreviewSegment::Text(text[cursor..term.start].to_string()));
        }

        segments.push(PreviewSegment::Term {
            index,
            text: text[term.start..term.end].to_string(),
        });
        cursor = term.end;
    }

    if cursor < text.len() {
        segments.push(PreviewSegment::Text(text[cursor..].to_string()));
    }

    segments
}

fn render_plain_segment(ui: &mut Ui, text: &str) {
    for (line_index, line) in text.split('\n').enumerate() {
        if line_index > 0 {
            ui.end_row();
        }
        if !line.is_empty() {
            ui.label(RichText::new(line).color(Color32::from_rgb(32, 36, 44)));
        }
    }
}

fn render_explanation_card(ui: &mut Ui, explanation: &Explanation) {
    ui.set_max_width(360.0);
    ui.label(RichText::new(&explanation.term).strong().size(18.0));
    ui.label(RichText::new(&explanation.category).color(Color32::from_rgb(86, 100, 140)));
    ui.add_space(4.0);
    ui.label(&explanation.definition);

    if let Some(example) = &explanation.usage_example {
        ui.add_space(6.0);
        ui.label(RichText::new(example).italics());
    }

    if !explanation.related_terms.is_empty() {
        ui.add_space(6.0);
        ui.horizontal_wrapped(|ui| {
            for term in &explanation.related_terms {
                ui.label(
                    RichText::new(term)
                        .background_color(Color32::from_rgb(239, 244, 255))
                        .color(Color32::from_rgb(55, 75, 130)),
                );
            }
        });
    }
}

fn color_for_type(term_type: &TermType) -> Color32 {
    match term_type {
        TermType::Tech => Color32::from_rgb(32, 111, 190),
        TermType::Brand => Color32::from_rgb(156, 85, 20),
        TermType::Acronym => Color32::from_rgb(118, 78, 170),
        TermType::Custom => Color32::from_rgb(22, 132, 96),
        TermType::Person => Color32::from_rgb(170, 70, 110),
        TermType::Place => Color32::from_rgb(72, 120, 68),
    }
}
