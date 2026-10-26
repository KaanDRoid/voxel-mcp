# Scene performance

Scenes used to be stored as serialized bytes and decoded again for every tool call; metadata matching during
encoding and layer lookups during validation were linear scans inside loops. Scenes are now stored parsed:

- reads (`get_scene_info`, `extract_scene_model`, `flatten_scene`) use the stored scene directly;
- edits work on a copy-on-write snapshot (graph, metadata and render settings are copied, voxel data is shared)
  and replace the stored scene only after cheap validation succeeds, so a failed edit changes nothing;
- serialization happens in `save_scene` and `list_scenes` (cached until the next edit);
- node, layer and material lookups and the chunk matching in `encodeVOXScene` use `Map`s.

## Measurements

Node 26, Windows, warm process, mean of 5 runs, single call (not including JSON transport).
The 1002-node scene is synthetic (500 objects, 32 layers, 256 materials). Sample files come from a local
MagicaVoxel 0.99.7.2 install.

| Operation | Before (decode on every call) | After |
|---|---|---|
| `get_scene_info`, 1002 nodes | 7.7 ms | 0.4 ms |
| `set_scene_node`, 1002 nodes | 17.1 ms | 1.6 ms |
| `get_scene_info`, menger.vox (160,000 voxels) | 19.1 ms | 0.1 ms |
| `set_scene_node`, menger.vox | 34.4 ms | 0.5 ms |
| `get_scene_info`, monu1.vox (156,942 voxels) | 14.1 ms | 0.1 ms |
| `set_scene_node`, monu1.vox | 33.0 ms | 0.6 ms |
| `save_scene` (encode), menger.vox | included in every edit | 28.8 ms |

The quadratic behaviour was not a practical problem at 1000 nodes (the whole decode took under 10 ms); the gain
comes mainly from not re-decoding and re-encoding voxel data on every call. `tests/scene-perf.test.ts` guards
against regressions with generous limits.
