// SPDX-License-Identifier: AGPL-3.0-or-later
// pomelo-input: the only low-level input code in Pomelo. Talks to the app over stdin/stdout and has no network code.
//
// It installs a Windows mouse hook and keyboard hook, but reports only:
//   - the left mouse button (down, up) and the mouse position while that button is held, and
//   - the trigger key (ctrl, alt or shift) and Esc, and only while the left button is held.
// Nothing else is reported, stored or logged. Pomelo does not log keystrokes.
//
// stdout, one line per event:  {"ready":true}   md <x> <y>   mm <x> <y>   mu   kd <key>
//                              {"id":1,"files":["C:\\a.docx"],"why":"...","explorer":true}
// stdin, one line per command: key <ctrl|alt|shift>   down <x> <y>   files <id>
// x and y are physical screen pixels (this process is per-monitor DPI aware).
//
// "down" is sent at mouse-down: which Explorer window or desktop icon is under the cursor?
// "files" is sent once a drag is under way: the selection of that window.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

[assembly: AssemblyTitle("Pomelo input helper")]
[assembly: AssemblyProduct("Pomelo")]
[assembly: AssemblyDescription("Reports the drag gesture (left mouse button and the trigger key) and the dragged Explorer files to Pomelo.")]

static class PomeloInput {
  const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
  const int WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202;
  const int WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104;

  delegate IntPtr HookProc(int n, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

  static readonly BlockingCollection<string> output = new BlockingCollection<string>();

  // ---- hooks -------------------------------------------------------------------------------------------------

  static volatile bool leftDown;
  static volatile string triggerKey = "ctrl";
  static int lastMove;
  static readonly bool[] keyDown = new bool[256];
  static readonly HookProc mouseProc = OnMouse, keyProc = OnKey;   // kept in fields so the GC cannot collect them

  static IntPtr OnMouse(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      int m = (int)w;
      if (m == WM_LBUTTONDOWN) { leftDown = true; output.Add("md " + Marshal.ReadInt32(l, 0) + " " + Marshal.ReadInt32(l, 4)); }
      else if (m == WM_LBUTTONUP) { leftDown = false; output.Add("mu"); }
      else if (m == WM_MOUSEMOVE && leftDown) {
        int now = Environment.TickCount;
        if (now - lastMove >= 15) { lastMove = now; output.Add("mm " + Marshal.ReadInt32(l, 0) + " " + Marshal.ReadInt32(l, 4)); }
      }
    }
    return CallNextHookEx(IntPtr.Zero, n, w, l);
  }

  static string KeyName(int vk) {
    switch (vk) {
      case 0x11: case 0xA2: case 0xA3: return "ctrl";
      case 0x12: case 0xA4: case 0xA5: return "alt";
      case 0x10: case 0xA0: case 0xA1: return "shift";
      case 0x1B: return "esc";
      default: return null;     // every other key is ignored
    }
  }

