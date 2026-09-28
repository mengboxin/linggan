from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image


class PresentationRenderError(RuntimeError):
    pass


@dataclass(frozen=True)
class RenderedPresentationPage:
    data: bytes
    mime_type: str
    extension: str
    width: int
    height: int


def _find_office_binary() -> str | None:
    env_path = os.getenv("LIBREOFFICE_PATH") or os.getenv("SOFFICE_PATH")
    if env_path and Path(env_path).exists():
        return env_path

    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found

    candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
        "/opt/libreoffice/program/soffice",
    ]
    return next((item for item in candidates if Path(item).exists()), None)


def _convert_office_to_pdf(input_path: Path, output_dir: Path) -> Path:
    office = _find_office_binary()
    if not office:
        raise PresentationRenderError(
            "服务器未安装 LibreOffice/soffice，暂时无法把 PPT 转成演示预览。"
        )

    cmd = [
        office,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        str(output_dir),
        str(input_path),
    ]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(output_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise PresentationRenderError("PPT 转换超时，请尝试页数更少的文件。") from exc

    pdf_path = output_dir / f"{input_path.stem}.pdf"
    if result.returncode != 0 or not pdf_path.exists():
        detail = (result.stderr or result.stdout or "").strip()
        raise PresentationRenderError(
            f"PPT 转换失败{('：' + detail[:300]) if detail else '。'}"
        )
    return pdf_path


def _render_pdf_pages(pdf_path: Path, max_pages: int = 120) -> list[RenderedPresentationPage]:
    try:
        import pypdfium2 as pdfium
    except Exception as exc:  # pragma: no cover - depends on deployment image
        raise PresentationRenderError(
            "服务器缺少 pypdfium2，暂时无法把 PDF/PPT 渲染成演示页面。"
        ) from exc

    slides: list[RenderedPresentationPage] = []
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page_count = min(len(pdf), max_pages)
        for page_index in range(page_count):
            page = pdf[page_index]
            try:
                bitmap = page.render(scale=2.0)
                image = bitmap.to_pil().convert("RGB")
                image.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
                out = BytesIO()
                image.save(out, format="JPEG", quality=90, optimize=True)
                slides.append(RenderedPresentationPage(
                    data=out.getvalue(),
                    mime_type="image/jpeg",
                    extension=".jpg",
                    width=image.width,
                    height=image.height,
                ))
            finally:
                close = getattr(page, "close", None)
                if callable(close):
                    close()
    finally:
        close = getattr(pdf, "close", None)
        if callable(close):
            close()

    if not slides:
        raise PresentationRenderError("没有从文件中渲染出可演示页面。")
    return slides


def render_presentation_pages(file_path: str | Path) -> list[RenderedPresentationPage]:
    path = Path(file_path)
    ext = path.suffix.lower()
    if ext not in {".ppt", ".pptx", ".pdf"}:
        raise PresentationRenderError("仅支持 PPT、PPTX 或 PDF 文件。")

    with tempfile.TemporaryDirectory(prefix="ppt-present-") as tmp:
        work_dir = Path(tmp)
        source = work_dir / path.name
        shutil.copyfile(path, source)
        pdf_path = source if ext == ".pdf" else _convert_office_to_pdf(source, work_dir)
        return _render_pdf_pages(pdf_path)


def render_presentation_file(file_path: str | Path) -> list[str]:
    slides: list[str] = []
    for page in render_presentation_pages(file_path):
        encoded = base64.b64encode(page.data).decode("ascii")
        slides.append(f"data:{page.mime_type};base64,{encoded}")
    return slides
