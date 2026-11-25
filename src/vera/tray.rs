//! Vera's tray icon: `Shell_NotifyIcon` from a hidden window on its own
//! thread, like Rune's tray (which Hex uses), plus what Vera needs that one
//! lacks: a checked item (Mute microphone), a disabled one (Stop talking
//! while silent), a bold default item, and an icon that changes (the inbox
//! badge, a dimmed mark while muted). The mark is drawn at the size the
//! notification area asks for, white or black for the taskbar's theme.
//!
//! Left click opens Settings; right click opens the menu. The icon comes
//! back when Explorer restarts (`TaskbarCreated`), and follows the taskbar
//! between light and dark.

use std::ptr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use color_eyre::Result;
use color_eyre::eyre::eyre;
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CREATESTRUCTW, CreateIcon, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyIcon, DestroyMenu, DestroyWindow, DispatchMessageW, EndMenu, FindWindowW,
    GWLP_USERDATA, GetCursorPos, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect,
    HICON, HMENU, KillTimer, MF_CHECKED, MF_GRAYED, MF_SEPARATOR, MF_STRING, MSG,
    PostMessageW, PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SM_CXSMICON,
    SetForegroundWindow, SetMenuDefaultItem, SetTimer, SetWindowLongPtrW, TPM_BOTTOMALIGN,
    TPM_LEFTALIGN, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
    TranslateMessage, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_DESTROY, WM_LBUTTONUP, WM_NCCREATE,
    WM_NCDESTROY, WM_NULL, WM_RBUTTONUP, WM_SETTINGCHANGE, WM_TIMER, WNDCLASSW,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

const CALLBACK: u32 = WM_APP + 1;
const UPDATE: u32 = WM_APP + 2;
/// Opens the menu at a point for `vera shots --tray` and captures it.
const SHOW_FOR_CAPTURE: u32 = WM_APP + 3;
const ICON_ID: u32 = 1;
const CAPTURE_TIMER: usize = 7;

const ID_SETTINGS: u16 = 1;
const ID_MUTE: u16 = 2;
const ID_STOP: u16 = 3;
const ID_QUIT: u16 = 4;

/// What the tray shows.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct TrayState {
    pub(crate) muted: bool,
    pub(crate) speaking: bool,
    /// Inbox items: a dot on the icon while above zero.
    pub(crate) badge: u32,
    pub(crate) tooltip: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrayEvent {
    Settings,
    ToggleMute,
    StopTalking,
    Quit,
}

type Handler = Arc<dyn Fn(TrayEvent) + Send + Sync>;

/// A captured menu: its pixels as straight RGBA rows.
pub(crate) struct Captured {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
}

struct Context {
    state: Arc<Mutex<TrayState>>,
    on_event: Handler,
    taskbar_created: u32,
    icon: std::cell::Cell<HICON>,
    /// What the icon was drawn for: size, light taskbar, badge, dim.
    drawn: std::cell::Cell<Option<(u32, bool, bool, bool)>>,
    capture: Arc<Mutex<Option<mpsc::SyncSender<Option<Captured>>>>>,
}

pub(crate) struct Tray {
    window: isize,
    state: Arc<Mutex<TrayState>>,
    capture: Arc<Mutex<Option<mpsc::SyncSender<Option<Captured>>>>>,
    worker: Option<JoinHandle<()>>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Whether the taskbar uses the light theme; any failure means dark.
pub(crate) fn taskbar_is_light() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_value::<u32, _>("SystemUsesLightTheme"))
        .is_ok_and(|light| light != 0)
}

fn data(hwnd: HWND, flags: u32) -> NOTIFYICONDATAW {
    // SAFETY: plain data; zero is its documented empty value.
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd;
    data.uID = ICON_ID;
    data.uFlags = flags;
    data
}

fn icon_size() -> u32 {
    // SAFETY: a plain query.
    let size = unsafe { GetSystemMetrics(SM_CXSMICON) };
    u32::try_from(size).ok().filter(|&s| s >= 16).unwrap_or(16)
}

/// Draws the icon when what it shows changed; returns the current one.
fn refresh_icon(context: &Context, state: &TrayState) -> HICON {
    let key = (
        icon_size(),
        taskbar_is_light(),
        state.badge > 0,
        state.muted,
    );
    if context.drawn.get() == Some(key) && !context.icon.get().is_null() {
        return context.icon.get();
    }
    let (size, light, badge, dim) = key;
    let mut bgra = super::icon::tray_rgba(size, light, badge, dim);
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    // A 1-bit AND mask of zeros: alpha decides. Rows are word aligned.
    let mask_row = (size as usize).div_ceil(16) * 2;
    let mask = vec![0u8; mask_row * size as usize];
    // SAFETY: both buffers hold the sizes CreateIcon reads and outlive it.
    let icon = unsafe {
        CreateIcon(
            ptr::null_mut(),
            size as i32,
            size as i32,
            1,
            32,
            mask.as_ptr(),
            bgra.as_ptr(),
        )
    };
    if icon.is_null() {
        return context.icon.get();
    }
    let old = context.icon.replace(icon);
    if !old.is_null() {
        // SAFETY: the old icon is ours and the shell copies what it shows.
        unsafe { DestroyIcon(old) };
    }
    context.drawn.set(Some(key));
    icon
}

