# Nature textures

Used by `apps/city-client/src/nature` (bark of the trees, deep and trampled snow in the city). Made by
`apps/city-client/dev/nature-tex.py` (Pillow) from 2K CC0 PBR sets, downsized:

| file | from | source | licence |
|---|---|---|---|
| `bark.jpg`, `bark_nrm.jpg` cell 0 | sakura_bark | Poly Haven | CC0 |
| cell 1 | pine_bark | Poly Haven | CC0 |
| cell 2, cell 6 (greyed) | japanese_cedar_bark | Poly Haven | CC0 |
| cell 3, cell 7 (with flakes drawn) | Bark005 | ambientCG | CC0 |
| cell 4 (birch), cell 5 (plane) | drawn by the script | this project | — |
| `snow.jpg`, `snow_nrm.jpg` | snow_02 (Rob Tuytel) | Poly Haven | CC0 |
| `trod.jpg`, `trod_nrm.jpg` | Snow006 | ambientCG | CC0 |
| `slush.jpg` | Snow012 | ambientCG | CC0 |

Normal maps are OpenGL (+Y up). The leaf atlas is not a file: it is drawn at start (`src/nature/atlas.ts`).
