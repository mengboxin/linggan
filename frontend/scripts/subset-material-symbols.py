from __future__ import annotations

import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "src"
INPUT_FONT = ROOT / "node_modules" / "material-symbols" / "material-symbols-outlined.woff2"
OUTPUT_FONT = SOURCE_ROOT / "assets" / "material-symbols-outlined-subset.woff2"
SOURCE_EXTENSIONS = {".ts", ".tsx", ".css", ".html"}
ESSENTIAL_ICONS = {
    "error",
    "history",
    "image",
    "progress_activity",
    "warning",
}


def source_tokens() -> set[str]:
    tokens = set(ESSENTIAL_ICONS)
    paths = [path for path in SOURCE_ROOT.rglob("*") if path.suffix in SOURCE_EXTENSIONS]
    paths.append(ROOT / "index.html")
    for path in paths:
        text = path.read_text(encoding="utf-8", errors="ignore")
        tokens.update(re.findall(r"\b[a-z][a-z0-9_]{1,}\b", text))
    return tokens


def main() -> None:
    font = TTFont(INPUT_FONT)
    glyph_order = set(font.getGlyphOrder())
    tokens = source_tokens()
    icon_glyphs = {
        glyph
        for glyph in glyph_order
        if glyph != ".notdef" and glyph.removesuffix(".fill") in tokens
    }

    cmap = font.getBestCmap() or {}
    ligature_chars = set("".join(glyph.removesuffix(".fill") for glyph in icon_glyphs))
    input_glyphs = {cmap[ord(char)] for char in ligature_chars if ord(char) in cmap}
    if ord(" ") in cmap:
        input_glyphs.add(cmap[ord(" ")])

    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    # The source font uses a compact ligature table. Keeping layout closure off
    # preserves the selected name-to-glyph mappings without pulling the entire
    # 4 MB icon catalog into the web bundle.
    options.layout_closure = False
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    options.name_legacy = True
    options.name_languages = [0x409]
    options.notdef_glyph = True
    options.notdef_outline = True
    options.recommended_glyphs = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(glyphs=sorted(icon_glyphs | input_glyphs | {".notdef"}))
    subsetter.subset(font)

    OUTPUT_FONT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUTPUT_FONT)
    print(f"wrote {OUTPUT_FONT} with {len(icon_glyphs)} icon glyphs ({OUTPUT_FONT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
