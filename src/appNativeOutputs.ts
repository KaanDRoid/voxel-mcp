import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { FilePolicy } from './files.js';
import { decodeVOXScene } from './scene.js';
import { preflightSceneFile, SCENE_INPUT_BYTES } from './sceneEditing.js';
import { inspectPng } from './png.js';
import { throwIfRequestAborted } from './requestContext.js';

type Register = <T extends z.ZodRawShape>(d: { name: string; description: string; inputSchema: z.ZodObject<T> }, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
export interface NativeOutputAccess {
  enabled(): void;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  execute(steps: unknown[], timeoutMs: number): Promise<string[]>;
  checkPath(value: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  settle: number;
}
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEQUENCE_BYTES = 256 * 1024 * 1024;

export function registerNativeOutputs(register: Register, files: FilePolicy, access: NativeOutputAccess): void {
  const target = (value: string, extension: string) => {
    if (path.extname(value).toLowerCase() !== extension) throw new Error(`Output must be a ${extension} file`);
    const resolved = files.prepareOutput(value);
    access.checkPath(resolved);
    if (fs.existsSync(resolved)) throw new Error('Output already exists; choose a fresh name');
    return resolved;
  };
  const nativePath = (value: string) => value.replaceAll('/', String.fromCharCode(92));
  const regular = (value: string, startedWall: number, maxBytes: number) => {
    files.resolve(value, 'read');
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native output must be a regular in-workspace file');
    if (stat.size > maxBytes) throw new Error('Native output exceeds its verification byte budget');
    if (stat.mtimeMs < startedWall - 2000) throw new Error('Native output timestamp predates this operation');
    return stat;
  };
  const waitStable = async (paths: string[], startedWall: number, timeoutSeconds: number, fileLimit: number) => {
    const started = access.now();
    let signature = '', stableSince = started;
    for (;;) {
      throwIfRequestAborted();
      if (access.now() - started > timeoutSeconds * 1000) throw new Error('Native output timed out; the application may still render and write files later');
      await access.sleep(1000);
      throwIfRequestAborted();
      if (paths.some(p => !fs.existsSync(p))) { signature = ''; stableSince = access.now(); continue; }
      const stats = paths.map(p => regular(p, startedWall, fileLimit));
      if (stats.reduce((sum, s) => sum + s.size, 0) > MAX_SEQUENCE_BYTES) throw new Error('Native output sequence exceeds 256 MiB');
      const next = stats.map(s => `${s.size}:${s.mtimeMs}`).join('|');
      if (next !== signature || stats.some(s => s.size === 0)) { signature = next; stableSince = access.now(); continue; }
      if (access.now() - stableSince >= access.settle * 1000) return Math.floor((access.now() - stableSince) / 1000);
    }
  };

  const cameraSchema = z.object({ path: z.string(), cameraId: z.number().int().min(0).max(9).default(9), timeoutSeconds: z.number().int().min(30).max(120).default(30) }).strict();
  register({ name: 'export_app_camera_snapshot', description: 'Capture the actual live camera by running cam save into cameraId and saving the open native project AS a fresh workspace VOX snapshot, then decode that camera slot. Windows opt-in; Render mode required. Changes the selected camera slot, overwrites that in-memory slot and changes the active project filename to the snapshot. Not a passive/read-only query. Native raw angle vectors can differ from cam command coordinates. Existing files are refused; snapshot freshness is observed, not cryptographic proof of writer identity.', inputSchema: cameraSchema }, args => access.exclusive(async () => {
    access.enabled();
    const { path: requested, cameraId, timeoutSeconds } = cameraSchema.parse(args);
    const output = target(requested, '.vox');
    const startedWall = Date.now();
    await access.execute([
      { op: 'console', text: `set cam_slot ${cameraId}`, waitMs: 300 },
      { op: 'console', text: 'cam save', waitMs: 1000 },
    ], 30000);
    await access.execute([
      { op: 'save_project_as' },
      { op: 'save_dialog', path: nativePath(output), timeoutMs: 20000 },
    ], 60000);
    await waitStable([output], startedWall, timeoutSeconds, SCENE_INPUT_BYTES);
    regular(output, startedWall, SCENE_INPUT_BYTES);
    throwIfRequestAborted();
    const bytes = fs.readFileSync(output);
    preflightSceneFile(bytes);
    const camera = decodeVOXScene(bytes).render.cameras.find(c => c.id === cameraId);
    if (!camera) throw new Error('The fresh native snapshot does not contain the requested camera slot');
    for (const key of ['_focus', '_angle']) {
      const values = camera.attributes[key]?.trim().split(/\s+/).map(Number);
      if (!values || values.length !== 3 || values.some(n => !Number.isFinite(n))) throw new Error('Native camera snapshot contains invalid vectors');
    }
    for (const key of ['_radius', '_fov']) if (!Number.isFinite(Number(camera.attributes[key])) || camera.attributes[key] === undefined) throw new Error('Native camera snapshot contains invalid numeric metadata');
    return text({ path: output, camera, source: 'native_saved_camera', sideEffects: ['selected camera slot changed', 'camera slot updated', 'active project filename changed'], verified: { freshSnapshot: true, cameraDecoded: true } });
  }));

  const sequenceSchema = z.object({
    path: z.string(), kind: z.enum(['turntable', 'animation']),
    frames: z.number().int().min(1).max(120).optional(), angle: z.number().int().min(0).max(360).optional(), blur: z.number().int().min(0).max(100).optional(),
    start: z.number().int().min(0).max(120).optional(), end: z.number().int().min(0).max(120).optional(),
    timeoutSeconds: z.number().int().min(30).max(3600).default(600),
  }).strict().superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.kind === 'turntable' && (v.start !== undefined || v.end !== undefined)) bad('start/end are for animation only');
    if (v.kind === 'animation') {
      if (v.frames !== undefined || v.angle !== undefined || v.blur !== undefined) bad('frames/angle/blur are for turntable only');
      if (v.start === undefined || v.end === undefined || v.end < v.start || v.end - v.start + 1 > 120) bad('Animation requires an inclusive start..end range of at most 120 frames');
    }
  });
  register({ name: 'export_native_sequence', description: 'Run MagicaVoxel native Final Render Turntable or Anim, not palette previews or a loop of Photo calls. Uses the current native render-buffer resolution (Photo width/height do NOT set sequence size). Turntable accepts frames 1..120, angle 0..360 and blur 0..100; animation uses inclusive start/end 0..120 with at most 120 outputs. Writes base (0000).png style files; animation suffixes use native timeline indices. Validates every fresh stable frame and common dimensions. Requires Windows opt-in and Render mode; cancellation cannot stop a native job already started.', inputSchema: sequenceSchema }, args => access.exclusive(async () => {
    access.enabled();
    const options = sequenceSchema.parse(args);
    const base = target(options.path, '.png');
    const start = options.kind === 'animation' ? options.start! : 0;
    const count = options.kind === 'animation' ? options.end! - start + 1 : options.frames ?? 12;
    const paths = Array.from({ length: count }, (_, i) => base.slice(0, -4) + ` (${String(start + i).padStart(4, '0')}).png`);
    for (const output of paths) {
      access.checkPath(output);
      files.resolve(output, 'write');
      if (fs.existsSync(output)) throw new Error('A sequence frame already exists; choose a fresh base name');
    }
    const commands = options.kind === 'turntable'
      ? [`set pt_spin_frames ${count}`, `set pt_spin_angle ${options.angle ?? 360}`, `set pt_spin_blur ${options.blur ?? 0}`]
      : [`set pt_anim_f0 ${start}`, `set pt_anim_f1 ${options.end!}`];
    const startedWall = Date.now();
    await access.execute([
      ...commands.map(command => ({ op: 'console', text: command, waitMs: 300 })),
      { op: 'image_tab' }, { op: 'image_mode', kind: options.kind }, { op: 'render_button', kind: options.kind },
      { op: 'save_dialog', path: nativePath(base), timeoutMs: 20000 },
    ], 90000);
    const stableSeconds = await waitStable(paths, startedWall, options.timeoutSeconds, MAX_FRAME_BYTES);
    let width = 0, height = 0;
    const frames = paths.map((output, i) => {
      throwIfRequestAborted();
      regular(output, startedWall, MAX_FRAME_BYTES);
      const bytes = fs.readFileSync(output);
      const png = inspectPng(bytes, { verifyCrc: true, maxInputBytes: MAX_FRAME_BYTES, maxPixels: 16_000_000 });
      if (i === 0) { width = png.width; height = png.height; }
      if (png.width !== width || png.height !== height) throw new Error('Native sequence frames have inconsistent dimensions');
      return { path: output, frameIndex: start + i, bytes: bytes.length };
    });
    return text({ kind: options.kind, frames, width, height, verified: { pngStructureAndChecksums: true, commonDimensions: true, stableSeconds }, note: 'Native render-buffer resolution; the native application may continue after observation is cancelled.' });
  }));
}