  static IntPtr OnKey(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      int vk = Marshal.ReadInt32(l, 0), m = (int)w;
      string name = KeyName(vk);
      if (name != null) {
        if (m == WM_KEYDOWN || m == WM_SYSKEYDOWN) {
          bool first = !keyDown[vk];            // ignore auto-repeat
          keyDown[vk] = true;
          if (first && leftDown && (name == "esc" || name == triggerKey)) output.Add("kd " + name);
        } else keyDown[vk] = false;
      }
    }
    return CallNextHookEx(IntPtr.Zero, n, w, l);
  }

  static void StartHooks() {
    var installed = new ManualResetEvent(false);
    bool ok = false;
    var pump = new Thread(() => {
      IntPtr mod = GetModuleHandle(null);
      ok = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0) != IntPtr.Zero && SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, mod, 0) != IntPtr.Zero;
      installed.Set();
      MSG msg;
      while (ok && GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
    });
    pump.IsBackground = true;
    pump.Start();
    installed.WaitOne();
    if (!ok) { Console.Error.WriteLine("pomelo-input: could not install the input hooks"); Environment.Exit(1); }
  }

  // ---- which files are being dragged? ------------------------------------------------------------------------

  class Down { public IntPtr Root; public bool Desktop; public string Name; }
  static Down down;
  static string why = "";
  static dynamic shell;

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  // Name of the file or folder row under the point, "" if UI Automation cannot tell, null if there is no item there.
  static string ItemNameAt(int x, int y) {
    try {
      var el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
      for (int i = 0; i < 5 && el != null; i++) {
        var type = el.Current.ControlType;
        if (type == ControlType.ListItem || type == ControlType.DataItem) return el.Current.Name;
        el = TreeWalker.ControlViewWalker.GetParent(el);
      }
    } catch { return ""; }
    return null;        // empty space (rubber-band selection) or a side-pane item
  }

  // The desktop's icon list answers for its icons as children, not for a point on them.
  static bool DesktopIconAt(IntPtr list, int x, int y) {
    if (ClassOf(list) != "SysListView32") return false;
    try {
      var items = AutomationElement.FromHandle(list).FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem));
      foreach (AutomationElement item in items) if (item.Current.BoundingRectangle.Contains(x, y)) return true;
    } catch { }
    return false;
  }

  static void SetDown(int x, int y) {
    down = null;
    IntPtr under = WindowFromPoint(new POINT { X = x, Y = y });
    IntPtr root = under == IntPtr.Zero ? IntPtr.Zero : GetAncestor(under, 2);     // GA_ROOT
    if (root == IntPtr.Zero) { why = "no window"; return; }
    string cls = ClassOf(root);
    bool desktop = cls == "Progman" || cls == "WorkerW";
    if (cls != "CabinetWClass" && !desktop) { why = "not Explorer or desktop (window class " + cls + ")"; return; }
    string name = desktop ? (DesktopIconAt(under, x, y) ? "" : null) : ItemNameAt(x, y);
    if (name == null) { why = desktop ? "no icon under cursor on the desktop" : "no file or folder under cursor in " + cls + " (empty space, or a side-pane/tree item)"; return; }
    why = "";
    down = new Down { Root = root, Desktop = desktop, Name = name };
  }

  static dynamic Windows() {
    if (shell == null) shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
    return shell.Windows();
  }

  // Real files and folders of a view's selection; virtual items (Recycle Bin, This PC ...) and drive roots are skipped.
  static string[] SelectedFiles(dynamic view) {
    var files = new List<string>();
    dynamic items = view.Document.SelectedItems();
    for (int i = 0; i < items.Count; i++) {
      string path = items.Item(i).Path;
      if (path != null && path.Length > 3 && (File.Exists(path) || Directory.Exists(path))) files.Add(path);
    }
    return files.ToArray();
  }

  static string[] DragFiles() {
    if (down == null) return new string[0];
    why = "selection of '" + down.Name + "' held no real files or folders (virtual items like the Recycle Bin are skipped)";
    if (down.Desktop) {
      object loc = 0; int hwnd;
      dynamic view = Windows().FindWindowSW(ref loc, ref loc, 8, out hwnd, 1);     // SWC_DESKTOP, SWFO_NEEDDISPATCH
      return view == null ? new string[0] : SelectedFiles(view);
    }
    // Windows 11 tabs share one top-level window, so prefer the tab whose selection contains the item.
    string[] fallback = new string[0];
    dynamic windows = Windows();
    for (int i = 0; i < windows.Count; i++) {
      try {
        dynamic w = windows.Item(i);
        if ((long)w.HWND != down.Root.ToInt64()) continue;
        dynamic selected = w.Document.SelectedItems();
        if (selected.Count == 0) continue;
        string[] files = SelectedFiles(w);
        if (files.Length == 0) continue;
        if (down.Name == "") return files;
        for (int j = 0; j < selected.Count; j++) if (selected.Item(j).Name == down.Name) return files;
        if (fallback.Length == 0) fallback = files;
      } catch { }
    }
    return fallback;
  }

  // ---- stdin / stdout ------------------------------------------------------------------------------------------

  // ASCII only, so the output never depends on a console code page.
  static string Json(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20 || c > 0x7E) sb.AppendFormat("\\u{0:x4}", (int)c);
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  static void Reply(int id, string[] files) {
    output.Add("{\"id\":" + id + ",\"files\":[" + string.Join(",", Array.ConvertAll(files, Json)) + "],\"why\":" + Json(why) + ",\"explorer\":" + (down != null ? "true" : "false") + "}");
  }

  static void StartWriter() {
    var writer = new Thread(() => {
      try {
        var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        foreach (string line in output.GetConsumingEnumerable()) o.WriteLine(line);
      } catch (IOException) { Environment.Exit(0); }      // Pomelo is gone
    });
    writer.IsBackground = true;
    writer.Start();
  }

  [STAThread]      // the Shell COM objects need it
  static void Main() {
    SetProcessDpiAwarenessContext((IntPtr)(-4));     // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    StartWriter();
    StartHooks();
    output.Add("{\"ready\":true}");

    string line;
    while ((line = Console.In.ReadLine()) != null) {     // ends when Pomelo closes our stdin
      string[] p = line.Trim().Split(' ');
      int a, b;
      if (p[0] == "key" && p.Length >= 2 && (p[1] == "ctrl" || p[1] == "alt" || p[1] == "shift")) triggerKey = p[1];
      else if (p[0] == "down" && p.Length >= 3 && int.TryParse(p[1], out a) && int.TryParse(p[2], out b)) { try { SetDown(a, b); } catch { down = null; } }
      else if (p[0] == "files" && p.Length >= 2 && int.TryParse(p[1], out a)) {
        string[] files;
        try { files = DragFiles(); } catch { files = new string[0]; }
        Reply(a, files);
      }
    }
  }
}
