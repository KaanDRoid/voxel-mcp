import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { FilePolicy } from "./files.js";
import type { MagicaConfig } from "./magicaConfig.js";
import { resolveInstall } from "./magicaInstall.js";
import { inspectPng } from "./png.js";

type RegisterTool = <T extends z.ZodRawShape>(definition: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Environment switch. Without it the live-application tools only explain how to enable them. */
export const UI_AUTOMATION_ENV = "MAGICVOXEL_MCP_UI_AUTOMATION";
/** Set to 1 to attach to an application version other than the one the click positions were calibrated on. */
export const UI_ANY_VERSION_ENV = "MAGICVOXEL_MCP_UI_ANY_VERSION";
export const CALIBRATED_VERSION = "0.99.7.2";
/** Tools that drive the real application window; they are never read-only. */
export const APP_CONTROL_TOOLS = ["attach_magicavoxel_app", "set_app_camera", "export_native_render"];

/** Identity of one running application process. A title or a file name alone is never trusted. */
export interface AppIdentity { pid: number; exe: string; startFileTime: string }

export type PowerShellRunner = (script: string, input: unknown, timeoutMs: number) => Promise<unknown>;

const CAMERA_KEYS = ["x", "y", "z", "zoom", "fov", "rx", "ry", "rz"] as const;
export type CameraKey = (typeof CAMERA_KEYS)[number];
const CAMERA_LIMITS: Record<CameraKey, [number, number]> = { x: [-100000, 100000], y: [-100000, 100000], z: [-100000, 100000], zoom: [0.001, 100000], fov: [1, 360], rx: [-360, 360], ry: [-360, 360], rz: [-360, 360] };

/** Console commands for a camera pose, generated from numbers only (never from caller text). */
export function cameraCommands(pose: Partial<Record<CameraKey, number>>, options: { focus?: boolean | undefined } = {}): string[] {
  const commands: string[] = options.focus ? ["cam focus"] : [];
  for (const key of CAMERA_KEYS) {
    const value = pose[key];
    if (value === undefined) continue;
    const [low, high] = CAMERA_LIMITS[key];
    if (!Number.isFinite(value) || value < low || value > high) throw new Error(`${key} must be between ${low} and ${high}`);
    commands.push(`cam ${key} ${Number(value.toFixed(4))}`);
  }
  if (!commands.length) throw new Error("Provide at least one camera value or focus");
  return commands;
}

/** Console commands that set the final-image size. */
export function photoSizeCommands(width: number, height: number): string[] {
  for (const [name, value] of [["width", width], ["height", height]] as const) if (!Number.isInteger(value) || value < 1 || value > 12000) throw new Error(`${name} must be an integer between 1 and 12000`);
  return [`set pt_photo_w ${width}`, `set pt_photo_h ${height}`];
}

/** The save dialog receives this text keystroke by keystroke, so only plain absolute Windows paths are allowed. */
export function checkTypablePath(value: string): void {
  if (value.length > 259) throw new Error("The output path is too long for the save dialog (259 characters at most)");
  if (/[\x00-\x1f%*?"<>|]/.test(value) || !/^[A-Za-z]:[\\/]/.test(value) || /:/.test(value.slice(2))) throw new Error("The output path must be a plain absolute path without control characters or % * ? \" < > | :");
}

const MAX_STEPS = 20;
export const MAX_VERIFY_BYTES = 512 * 1024 * 1024;

/** PowerShell + Win32 helper. Everything it may type or click is decided by the caller's typed steps. */
export const UI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class Ui {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct IU { [FieldOffset(0)] public MI mi; [FieldOffset(0)] public KI ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public IU u; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static uint Target; static long DeadlineMs; static Stopwatch Clock = Stopwatch.StartNew();
  public static void Arm(uint pid, long deadlineMs) { Target = pid; DeadlineMs = deadlineMs; Clock.Restart(); SetProcessDPIAware(); }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Called before every single input event: the pinned process must own the foreground right now.
  static void Guard() {
    if (Clock.ElapsedMilliseconds > DeadlineMs) throw new Exception("The automation time budget was exceeded; input stopped");
    if (PidOf(GetForegroundWindow()) != Target) throw new Exception("Another window took the foreground; input stopped");
  }
  // Moves the foreground to a window of the pinned process without sending any key to another window.
  public static bool Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    uint tp; uint targetThread = GetWindowThreadProcessId(h, out tp);
    uint fp; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fp);
    uint me = GetCurrentThreadId(); bool a1 = false, a2 = false;
    try {
      if (fgThread != 0 && fgThread != me) a1 = AttachThreadInput(me, fgThread, true);
      if (targetThread != 0 && targetThread != me && targetThread != fgThread) a2 = AttachThreadInput(me, targetThread, true);
      BringWindowToTop(h); SetForegroundWindow(h);
    } finally {
      if (a1) AttachThreadInput(me, fgThread, false);
      if (a2) AttachThreadInput(me, targetThread, false);
    }
    Thread.Sleep(400);
    return GetForegroundWindow() == h;
  }
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.L, r.T, r.R, r.B }; }
  public static IntPtr[] Dialogs(uint pid) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && PidOf(h) == pid) { StringBuilder c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "#32770") found.Add(h); }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  static void SendRaw(INPUT i) { INPUT[] a = new INPUT[] { i }; if (SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput was refused (is MagicaVoxel running as administrator?)"); }
  static void Send(INPUT i) { Guard(); SendRaw(i); }
  public static void ReleaseModifiers() { foreach (ushort vk in new ushort[] { 0x10, 0x11 }) { try { SendRaw(Key(vk, 0, 2)); } catch { } } }
  public static void TypeText(string s) { foreach (char c in s) { Send(Key(0, c, 4)); Send(Key(0, c, 6)); Thread.Sleep(12); } }
  public static void Press(ushort vk, bool ctrl) {
    bool down = false;
    try { if (ctrl) { Send(Key(0x11, 0, 0)); down = true; } Send(Key(vk, 0, 0)); Send(Key(vk, 0, 2)); }
    finally { if (down) { try { SendRaw(Key(0x11, 0, 2)); } catch { } } }
  }
  // Both the foreground and the window under the cursor are checked again right before the button goes down.
  public static void Click(int x, int y) {
    Guard();
    SetCursorPos(x, y); Thread.Sleep(350); SetCursorPos(x + 1, y); Thread.Sleep(150);
    Guard();
    POINT p; GetCursorPos(out p);
    if (Math.Abs(p.X - (x + 1)) > 1 || Math.Abs(p.Y - y) > 1) throw new Exception("The mouse was moved; click cancelled");
    if (PidOf(GetAncestor(WindowFromPoint(p), 2)) != Target) throw new Exception("The point to click does not belong to the pinned process; click cancelled");
    mouse_event(2, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(120); mouse_event(4, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(500);
  }
}
"@
function Emit($object) {
  $json = $object | ConvertTo-Json -Compress -Depth 4
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) [string][char]92 + 'u' + ('{0:x4}' -f [int][char]$m.Value) })
  [Console]::Out.WriteLine($json)
}
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$log = New-Object System.Collections.ArrayList
$knownDialogs = @()
try {
  if ($in.mode -eq 'list') {
    $found = New-Object System.Collections.ArrayList
    foreach ($p in @(Get-Process -Name 'MagicaVoxel' -ErrorAction SilentlyContinue)) {
      try { [void]$found.Add(@{ pid = $p.Id; exe = $p.Path; startFileTime = [string]$p.StartTime.ToFileTimeUtc() }) } catch { }
    }
    Emit @{ ok = $true; processes = @($found.ToArray()) }
    exit 0
  }
  if (@($in.steps).Count -gt ${MAX_STEPS}) { throw 'Too many steps' }
  $proc = Get-Process -Id ([int]$in.pid) -ErrorAction Stop
  if ($proc.Path -ine $in.exe -or [string]$proc.StartTime.ToFileTimeUtc() -ne [string]$in.startFileTime) { throw 'The pinned MagicaVoxel process is no longer the same process' }
  $target = [uint32]$proc.Id
  $main = $proc.MainWindowHandle
  if ($main -eq [IntPtr]::Zero) { throw 'The MagicaVoxel main window was not found' }
  [Ui]::Arm($target, [long]$in.budgetMs)
  function Assure([IntPtr]$h) {
    if ([Ui]::PidOf([Ui]::GetForegroundWindow()) -ne $target) { [void][Ui]::Front($h) }
    if ([Ui]::PidOf([Ui]::GetForegroundWindow()) -ne $target) { throw 'Foreground focus could not be given to the pinned MagicaVoxel process; no input was sent' }
  }
  function ClickRel([int]$dx, [int]$dy, [string]$anchor) {
    $r = [Ui]::Rect($main); $s = [double]$in.scale
    if ($anchor -eq 'bottom-left') { $x = $r[0] + [int]((($r[2] - $r[0]) * 0.4127)); $y = $r[3] - [int]($dy * $s) }
    else { $x = $r[2] - [int]($dx * $s); $y = $r[1] + [int]($dy * $s) }
    [Ui]::Click($x, $y)
  }
  foreach ($step in $in.steps) {
    switch ($step.op) {
      'console' {
        Assure $main
        ClickRel 0 53 'bottom-left'
        Assure $main
        # Ctrl+A selects the console field's old text so the typed command replaces it; nothing is deleted.
        [Ui]::Press(0x41, $true)
        [Ui]::TypeText([string]$step.text); [Ui]::Press(0x0D, $false)
        Start-Sleep -Milliseconds ([int]$step.waitMs)
      }
      'image_tab' { Assure $main; ClickRel 196 113 'top-right'; Start-Sleep -Milliseconds 700 }
      'render_button' {
        Assure $main
        $knownDialogs = @([Ui]::Dialogs($target) | ForEach-Object { $_.ToInt64() })
        ClickRel 239 345 'top-right'
      }
      'save_dialog' {
        $deadline = (Get-Date).AddMilliseconds([int]$step.timeoutMs); $dlg = $null
        while ((Get-Date) -lt $deadline -and -not $dlg) {
          foreach ($d in [Ui]::Dialogs($target)) { if ($knownDialogs -notcontains $d.ToInt64()) { $dlg = $d; break } }
          if (-not $dlg) { Start-Sleep -Milliseconds 250 }
        }
        if (-not $dlg) { throw 'The native save dialog did not appear. Switch MagicaVoxel to its Render mode and try again' }
        if (-not [Ui]::Front($dlg)) { throw 'The save dialog could not be brought to the foreground; no input was sent' }
        [Ui]::Press(0x41, $true); [Ui]::TypeText([string]$step.path); Start-Sleep -Milliseconds 300; [Ui]::Press(0x0D, $false)
        $gone = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $gone -and [Ui]::Dialogs($target).Length -gt 0 -and ([Ui]::Dialogs($target) | Where-Object { $knownDialogs -notcontains $_.ToInt64() })) { Start-Sleep -Milliseconds 250 }
        if ([Ui]::Dialogs($target) | Where-Object { $knownDialogs -notcontains $_.ToInt64() }) { throw 'The save dialog stayed open; the file name was not accepted' }
      }
      default { throw ('Unknown step: ' + $step.op) }
    }
    [void]$log.Add([string]$step.op)
  }
  Emit @{ ok = $true; steps = @($log.ToArray()) }
} catch {
  try { [Ui]::ReleaseModifiers() } catch { }
  Emit @{ ok = $false; error = $_.Exception.Message; steps = @($log.ToArray()) }
}
`.replace("${MAX_STEPS}", String(MAX_STEPS));

type SpawnFn = typeof spawn;

/** Builds the runner: Windows PowerShell with an encoded command and ASCII-escaped JSON on stdin. No shell, no temp files. */
export function makeRunner(spawnFn: SpawnFn = spawn): PowerShellRunner {
  return (script, input, timeoutMs) => new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); action(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error("The window automation helper timed out"))); }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { out += d; if (out.length > 1 << 20) child.kill(); });
    child.stderr?.on("data", (d: Buffer | string) => { if (err.length < 4096) err += String(d); });
    child.stdin?.on("error", () => { /* the helper exited early; the close handler reports it */ });
    child.once("error", (e: Error) => finish(() => reject(e)));
    child.once("close", () => finish(() => {
      try { resolve(JSON.parse((out.trim().split(/\r?\n/).at(-1) ?? "").replace(/^\uFEFF/, ""))); }
      catch { reject(new Error(`The window automation helper returned no result${err ? `: ${err.slice(0, 300)}` : ""}`)); }
    }));
    // ASCII only, so no console code page can change the meaning of a path.
    child.stdin?.end(JSON.stringify(input).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
  });
}
export const runPowerShell: PowerShellRunner = makeRunner();

interface StepResult { ok: boolean; error?: string; steps?: string[]; processes?: { pid: number; exe: string; startFileTime: string }[] }

export interface AppControlDeps {
  /** Replaced in tests so no window is ever touched. */
  run?: PowerShellRunner;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Seconds a growing file must stay unchanged before it counts as finished. */
  settleSeconds?: number;
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function uiScale(exe: string): number {
  try {
    const file = fs.readFileSync(path.join(path.dirname(exe), "config", "config.txt"), "utf8").slice(0, 1 << 20);
    const value = Number(/ui_scale\s*:\s*'([0-9.]+)'/.exec(file)?.[1]);
    if (Number.isFinite(value) && value >= 0.5 && value <= 3) return value / 1.125;
  } catch { /* fall back to the stock scale */ }
  return 1;
}

/**
 * Opt-in control of a running MagicaVoxel window on Windows. The application has no documented command-line or RPC
 * interface, so these tools use its own console and native Final Render dialog. Three claims are kept apart:
 * the process identity is verified, every keystroke and click is preceded by a check that the pinned process owns the
 * foreground, and a render is only reported once the output file has been checked.
 */
export function registerAppControlTools(register: RegisterTool, files: FilePolicy, config: MagicaConfig, deps: AppControlDeps = {}): void {
  const run = deps.run ?? runPowerShell;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const settle = deps.settleSeconds ?? 10;
  let pinned: AppIdentity | undefined;
  // One live-input operation at a time, even if a caller bypasses the shared tool queue.
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const result = lock.then(fn, fn); lock = result.then(() => undefined, () => undefined); return result; };

  const enabled = () => {
    if (platform !== "win32") throw new Error("Live MagicaVoxel control is only available on Windows");
    if (env[UI_AUTOMATION_ENV] !== "1") throw new Error(`Live application control is disabled. It sends real mouse and keyboard input to the MagicaVoxel window while it runs; set ${UI_AUTOMATION_ENV}=1 to allow it`);
  };
  const exe = () => {
    const configured = config.getMagicaPath();
    if (!configured) throw new Error("MagicaVoxel executable not configured; set MAGICAVOXEL_PATH");
    return configured;
  };
  const pin = () => {
    if (!pinned) throw new Error("No application is attached. Start MagicaVoxel (open_in_magicavoxel) and call attach_magicavoxel_app first");
    return pinned;
  };
  const execute = async (steps: unknown[], timeoutMs: number): Promise<string[]> => {
    const identity = pin();
    const result = await run(UI_SCRIPT, { mode: "steps", ...identity, scale: uiScale(identity.exe), budgetMs: timeoutMs - 5000, steps }, timeoutMs) as StepResult;
    if (!result.ok) throw new Error(result.error ?? "The window automation step failed");
    return result.steps ?? [];
  };

  register({
    name: "attach_magicavoxel_app",
    description: `Pin a running MagicaVoxel process (matched by the configured executable path, process id and start time) for live control. Requires MAGICVOXEL_MCP_UI_AUTOMATION=1 on Windows and MagicaVoxel ${CALIBRATED_VERSION} (the click positions were calibrated on it). Pass pid when several instances run`,
    inputSchema: z.object({ pid: z.number().int().positive().optional() }).strict(),
  }, ({ pid }) => exclusive(async () => {
    enabled();
    const wanted = exe();
    const version = resolveInstall({ MAGICAVOXEL_PATH: wanted }).version;
    if (version !== CALIBRATED_VERSION && env[UI_ANY_VERSION_ENV] !== "1") throw new Error(`Live control is calibrated for MagicaVoxel ${CALIBRATED_VERSION}, found ${version ?? "an unknown version"}. Set ${UI_ANY_VERSION_ENV}=1 to try anyway`);
    const result = await run(UI_SCRIPT, { mode: "list" }, 30000) as StepResult;
    if (!result.ok) throw new Error(result.error ?? "Listing processes failed");
    const matches = (result.processes ?? []).filter(p => p.exe && samePath(p.exe, wanted));
    if (!matches.length) throw new Error("No running MagicaVoxel process uses the configured executable. Start it first (open_in_magicavoxel)");
    const chosen = pid === undefined ? (matches.length === 1 ? matches[0]! : undefined) : matches.find(p => p.pid === pid);
    if (!chosen) throw new Error(pid === undefined ? `Several instances are running (pids ${matches.map(p => p.pid).join(", ")}); pass pid` : `Process ${pid} is not a MagicaVoxel instance of the configured executable`);
    pinned = { pid: chosen.pid, exe: path.resolve(wanted), startFileTime: String(chosen.startFileTime) };
    return text({ attached: true, pid: pinned.pid, version, identity: "executable path, process id and start time" });
  }));

  const camera = z.object({
    x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
    zoom: z.number().optional(), fov: z.number().optional(),
    rx: z.number().optional(), ry: z.number().optional(), rz: z.number().optional(),
    focus: z.boolean().optional().describe("First run the application's own \"cam focus\", which re-centers the camera on the whole scene; later values are then applied on top"),
  }).strict();
  register({
    name: "set_app_camera",
    description: "Move the live camera of the attached MagicaVoxel window by typing its own console commands (cam x/y/z, zoom, fov, rx/ry/rz; absolute values, angles in degrees; a negative rx looks down from above; focus re-frames the whole scene first). The window MUST be in Render mode: in the model editor the typed letters would trigger editing shortcuts. Takes over mouse and keyboard for a few seconds. The application does not report the camera back, so the result states what was submitted, not what was confirmed",
    inputSchema: camera,
  }, args => exclusive(async () => {
    enabled();
    const pose: Partial<Record<CameraKey, number>> = {};
    for (const key of CAMERA_KEYS) if (args[key] !== undefined) pose[key] = args[key]!;
    const commands = cameraCommands(pose, { focus: args.focus });
    await execute(commands.map(command => ({ op: "console", text: command, waitMs: 600 })), 30000 + commands.length * 8000);
    return text({ submitted: commands, processVerified: true, applied: "not confirmed by the application" });
  }));

  register({
    name: "export_native_render",
    description: "Run the application's own Final Render (Photo) in the attached MagicaVoxel window, which must be in Render mode with the scene open, and save the PNG. Takes over mouse and keyboard while starting. Returns only after the file exists, is stable, is a regular file inside the workspace written by this run, and passes PNG structure and checksum checks at the requested size. Refuses to overwrite",
    inputSchema: z.object({
      path: z.string(),
      // Not named width/height: the shared tool wrapper caps parameters called "height" at the model limit of 256.
      imageWidth: z.number().int().min(1).max(12000).default(1920),
      imageHeight: z.number().int().min(1).max(12000).default(1080),
      timeoutSeconds: z.number().int().min(30).max(3600).default(600),
    }).strict(),
  }, ({ path: target, imageWidth: width, imageHeight: height, timeoutSeconds }) => exclusive(async () => {
    enabled();
    if (path.extname(target).toLowerCase() !== ".png") throw new Error("The output must be a .png file");
    checkTypablePath(target);
    files.resolve(target, "write");
    if (fs.existsSync(target)) throw new Error("The output file already exists; choose a new name");
    const commands = photoSizeCommands(width, height);
    const nativePath = platform === "win32" ? target.replace(/\//g, "\\") : target;
    const steps = [
      ...commands.map(command => ({ op: "console", text: command, waitMs: 500 })),
      { op: "image_tab" }, { op: "render_button" },
      { op: "save_dialog", path: nativePath, timeoutMs: 20000 },
    ];
    const startedWall = Date.now();
    await execute(steps, 120000);
    const started = now();
    let last = -1, stableSince = started;
    for (;;) {
      if (now() - started > timeoutSeconds * 1000) throw new Error(`The render did not finish within ${timeoutSeconds} seconds; the application may still be rendering and could write the file later`);
      await sleep(1000);
      if (!fs.existsSync(target)) continue;
      const size = fs.statSync(target).size;
      if (size !== last) { last = size; stableSince = now(); continue; }
      if (size > 0 && now() - stableSince >= settle * 1000) break;
    }
    const observedStable = (now() - stableSince) / 1000;
    const link = fs.lstatSync(target);
    if (link.isSymbolicLink() || !link.isFile()) throw new Error("The output is not a regular file");
    if (link.mtimeMs < startedWall - 2000) throw new Error("The output file was not written by this render");
    files.resolve(target, "read");
    if (link.size > MAX_VERIFY_BYTES) throw new Error(`The output is ${link.size} bytes, too large to verify (limit ${MAX_VERIFY_BYTES})`);
    const bytes = fs.readFileSync(target);
    const png = inspectPng(bytes, { verifyCrc: true, maxPixels: 144_000_000, maxInputBytes: MAX_VERIFY_BYTES });
    if (png.width !== width || png.height !== height) throw new Error(`The file is ${png.width}x${png.height}, not the requested ${width}x${height}`);
    return text({ path: target, width: png.width, height: png.height, bytes: bytes.length, verified: { fileStableSeconds: Math.floor(observedStable), regularFileInsideWorkspace: true, writtenByThisRun: true, pngStructureAndChecksums: true, dimensions: true }, note: "This is the application's own final render, not the palette preview" });
  }));
}
