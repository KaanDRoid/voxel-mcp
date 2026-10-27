import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { VoxScene } from './scene.js';

/**
 * Native mapping evidence:
 * - ephtracy/voxel-model, MagicaVoxel-file-format-vox-extension.txt, sections 4/6/7:
 *   https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox-extension.txt
 *   MATL type names; rCAM vectors, integer radius/fov and string mode.
 * - MagicaVoxel 0.99.7.2 bundled samples (read-only inspection):
 *   vox/anim/Gomez.vox MATL 256: _type=_metal, _metal=1, _rough=0.192079;
 *   vox/room.vox MATL 164: _type=_emit, _emit=1, _flux=2;
 *   vox/teapot.vox and vox/room.vox: _inf/_uni dictionaries used below;
 *   both contain rCAM slots 0..9 with _mode=pers and _fov=45.
 * Numeric limits here are conservative tool policy, not claimed native-format maxima.
 * Presets are authored metadata patches, not verified renderer output or physical units.
 */

export const SCENE_PRESET_TOOL_NAMES = [
  'set_scene_material_properties', 'apply_scene_lighting_preset', 'set_scene_camera_pose',
] as const;

export type ScenePresetRegister = <T extends z.ZodRawShape>(definition: {
  name: string; description: string; inputSchema: z.ZodObject<T>;
}, handler: (args: z.infer<z.ZodObject<T>>) => Promise<CallToolResult>) => void;
export interface ScenePresetAccess {
  /** Returns an editable copy, never the stored scene. */
  get(sceneId: string): VoxScene;
  /** Validates and atomically replaces the stored scene. */
  commit(scene: VoxScene, sceneId: string): unknown;
}
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const unit = () => z.number().finite().min(0).max(1);

export function registerScenePresetTools(register: ScenePresetRegister, access: ScenePresetAccess): void {
  const materialSchema = z.object({
    sceneId: z.string().min(1).max(128), index: z.number().int().min(1).max(256),
    type: z.enum(['diffuse', 'metal', 'glass', 'emit']),
    roughness: unit().optional(), metalness: unit().optional(),
    ior: unit().describe('Raw native _ior metadata; not the physical refractive index (_ri)').optional(),
    emission: unit().optional(), flux: z.number().finite().min(0).max(4).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.metalness !== undefined && value.type !== 'metal') ctx.addIssue({ code: 'custom', path: ['metalness'], message: 'metalness requires type metal' });
    if (value.type !== 'emit') for (const key of ['emission', 'flux'] as const) {
      if (value[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} requires type emit` });
    }
  });
  register({ name: 'set_scene_material_properties', description: 'Merge typed native MATL file metadata: type -> _type, roughness -> _rough, metalness -> _metal (type metal only), ior -> _ior (raw metadata, not physical IOR; existing _ri is untouched), emission -> _emit and flux -> _flux (type emit only). Numeric policy 0..1 except flux 0..4; no physical units. Unknown and omitted attributes survive. Material ids 1..256; palette mapping of 256 is unverified.', inputSchema: materialSchema }, async args => {
    const { sceneId, index, type, roughness, metalness, ior, emission, flux } = materialSchema.parse(args);
    const scene = access.get(sceneId);
    const material = scene.materials.find(m => m.id === index);
    const attributes = { ...material?.attributes, _type: `_${type}` };
    if (roughness !== undefined) Object.assign(attributes, { _rough: String(roughness) });
    if (metalness !== undefined) Object.assign(attributes, { _metal: String(metalness) });
    if (ior !== undefined) Object.assign(attributes, { _ior: String(ior) });
    if (emission !== undefined) Object.assign(attributes, { _emit: String(emission) });
    if (flux !== undefined) Object.assign(attributes, { _flux: String(flux) });
    if (material) material.attributes = attributes;
    else scene.materials.push({ id: index, attributes });
    access.commit(scene, sceneId);
    return text({ sceneId, index, attributes });
  });
  const lightingSchema = z.object({ sceneId: z.string().min(1).max(128), preset: z.enum(['studio', 'daylight', 'night']) }).strict();
  register({ name: 'apply_scene_lighting_preset', description: 'Merge authored studio/daylight/night rOBJ file-metadata presets into _inf and _uni. Studio uses teapot.vox values; daylight uses room.vox strengths/ambient color; night reduces those strengths. Not physical lighting units, environment-mode switching, or native renderer control. Other settings and unknown attributes survive.', inputSchema: lightingSchema }, async args => {
    const { sceneId, preset } = lightingSchema.parse(args);
    const settings = {
      studio: { key: '0.6', ambient: '0.7', color: '255 255 255' },
      daylight: { key: '1', ambient: '0.59', color: '177 218 255' },
      night: { key: '0.1', ambient: '0.1', color: '177 218 255' },
    }[preset];
    const scene = access.get(sceneId);
    for (const [type, properties] of [
      ['_inf', { _i: settings.key, _k: '255 255 255', _angle: '50 50', _area: '0.07', _disk: '0' }],
      ['_uni', { _i: settings.ambient, _k: settings.color }],
    ] as const) {
      const object = scene.render.objects.find(o => o.type === type);
      const attributes = { ...object?.attributes, ...properties, _type: type };
      if (object) object.attributes = attributes;
      else scene.render.objects.push({ type, attributes });
    }
    access.commit(scene, sceneId);
    return text({ sceneId, preset });
  });
  const coordinate = () => z.number().finite().min(-1_000_000).max(1_000_000);
  const angleValue = () => z.number().finite().min(-360).max(360);
  const cameraSchema = z.object({
    sceneId: z.string().min(1).max(128), cameraId: z.number().int().min(0).max(9),
    focus: z.tuple([coordinate(), coordinate(), coordinate()]),
    angle: z.tuple([angleValue(), angleValue(), angleValue()]),
    radius: z.number().int().min(0).max(1_000_000), fov: z.number().int().min(1).max(179),
    projection: z.enum(['perspective']).optional(),
  }).strict();
  register({ name: 'set_scene_camera_pose', description: 'Merge native rCAM slot 0..9: focus -> _focus and angle -> _angle as raw native three-component vectors (no axis/order conversion); radius -> _radius (integer 0..1000000); fov -> _fov (integer 1..179). Coordinates bounded +/-1000000, angles +/-360 as tool policy. Only verified perspective -> _mode pers is exposed. Omitted projection preserves an existing mode, or defaults new slots to pers. _frustum stays untouched: no unverified relationship is derived. This edits file metadata, not a live camera.', inputSchema: cameraSchema }, async args => {
    const { sceneId, cameraId, focus, angle, radius, fov, projection } = cameraSchema.parse(args);
    const scene = access.get(sceneId);
    const camera = scene.render.cameras.find(c => c.id === cameraId);
    const attributes = {
      ...camera?.attributes,
      _focus: focus.join(' '), _angle: angle.join(' '), _radius: String(radius), _fov: String(fov),
    };
    if (projection !== undefined || !camera) Object.assign(attributes, { _mode: 'pers' });
    if (camera) camera.attributes = attributes;
    else scene.render.cameras.push({ id: cameraId, attributes });
    access.commit(scene, sceneId);
    return text({ sceneId, cameraId, attributes });
  });
}
