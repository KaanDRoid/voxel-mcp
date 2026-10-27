# Native export calibration fixtures

These files were exported from a project-authored scene in MagicaVoxel 0.99.7.2
on Windows. They are not bundled sample models or copied third-party assets.

The source grid is 3x4x5 with four occupied cells. Colors use little-endian
RGBA packing (`0xAABBGGRR`):

| XYZ | Index | RGBA |
| --- | --- | --- |
| 0,0,0 | 1 | 0xff1450ff |
| 2,0,1 | 2 | 0xffff5014 |
| 0,3,4 | 3 | 0xff50ff14 |
| 1,1,2 | 4 | 0xffb45a28 |

The native XRAW, Slab6 VOX, QB, OBJ/MTL/palette PNG and PLY exports are tested
against these independently specified colored coordinates or exposed surfaces.
The native Slab6 bytes additionally verify six-bit palette truncation and Y/Z
orientation. Mesh comparisons allow different face merging and serialization
order while checking colored surface coverage, pivot, scale and winding.
