# Excalifont measurement asset

`src/features/structured/native-font.json` merges the seven Excalifont WOFF2
subsets shipped by `@excalidraw/excalidraw@0.18.1` into one TTF for D2
measurement. Original glyph advances and bearings are preserved. The browser
renders the unmodified package WOFF2 files.

Copyright (c) 2024 by Excalidraw. All rights reserved.
The font is distributed under [SIL OFL 1.1](native-Excalifont-LICENSE.txt),
including the original author and designer attribution in that bundled notice.
Source hashes and original metadata accompany the generated asset.

Reproduce in a disposable Python environment with fonttools 4.59.0 and brotli 1.1.0:

```sh
python scripts/convert-native-font.py node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont src/features/structured/native-font.json
```
