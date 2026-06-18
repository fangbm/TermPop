use std::thread;
use std::time::Duration;
use termlens_core::detect_terms;
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize,
};
use windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTextRange, UIA_TextPatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_C,
    VK_CONTROL,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[derive(Clone, Debug)]
pub struct TextCapture {
    pub source: TextSourceKind,
    pub text: String,
    pub source_rect: Option<ScreenRect>,
    pub term_rects: Vec<TermSourceRect>,
}

#[derive(Clone, Copy, Debug)]
pub struct ScreenRect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

#[derive(Clone, Debug)]
pub struct TermSourceRect {
    pub term: String,
    pub rect: ScreenRect,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum TextSourceKind {
    Clipboard,
    SelectionCopy,
    UiaPointedElement,
    OcrPlaceholder,
}

impl TextSourceKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Clipboard => "剪贴板",
            Self::SelectionCopy => "选区复制",
            Self::UiaPointedElement => "UI Automation",
            Self::OcrPlaceholder => "OCR 占位",
        }
    }
}

pub trait TextSource {
    fn capture(&self) -> Result<TextCapture, String>;
}

pub struct ClipboardTextSource;

impl TextSource for ClipboardTextSource {
    fn capture(&self) -> Result<TextCapture, String> {
        Ok(TextCapture {
            source: TextSourceKind::Clipboard,
            text: read_clipboard_text()?,
            source_rect: None,
            term_rects: Vec::new(),
        })
    }
}

pub struct SelectionCopyTextSource {
    pub delay: Duration,
}

impl TextSource for SelectionCopyTextSource {
    fn capture(&self) -> Result<TextCapture, String> {
        thread::sleep(self.delay);
        Ok(TextCapture {
            source: TextSourceKind::SelectionCopy,
            text: capture_selected_text()?,
            source_rect: None,
            term_rects: Vec::new(),
        })
    }
}

pub struct UiaPointedElementTextSource;

impl TextSource for UiaPointedElementTextSource {
    fn capture(&self) -> Result<TextCapture, String> {
        let (text, source_rect, term_rects) = capture_uia_pointed_text()?;
        Ok(TextCapture {
            source: TextSourceKind::UiaPointedElement,
            text,
            source_rect: Some(source_rect),
            term_rects,
        })
    }
}

pub struct OcrPlaceholderTextSource;

impl TextSource for OcrPlaceholderTextSource {
    fn capture(&self) -> Result<TextCapture, String> {
        Ok(TextCapture {
            source: TextSourceKind::OcrPlaceholder,
            text: String::new(),
            source_rect: None,
            term_rects: Vec::new(),
        })
    }
}

pub fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|err| err.to_string())?;
    clipboard.get_text().map_err(|err| err.to_string())
}

pub fn capture_selected_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|err| err.to_string())?;
    let previous = clipboard.get_text().ok();

    send_ctrl_c()?;
    thread::sleep(Duration::from_millis(220));
    let captured = clipboard.get_text().map_err(|err| err.to_string())?;

    if let Some(previous) = previous {
        let _ = clipboard.set_text(previous);
    }

    Ok(captured)
}

pub fn capture_smart_text() -> Result<TextCapture, String> {
    let mut errors = Vec::new();
    for source in [
        Box::new(UiaPointedElementTextSource) as Box<dyn TextSource>,
        Box::new(SelectionCopyTextSource {
            delay: Duration::from_millis(0),
        }),
        Box::new(OcrPlaceholderTextSource),
    ] {
        match source.capture() {
            Ok(capture) if !capture.text.trim().is_empty() => return Ok(capture),
            Ok(capture) => errors.push(format!("{} 没有返回文本", capture.source.label())),
            Err(error) => errors.push(error),
        }
    }

    Err(errors.join("；"))
}

fn capture_uia_pointed_text() -> Result<(String, ScreenRect, Vec<TermSourceRect>), String> {
    let _com = ComApartment::init()?;
    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point).map_err(|err| err.message().to_string())?;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|err| err.message().to_string())?;
        let element = automation
            .ElementFromPoint(point)
            .map_err(|err| err.message().to_string())?;
        let rect = element
            .CurrentBoundingRectangle()
            .map_err(|err| err.message().to_string())?;
        let (text, term_rects) = text_from_element(&element)
            .ok_or_else(|| "鼠标下元素没有暴露可访问文本".to_string())?;
        Ok((
            text,
            ScreenRect {
                left: rect.left as f32,
                top: rect.top as f32,
                right: rect.right as f32,
                bottom: rect.bottom as f32,
            },
            term_rects,
        ))
    }
}

