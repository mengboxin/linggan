from __future__ import annotations

import posixpath
import base64
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from services.svg_to_pptx import create_pptx_with_native_svg


_REL_NS = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}


def _relationship_source_dir(rels_name: str) -> str:
    if rels_name == "_rels/.rels":
        return ""
    prefix, rel_filename = rels_name.rsplit("/_rels/", 1)
    source_filename = rel_filename.removesuffix(".rels")
    return posixpath.dirname(posixpath.join(prefix, source_filename))


def test_pptx_notes_keep_all_internal_relationship_targets_present(tmp_path: Path):
    svg_path = tmp_path / "01_cover.svg"
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">'
        '<rect x="0" y="0" width="1792" height="1024" fill="#ffffff"/>'
        '<text x="120" y="180" font-size="48">Editable title</text>'
        "</svg>",
        encoding="utf-8",
    )
    output_path = tmp_path / "notes.pptx"

    created = create_pptx_with_native_svg(
        [svg_path],
        output_path,
        notes={"01_cover": "# Speaker notes\n\n- First point"},
        enable_notes=True,
        use_native_shapes=True,
        transition=None,
        verbose=False,
    )

    assert created is True
    with zipfile.ZipFile(output_path) as package:
        names = set(package.namelist())
        missing: list[tuple[str, str]] = []
        for rels_name in sorted(name for name in names if name.endswith(".rels")):
            root = ET.fromstring(package.read(rels_name))
            source_dir = _relationship_source_dir(rels_name)
            for relationship in root.findall("rel:Relationship", _REL_NS):
                if relationship.get("TargetMode") == "External":
                    continue
                target = relationship.get("Target") or ""
                resolved = posixpath.normpath(posixpath.join(source_dir, target))
                if resolved not in names:
                    missing.append((rels_name, resolved))

    assert missing == []
    assert "ppt/notesMasters/notesMaster1.xml" in names
    with zipfile.ZipFile(output_path) as package:
        notes_xml = package.read("ppt/notesSlides/notesSlide1.xml").decode("utf-8")
        content_types_root = ET.fromstring(package.read("[Content_Types].xml"))
    assert "Speaker notes" in notes_xml
    assert 'type="body" idx="3"' in notes_xml
    assert 'type="sldNum" idx="5"' in notes_xml
    content_type_children = [child.tag.rsplit("}", 1)[-1] for child in content_types_root]
    first_override = content_type_children.index("Override")
    assert all(name == "Default" for name in content_type_children[:first_override])
    notes_overrides = [
        child for child in content_types_root
        if child.get("PartName") == "/ppt/notesSlides/notesSlide1.xml"
    ]
    assert len(notes_overrides) == 1


def test_pptx_export_keeps_masked_images_as_native_picture_geometry(tmp_path: Path):
    png = base64.b64encode(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99\x3d\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
    ).decode()
    svg_path = tmp_path / "masked.svg"
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">'
        '<defs><clipPath id="arc" clipPathUnits="objectBoundingBox">'
        '<path d="M 0.18 0 L 1 0 L 1 1 L 0.18 1 C 0.02 0.74 0.02 0.26 0.18 0 Z"/>'
        '</clipPath></defs>'
        f'<image href="data:image/png;base64,{png}" x="900" y="120" width="700" height="760" '
        'preserveAspectRatio="xMaxYMid slice" clip-path="url(#arc)"/>'
        '<text x="120" y="180" font-size="48">Editable title</text>'
        '</svg>',
        encoding="utf-8",
    )
    output_path = tmp_path / "masked.pptx"

    assert create_pptx_with_native_svg(
        [svg_path],
        output_path,
        enable_notes=False,
        use_native_shapes=True,
        transition=None,
        verbose=False,
    )

    with zipfile.ZipFile(output_path) as package:
        slide_xml = package.read("ppt/slides/slide1.xml").decode("utf-8")

    assert "<p:pic>" in slide_xml
    assert "<a:custGeom>" in slide_xml
    assert "<a:cubicBezTo>" in slide_xml


def test_pptx_export_keeps_positioned_svg_text_lines_editable_and_bounded(tmp_path: Path):
    svg_path = tmp_path / "multiline.svg"
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1792 1024">'
        '<rect x="0" y="0" width="1792" height="1024" fill="#ffffff"/>'
        '<text x="140" y="220" font-family="Microsoft YaHei, Arial, sans-serif" font-size="42" font-weight="700">'
        '<tspan x="140" dy="0">第一行必须保持可编辑</tspan>'
        '<tspan x="140" dy="58">第二行不能与第一行重叠</tspan>'
        '<tspan x="140" dy="58">第三行不能穿过其他版面</tspan>'
        '</text>'
        '</svg>',
        encoding="utf-8",
    )
    output_path = tmp_path / "multiline.pptx"

    assert create_pptx_with_native_svg(
        [svg_path],
        output_path,
        enable_notes=False,
        use_native_shapes=True,
        transition=None,
        verbose=False,
    )

    with zipfile.ZipFile(output_path) as package:
        slide_xml = package.read("ppt/slides/slide1.xml").decode("utf-8")

    assert slide_xml.count("<a:p>") == 3
    assert '<a:bodyPr wrap="square"' in slide_xml
    assert "<a:normAutofit" in slide_xml
    assert "<a:spAutoFit" not in slide_xml
