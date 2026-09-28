from __future__ import annotations

import io
import zipfile

import pytest
from fastapi import UploadFile
from starlette.datastructures import Headers

from routers import attachments
from routers.attachments import parse_attachments
from services.attachment_parser import parse_attachment_bytes


def _docx_bytes() -> bytes:
    document_xml = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
    <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">
      <w:body>
        <w:p><w:r><w:t>研究背景</w:t></w:r></w:p>
        <w:p><w:r><w:t>这是 Word 正文内容。</w:t></w:r></w:p>
      </w:body>
    </w:document>"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


def test_docx_attachment_extracts_document_text():
    parsed = parse_attachment_bytes(
        "研究计划.docx",
        _docx_bytes(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    assert parsed.kind == "docx"
    assert "研究背景" in parsed.text
    assert "Word 正文内容" in parsed.text
    assert parsed.warnings == []


def test_malformed_docx_returns_a_safe_attachment_with_warning():
    parsed = parse_attachment_bytes("损坏文件.docx", b"not-a-zip-docx")

    assert parsed.kind == "docx"
    assert parsed.text == "[未提取到可用文本]"
    assert any("docx 解析失败" in warning for warning in parsed.warnings)


@pytest.mark.asyncio
async def test_attachment_parse_route_accepts_a_docx_upload():
    upload = UploadFile(
        filename="研究计划.docx",
        file=io.BytesIO(_docx_bytes()),
        headers=Headers({"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}),
    )

    response = await parse_attachments([upload], {"id": "test-user"})

    assert response["attachments"][0]["filename"] == "研究计划.docx"
    assert "研究背景" in response["attachments"][0]["text"]


@pytest.mark.asyncio
async def test_attachment_parse_route_rejects_oversized_file_before_parsing(monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ATTACHMENT_BYTES", 3)
    upload = UploadFile(filename="large.txt", file=io.BytesIO(b"four"))

    with pytest.raises(Exception) as error:
        await parse_attachments([upload], {"id": "test-user"})

    assert getattr(error.value, "status_code", None) == 413


@pytest.mark.asyncio
async def test_attachment_parse_route_enforces_aggregate_limit(monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ATTACHMENT_BYTES", 4)
    monkeypatch.setattr(attachments, "MAX_ATTACHMENT_TOTAL_BYTES", 5)
    uploads = [
        UploadFile(filename="one.txt", file=io.BytesIO(b"abc")),
        UploadFile(filename="two.txt", file=io.BytesIO(b"def")),
    ]

    with pytest.raises(Exception) as error:
        await parse_attachments(uploads, {"id": "test-user"})

    assert getattr(error.value, "status_code", None) == 413