fn notify(hwnd: HWND, context: &Context, message: u32) -> bool {
    let state = lock(&context.state).clone();
    let mut data = data(hwnd, NIF_MESSAGE | NIF_ICON | NIF_TIP);
    data.uCallbackMessage = CALLBACK;
    data.hIcon = refresh_icon(context, &state);
    let tip: Vec<u16> = state.tooltip.encode_utf16().take(data.szTip.len() - 1).collect();
    data.szTip[..tip.len()].copy_from_slice(&tip);
    data.szTip[tip.len()] = 0;
    // SAFETY: `data` is fully initialized for this window's icon.
    unsafe { Shell_NotifyIconW(message, &data) != 0 }
}

fn menu(state: &TrayState) -> HMENU {
    // SAFETY: the menu is built and used on this thread; labels outlive calls.
    unsafe {
        let popup = CreatePopupMenu();
        if popup.is_null() {
            return popup;
        }
        let item = |id: u16, label: &str, flags: u32| {
            AppendMenuW(popup, MF_STRING | flags, usize::from(id), wide(label).as_ptr());
        };
        item(ID_SETTINGS, "Settings…", 0);
        AppendMenuW(popup, MF_SEPARATOR, 0, ptr::null());
        item(ID_MUTE, "Mute microphone", if state.muted { MF_CHECKED } else { 0 });
        item(ID_STOP, "Stop talking", if state.speaking { 0 } else { MF_GRAYED });
        AppendMenuW(popup, MF_SEPARATOR, 0, ptr::null());
        item(ID_QUIT, "Quit Vera", 0);
        SetMenuDefaultItem(popup, u32::from(ID_SETTINGS), 0);
        popup
    }
}

/// Shows the menu at `at` and returns the picked item.
fn pick(hwnd: HWND, context: &Context, at: POINT) -> Option<TrayEvent> {
    let state = lock(&context.state).clone();
    let popup = menu(&state);
    if popup.is_null() {
        return None;
    }
    // SAFETY: the menu belongs to this thread; the window is ours.
    let picked = unsafe {
        // Without the foreground, the menu wouldn't close on a click elsewhere.
        SetForegroundWindow(hwnd);
        let flags = TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_BOTTOMALIGN;
        let picked = TrackPopupMenu(popup, flags, at.x, at.y, 0, hwnd, ptr::null());
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(popup);
        picked
    };
    match u16::try_from(picked).ok()? {
        ID_SETTINGS => Some(TrayEvent::Settings),
        ID_MUTE => Some(TrayEvent::ToggleMute),
        ID_STOP => Some(TrayEvent::StopTalking),
        ID_QUIT => Some(TrayEvent::Quit),
        _ => None,
    }
}

/// Copies the open menu's pixels off the screen.
fn capture_menu() -> Option<Captured> {
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap,
        CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SRCCOPY, SelectObject,
    };
    let class = wide("#32768");
    // SAFETY: GDI calls on handles made and released here.
    unsafe {
        let menu = FindWindowW(class.as_ptr(), ptr::null());
        if menu.is_null() {
            return None;
        }
        let mut rect: RECT = std::mem::zeroed();
        GetWindowRect(menu, &mut rect);
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        if width <= 0 || height <= 0 {
            return None;
        }
        let screen = GetDC(ptr::null_mut());
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let old = SelectObject(memory, bitmap);
        BitBlt(memory, 0, 0, width, height, screen, rect.left, rect.top, SRCCOPY);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(memory, old);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(ptr::null_mut(), screen);
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Some(Captured {
            width: width as u32,
            height: height as u32,
            rgba: pixels,
        })
    }
}

unsafe extern "system" fn procedure(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // SAFETY: Windows owns the parameters; the context outlives the window and
    // is used only on its thread, and is cleared before the window goes.
    unsafe {
        if message == WM_NCCREATE {
            let create = &*(l as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let Some(context) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Context).as_ref()
        else {
            return DefWindowProcW(hwnd, message, w, l);
        };
        match message {
            CALLBACK => {
                let event = match l as u32 {
                    WM_LBUTTONUP => Some(TrayEvent::Settings),
                    WM_RBUTTONUP => {
                        let mut at = POINT { x: 0, y: 0 };
                        GetCursorPos(&mut at);
                        pick(hwnd, context, at)
                    }
                    _ => None,
                };
                if let Some(event) = event {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (context.on_event)(event)
                    }));
                }
                0
            }
            UPDATE => {
                notify(hwnd, context, NIM_MODIFY);
                0
            }
            SHOW_FOR_CAPTURE => {
                SetTimer(hwnd, CAPTURE_TIMER, 600, None);
                let at = POINT {
                    x: w as i32,
                    y: l as i32,
                };
                let _ = pick(hwnd, context, at);
                0
            }
            WM_TIMER if w == CAPTURE_TIMER => {
                KillTimer(hwnd, CAPTURE_TIMER);
                let captured = capture_menu();
                EndMenu();
                if let Some(reply) = lock(&context.capture).take() {
                    let _ = reply.send(captured);
                }
                0
            }
            WM_SETTINGCHANGE => {
                // The taskbar may have turned light or dark.
                notify(hwnd, context, NIM_MODIFY);
                DefWindowProcW(hwnd, message, w, l)
            }
            WM_DESTROY => {
                Shell_NotifyIconW(NIM_DELETE, &data(hwnd, 0));
                let icon = context.icon.replace(ptr::null_mut());
                if !icon.is_null() {
                    DestroyIcon(icon);
                }
                PostQuitMessage(0);
                0
            }
            WM_NCDESTROY => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                DefWindowProcW(hwnd, message, w, l)
            }
            m if m == context.taskbar_created => {
                notify(hwnd, context, NIM_ADD);
                0
            }
            _ => DefWindowProcW(hwnd, message, w, l),
        }
    }
}