fn text_from_element(element: &IUIAutomationElement) -> Option<(String, Vec<TermSourceRect>)> {
    if let Some(text_pattern_result) = text_from_text_pattern(element) {
        return Some(text_pattern_result);
    }

    let mut values = Vec::new();

    if let Ok(name) = unsafe { element.CurrentName() } {
        values.push(name.to_string());
    }
    if let Ok(localized_type) = unsafe { element.CurrentLocalizedControlType() } {
        values.push(localized_type.to_string());
    }
    if let Ok(class_name) = unsafe { element.CurrentClassName() } {
        values.push(class_name.to_string());
    }

    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| value.len() >= 2)
        .max_by_key(|value| value.len())
        .map(|text| (text, Vec::new()))
}

fn text_from_text_pattern(element: &IUIAutomationElement) -> Option<(String, Vec<TermSourceRect>)> {
    let pattern = unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?
    };
    let document_range = unsafe { pattern.DocumentRange().ok()? };
    let text = unsafe { document_range.GetText(8000).ok()? }
        .to_string()
        .trim()
        .to_string();
    if text.len() < 2 {
        return None;
    }

    let term_rects = term_rects_from_text_range(&text, &document_range);
    Some((text, term_rects))
}

fn term_rects_from_text_range(
    text: &str,
    document_range: &IUIAutomationTextRange,
) -> Vec<TermSourceRect> {
    let mut rects = Vec::new();
    let mut seen = Vec::<String>::new();

    for term in detect_terms(text) {
        if seen
            .iter()
            .any(|seen_term| seen_term.eq_ignore_ascii_case(&term.term))
        {
            continue;
        }
        seen.push(term.term.clone());

        let Ok(term_range) = (unsafe {
            document_range.FindText(&windows::core::BSTR::from(term.term.as_str()), false, true)
        }) else {
            continue;
        };

        if let Some(rect) = first_bounding_rect(&term_range) {
            rects.push(TermSourceRect {
                term: term.term,
                rect,
            });
        }

        if rects.len() >= 24 {
            break;
        }
    }

    rects
}

fn first_bounding_rect(range: &IUIAutomationTextRange) -> Option<ScreenRect> {
    let safe_array = unsafe { range.GetBoundingRectangles().ok()? };
    if safe_array.is_null() {
        return None;
    }

    let values = unsafe { safe_array_to_doubles(safe_array) };
    let _ = unsafe { SafeArrayDestroy(safe_array) };

    if values.len() < 4 {
        return None;
    }

    for chunk in values.chunks_exact(4) {
        let left = chunk[0] as f32;
        let top = chunk[1] as f32;
        let width = chunk[2] as f32;
        let height = chunk[3] as f32;
        if width > 0.0 && height > 0.0 {
            return Some(ScreenRect {
                left,
                top,
                right: left + width,
                bottom: top + height,
            });
        }
    }

    None
}

unsafe fn safe_array_to_doubles(
    safe_array: *mut windows::Win32::System::Com::SAFEARRAY,
) -> Vec<f64> {
    let lower = unsafe { SafeArrayGetLBound(safe_array, 1).ok() };
    let upper = unsafe { SafeArrayGetUBound(safe_array, 1).ok() };
    let (Some(lower), Some(upper)) = (lower, upper) else {
        return Vec::new();
    };

    let mut values = Vec::new();
    for index in lower..=upper {
        let mut value = 0.0_f64;
        if unsafe {
            SafeArrayGetElement(
                safe_array,
                &index,
                (&mut value as *mut f64).cast::<core::ffi::c_void>(),
            )
            .is_ok()
        } {
            values.push(value);
        }
    }
    values
}

fn send_ctrl_c() -> Result<(), String> {
    let inputs = [
        keyboard_input(VK_CONTROL, false),
        keyboard_input(VK_C, false),
        keyboard_input(VK_C, true),
        keyboard_input(VK_CONTROL, true),
    ];

    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err(format!("SendInput 只发送了 {sent}/{} 个事件", inputs.len()))
    }
}

fn keyboard_input(key: VIRTUAL_KEY, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

struct ComApartment;

impl ComApartment {
    fn init() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.is_ok() {
            Ok(Self)
        } else {
            Err(hr.message().to_string())
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
