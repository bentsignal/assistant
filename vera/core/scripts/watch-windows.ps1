# Reports every top-level window that becomes visible while it runs (a
# WinEvent hook on EVENT_OBJECT_SHOW), one JSON line each, so a console
# window that flashes for a few milliseconds is still caught.
#   powershell -NoProfile -ExecutionPolicy Bypass -File watch-windows.ps1 -Seconds 60
param([int]$Seconds = 30)

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WindowWatch {
  delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventDelegate proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);

  static WinEventDelegate keep;

  static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, 2) != hwnd) return; // GA_ROOT: top-level only
    if (!IsWindowVisible(hwnd)) return;
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
    var title = new StringBuilder(256); GetWindowText(hwnd, title, 256);
    string name = "?";
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
    Console.WriteLine("{\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ",\"pid\":" + pid + ",\"process\":\"" + Esc(name) + "\",\"class\":\"" + Esc(cls.ToString()) + "\",\"title\":\"" + Esc(title.ToString()) + "\"}");
    Console.Out.Flush();
  }

  public static void Run(int seconds) {
    keep = OnEvent;
    IntPtr hook = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, keep, 0, 0, 0); // EVENT_OBJECT_SHOW, out of context
    Console.WriteLine("{\"watching\":true}"); Console.Out.Flush();
    var end = DateTime.UtcNow.AddSeconds(seconds);
    MSG m;
    while (DateTime.UtcNow < end) {
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }
      Thread.Sleep(5);
    }
    UnhookWinEvent(hook);
  }
}
"@

[WindowWatch]::Run($Seconds)