impl Tray {
    pub(crate) fn new(
        state: TrayState,
        on_event: impl Fn(TrayEvent) + Send + Sync + 'static,
    ) -> Result<Self> {
        let state = Arc::new(Mutex::new(state));
        let capture = Arc::new(Mutex::new(None));
        let (ready, result) = mpsc::sync_channel(1);
        let shared = state.clone();
        let shared_capture = capture.clone();
        let on_event: Handler = Arc::new(on_event);
        let worker = std::thread::Builder::new()
            .name("vera-tray".into())
            .spawn(move || {
                // SAFETY: the name is NUL-terminated.
                let taskbar_created =
                    unsafe { RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()) };
                let mut context = Box::new(Context {
                    state: shared,
                    on_event,
                    taskbar_created,
                    icon: std::cell::Cell::new(ptr::null_mut()),
                    drawn: std::cell::Cell::new(None),
                    capture: shared_capture,
                });
                let class = wide("VeraTray");
                // SAFETY: the class name is NUL-terminated; the context stays
                // put until the loop below ends.
                let hwnd = unsafe {
                    let instance = GetModuleHandleW(ptr::null());
                    let wc = WNDCLASSW {
                        lpfnWndProc: Some(procedure),
                        hInstance: instance,
                        lpszClassName: class.as_ptr(),
                        ..std::mem::zeroed()
                    };
                    if RegisterClassW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
                        let _ = ready.send(Err(eyre!("RegisterClassW failed")));
                        return;
                    }
                    // A hidden top-level tool window, not message-only, so it
                    // hears TaskbarCreated and theme changes. Never shown.
                    let hwnd = CreateWindowExW(
                        WS_EX_TOOLWINDOW as WINDOW_EX_STYLE,
                        class.as_ptr(),
                        wide("Vera").as_ptr(),
                        WS_POPUP,
                        0,
                        0,
                        0,
                        0,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        instance,
                        (&mut *context as *mut Context).cast(),
                    );
                    if hwnd.is_null() {
                        let _ = ready.send(Err(eyre!("CreateWindowExW failed")));
                        return;
                    }
                    if !notify(hwnd, &context, NIM_ADD) {
                        DestroyWindow(hwnd);
                        let _ = ready.send(Err(eyre!("Shell_NotifyIconW failed")));
                        return;
                    }
                    hwnd
                };
                let _ = ready.send(Ok(hwnd as isize));
                // SAFETY: this thread's message loop; it ends with WM_QUIT.
                unsafe {
                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                drop(context);
            })?;
        match result.recv() {
            Ok(Ok(window)) => Ok(Self {
                window,
                state,
                capture,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err(eyre!("the tray thread exited"))
            }
        }
    }

    /// Shows `state`, redrawing the icon only when it changed.
    pub(crate) fn set(&self, state: TrayState) {
        {
            let mut current = lock(&self.state);
            if *current == state {
                return;
            }
            *current = state;
        }
        // SAFETY: posting to the tray thread's window; a gone one drops it.
        unsafe { PostMessageW(self.window as HWND, UPDATE, 0, 0) };
    }

    /// Opens the real menu at `at` (screen pixels, its bottom left corner)
    /// for a moment and returns its pixels (`vera shots --tray`).
    pub(crate) fn capture_menu(&self, at: (i32, i32)) -> Option<Captured> {
        let (reply, answer) = mpsc::sync_channel(1);
        *lock(&self.capture) = Some(reply);
        // SAFETY: as in `set`.
        unsafe {
            PostMessageW(
                self.window as HWND,
                SHOW_FOR_CAPTURE,
                at.0 as usize,
                at.1 as isize,
            )
        };
        answer
            .recv_timeout(std::time::Duration::from_secs(5))
            .ok()
            .flatten()
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        // SAFETY: WM_CLOSE destroys the window on its thread, which removes
        // the icon and ends the loop.
        unsafe { PostMessageW(self.window as HWND, WM_CLOSE, 0, 0) };
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
