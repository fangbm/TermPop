use eframe::egui::{
    self, Color32, FontId, RichText, ScrollArea, Stroke, TextEdit, Ui,
};
use eframe::egui::text::{LayoutJob, TextFormat};
use termlens_core::{
    detect_terms, explain_term, DetectedTerm, DetectorConfig, Explanation, TermDetector, TermType,
};

const SAMPLE_TEXT: &str = "Rust and React can compile shared logic to WASM. \
Kimi, ChatGPT, and Claude can explain LLM terms in context. \
If Fabric cannot read a Paper world, check level.dat and region .mca files.";

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
        };
        app.detect();
        app
    }
}

impl eframe::App for TermLensWindowsApp {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
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
    }
}

impl TermLensWindowsApp {
    fn render_editor_panel(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
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
                self.status = "已清空".to_string();
            }
            ui.checkbox(&mut self.auto_detect, "自动检测");
        });

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
                .show(&mut columns[1], |ui| {
                    let job = highlighted_job(&self.input, &self.terms);
                    ui.label(job);
                });
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
                    .selectable_label(selected, RichText::new(label).color(color_for_type(&term.term_type)))
                    .on_hover_text(format!("{}..{} · {:?}", term.start, term.end, term.source));
                if response.clicked() {
                    self.selected = Some(index);
                    self.explain_selected();
                }
            }
        });
    }

    fn render_explanation(&mut self, ui: &mut Ui) {
        ui.heading("释义");
        if let Some(explanation) = &self.explanation {
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
        } else {
            ui.label("选择右侧词条，或点击“解释选中词”。");
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

fn parse_custom_terms(input: &str) -> Vec<String> {
    input
        .split([',', '，', '\n', ';', '；'])
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

fn highlighted_job(text: &str, terms: &[DetectedTerm]) -> LayoutJob {
    let mut job = LayoutJob::default();
    let mut cursor = 0;
    let normal = TextFormat {
        font_id: FontId::proportional(15.0),
        color: Color32::from_rgb(32, 36, 44),
        ..Default::default()
    };

    for term in terms {
        if term.start < cursor || term.end > text.len() {
            continue;
        }
        if term.start > cursor {
            job.append(&text[cursor..term.start], 0.0, normal.clone());
        }

        let mut format = normal.clone();
        format.background = color_for_type(&term.term_type).linear_multiply(0.18);
        format.underline = Stroke::new(1.0, color_for_type(&term.term_type));
        job.append(&text[term.start..term.end], 0.0, format);
        cursor = term.end;
    }

    if cursor < text.len() {
        job.append(&text[cursor..], 0.0, normal);
    }

    job
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
