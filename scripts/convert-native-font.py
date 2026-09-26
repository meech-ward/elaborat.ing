"""Reproduce D2 metrics from all Excalidraw 0.18.1 Excalifont WOFF2 subsets.

Run in a disposable Python environment with fonttools==4.59.0, brotli==1.1.0.
Arguments: pinned package Excalifont directory, output JSON path.
No new glyphs or platform fallbacks are introduced. No network at runtime.
"""
import base64
import hashlib
import io
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.merge import Merger

paths = sorted(Path(sys.argv[1]).glob('Excalifont-Regular-*.woff2'))
assert len(paths) == 7, 'Expected the seven subsets shipped by the pinned package'
sources = []
expected_metrics = {}
licenses = set()
decompressed = []
for path in paths:
    source = path.read_bytes()
    subset = TTFont(io.BytesIO(source), recalcTimestamp=False)
    cmap = subset.getBestCmap()
    for codepoint, glyph in cmap.items():
        metric = subset['hmtx'][glyph]
        assert codepoint not in expected_metrics or expected_metrics[codepoint] == metric
        expected_metrics[codepoint] = metric
    licenses.update(record.toUnicode() for record in subset['name'].names if record.nameID in (0, 13, 14))
    sources.append({
        'path': f'Excalifont/{path.name}',
        'sha256': hashlib.sha256(source).hexdigest(),
        'unicodeRange': ','.join(f'U+{codepoint:X}' for codepoint in sorted(cmap)),
    })
    subset.flavor = None
    buffer = io.BytesIO()
    subset.save(buffer)
    buffer.seek(0)
    decompressed.append(buffer)

font = Merger().merge(decompressed)
font.recalcTimestamp = False
# The merged font must retain every original advance and bearing exactly.
merged_cmap = font.getBestCmap()
assert set(merged_cmap) == set(expected_metrics)
for codepoint, metric in expected_metrics.items():
    assert font['hmtx'][merged_cmap[codepoint]] == metric
target = io.BytesIO()
font.save(target)
ttf = target.getvalue()
result = {
    'source': '@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Excalifont',
    'faces': sources,
    'ttfSha256': hashlib.sha256(ttf).hexdigest(),
    'license': sorted(licenses),
    'glyphCoverage': {'codepoints': len(merged_cmap), 'cjk': 0x4E2D in merged_cmap, 'emoji': 0x1F600 in merged_cmap},
    'ttfBase64': base64.b64encode(ttf).decode('ascii'),
}
with open(sys.argv[2], 'w') as output:
    json.dump(result, output, indent=2)
    output.write('\n')
print(json.dumps({key:value for key,value in result.items() if key != 'ttfBase64'}, indent=2))
