use std::thread;
use std::time::Duration;
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationElement};
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
}

#[derive(Clone, Copy, Debug)]
pub struct ScreenRect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
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
        })
    }
}

pub struct UiaPointedElementTextSource;

impl TextSource for UiaPointedElementTextSource {
    fn capture(&self) -> Result<TextCapture, String> {
        let (text, source_rect) = capture_uia_pointed_text()?;
        Ok(TextCapture {
            source: TextSourceKind::UiaPointedElement,
            text,
            source_rect: Some(source_rect),
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

fn capture_uia_pointed_text() -> Result<(String, ScreenRect), String> {
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
        let text = text_from_element(&element)
            .ok_or_else(|| "鼠标下元素没有暴露可访问文本".to_string())?;
        Ok((
            text,
            ScreenRect {
                left: rect.left as f32,
                top: rect.top as f32,
                right: rect.right as f32,
                bottom: rect.bottom as f32,
            },
        ))
    }
}

fn text_from_element(element: &IUIAutomationElement) -> Option<String> {
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
