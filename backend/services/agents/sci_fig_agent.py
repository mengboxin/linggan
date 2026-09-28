"""
SciFigAgent — 科研绘图生成 Agent

两种模式：
1. 代码渲染：LLM 生成 Python/Mermaid 代码 → 沙箱执行 → 输出图表
2. AI 直接生成：图像模型直接生成科研风格图
"""
from __future__ import annotations

import asyncio
import base64
import functools
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from core.config import settings
from core.job_state_cache import BoundedJobStateCache
from services.agents.base import call_llm_chat
from services.agents.creative_runtime import sync_specialist_run
from services.ai_client import get_default_model_id
from services.job_events import publish_job_update

logger = logging.getLogger(__name__)

# ─── 并发控制 ──────────────────────────────────────────────────────────────────
MAX_ACTIVE_RENDERS = 3
_render_sem = asyncio.Semaphore(MAX_ACTIVE_RENDERS)

# ─── 状态存储（复用 ppt_agent 的 Redis + 内存模式）─────────────────────────────
_mem_store = BoundedJobStateCache(
    max_entries=settings.JOB_STATE_FALLBACK_CACHE_MAX_ENTRIES,
    ttl_seconds=settings.JOB_STATE_FALLBACK_CACHE_TTL_SECONDS,
    max_bytes=settings.JOB_STATE_FALLBACK_CACHE_MAX_BYTES,
)

SCI_FIG_WORK_DIR = Path("sci_fig_jobs")
SCI_FIG_WORK_DIR.mkdir(exist_ok=True)


async def _save_state(job_id: str, state: dict):
    try:
        from core.redis import get_redis
        r = get_redis()
        await r.set(f"sci_fig_job:{job_id}", json.dumps(state, ensure_ascii=False), ex=3600 * 24)
    except Exception as e:
        _mem_store[job_id] = state
        logger.warning(f"[SciFigAgent] Redis write failed: {e}")
    else:
        _mem_store.discard(job_id)
    await publish_job_update(
        state,
        job_type="sci-fig",
        job_id=job_id,
    )
    try:
        await sync_specialist_run(state, module="sci_fig")
    except Exception as exc:
        logger.warning("[SciFigAgent] top-level agent run sync failed: %s", exc)


async def _load_state(job_id: str) -> Optional[dict]:
    # In production the API and worker are separate processes. Redis must be
    # authoritative so the API event stream can expose worker-side updates.
    try:
        from core.redis import get_redis
        r = get_redis()
        raw = await r.get(f"sci_fig_job:{job_id}")
        if raw:
            state = json.loads(raw)
            _mem_store.discard(job_id)
            return state
    except Exception as e:
        logger.warning(f"[SciFigAgent] Redis read failed: {e}")
    return _mem_store.get(job_id)


# ─── 风格预设 ──────────────────────────────────────────────────────────────────
STYLE_PRESETS = {
    "auto": {
        "label": "AI 自适应",
        "description": "由 Agent 根据用户目标、附件内容、目标媒介和科研语境自动选择视觉风格。",
        "matplotlib_style": "Infer the best publication-ready scientific visual style from the user request and uploaded source materials.",
    },
    "nature": {
        "label": "Nature",
        "description": "Nature 期刊风格：白底、黑色坐标轴、克制配色、高对比度、少网格、图例和标签留白充足。",
        "matplotlib_style": "Use a Nature-like palette: clean white background, black axes, no heavy grid, concise typography, high contrast, ample whitespace, restrained colors.",
    },
    "ieee": {
        "label": "IEEE",
        "description": "IEEE 会议/期刊风格：黑白优先、线型/标记区分类别、适合双栏论文缩放后阅读。",
        "matplotlib_style": "Use IEEE style: mostly monochrome, distinguish series by line style and markers, compact layout, readable at two-column paper scale.",
    },
    "science": {
        "label": "Science",
        "description": "Science 期刊风格：信息密度高、结构清楚、颜色有层次、适合多面板科研叙事。",
        "matplotlib_style": "Use Science magazine style: compact but legible, layered color hierarchy, strong panel organization, clear annotations, professional high-density presentation.",
    },
    "cell": {
        "label": "Cell",
        "description": "Cell 期刊风格：现代彩色、生物医学友好、圆润清晰、强调机制和流程。",
        "matplotlib_style": "Use Cell style: modern biomedical colors, clean rounded visual elements when suitable, strong mechanism/process readability, polished presentation.",
    },
    "minimal": {
        "label": "极简论文",
        "description": "极简论文风格：减少装饰、保留核心数据、白底和细线条，适合正式报告。",
        "matplotlib_style": "Use minimalist paper style: remove decorative clutter, thin lines, white background, restrained neutral palette, emphasize the core data and labels.",
    },
    "mono": {
        "label": "黑白高对比",
        "description": "黑白高对比风格：适合打印，使用线型、纹理和标记区分信息。",
        "matplotlib_style": "Use high-contrast black-and-white style: print-safe, use line styles, hatching, markers, and grayscale hierarchy instead of color dependence.",
    },
    "medical": {
        "label": "医学插图",
        "description": "医学插图风格：柔和专业、蓝绿为主、标签清楚，适合实验流程和机制图。",
        "matplotlib_style": "Use medical illustration style: soft professional blue/green palette, clear labels, clean shapes, suitable for experimental workflows and mechanism diagrams.",
    },
    "custom": {
        "label": "自定义",
        "description": "不限制风格，根据用户描述自动选择最合适的科研视觉语言。",
        "matplotlib_style": "Choose the most suitable scientific visual style from the user's description and keep it publication-ready.",
    },
}

# ─── 图表类别 ──────────────────────────────────────────────────────────────────
CATEGORY_LABELS = {
    "auto": "AI 自适应",
    "data_chart": "数据图表",
    "flow_diagram": "流程/架构图",
    "network_diagram": "网络/模型架构图",
    "schematic": "示意图",
}


# ─── System Prompts ────────────────────────────────────────────────────────────

CODE_GEN_SYSTEM = """You are an expert scientific figure generator. You write Python matplotlib code or Mermaid diagram code to create publication-quality figures.

## Rules:
1. Output ONLY executable code. No explanations, no markdown fences, no comments outside code.
2. Do NOT include plt.savefig() or plt.show() - the system will handle saving automatically.
3. Use matplotlib.use('Agg') at the top.
4. Import numpy as np for data generation if needed.
5. For {style_desc} style: {style_instruction}
6. Make figures professional, high-contrast, and publication-ready.
7. Use English labels unless the user specifically requests Chinese.
8. Set figure size appropriately: plt.figure(figsize=(8, 6)) for standard, (10, 6) for wide, (6, 8) for tall.
9. Do NOT import os, sys, subprocess, socket, or any networking modules.
10. Do NOT use seaborn styles or any styles that require additional libraries - only use matplotlib built-in styles or set rcParams directly.
11. For Nature style: manually set rcParams for clean, high-contrast look (no grid, black axes, clean fonts).
"""


MERMAID_GEN_SYSTEM = """You are an expert at creating Mermaid diagram syntax for scientific papers.

## Rules:
1. Output ONLY the Mermaid diagram code. No explanations, no markdown fences.
2. Use clean, professional styling suitable for academic publications.
3. Use English labels unless the user specifically requests Chinese.
4. Keep diagrams simple and clear - avoid overly complex layouts.
5. For flowcharts use: flowchart TD (top-down) or flowchart LR (left-right).
6. For sequence diagrams use: sequenceDiagram.
7. For class diagrams use: classDiagram.
"""


FLOW_CHART_SYSTEM = """You are an expert at creating scientific flowcharts and architecture diagrams.

Output Python matplotlib code that draws a professional flowchart/architecture diagram.
Use matplotlib.patches (FancyBboxPatch, FancyArrowPatch) to create boxes and arrows.
Make it look like a professional paper figure with clean lines and clear labels.
"""


NETWORK_DIAGRAM_SYSTEM = """You are an expert at visualizing neural network architectures.

Output Python matplotlib code that draws a neural network / model architecture diagram.
Use matplotlib.patches to draw layers as boxes/rectangles, with arrows showing data flow.
Make it look like a professional paper figure (similar to PlotNeuralNet style but 2D).

## Rules:
1. Output ONLY executable code. No explanations, no markdown fences.
2. Do NOT include plt.savefig() or plt.show().
3. Use matplotlib.use('Agg') at the top.
4. Do NOT import os, sys, subprocess, socket, or any networking modules.
5. Do NOT use seaborn styles - only use matplotlib built-in styles or set rcParams directly.
6. For {style_desc} style: {style_instruction}
"""


SCHEMATIC_SYSTEM = """You are an expert at creating scientific schematic diagrams and relationship diagrams.

Output Python matplotlib code that draws a professional schematic/relationship diagram.
Use matplotlib.patches (FancyBboxPatch, FancyArrowPatch, Circle, Ellipse) to create shapes and connections.
Use matplotlib.lines for connecting lines and arrows.

## Rules:
1. Output ONLY executable code. No explanations, no markdown fences.
2. Do NOT include plt.savefig() or plt.show().
3. Use matplotlib.use('Agg') at the top.
4. Create clear, professional diagrams showing relationships between concepts/components.
5. Use boxes for entities, arrows for relationships, and labels for descriptions.
6. Use appropriate colors to distinguish different types of elements.
7. Set figure size appropriately for the diagram complexity.
8. Do NOT import os, sys, subprocess, socket, or any networking modules.
9. For {style_desc} style: {style_instruction}
10. This is a SCHEMATIC/RELATIONSHIP diagram, NOT a data chart. Do NOT generate bar charts, line plots, or scatter plots.
"""


# ─── 代码生成 ──────────────────────────────────────────────────────────────────

async def generate_code(
    description: str,
    category: str,
    style_preset: str = "custom",
    chart_params: Optional[dict] = None,
    llm_model_id: Optional[str] = None,
    attachment_context: str = "",
) -> str:
    """调用 LLM 生成绘图代码"""
    model_id = llm_model_id or await get_default_model_id("llm")
    if not model_id:
        raise RuntimeError("未配置 LLM 模型，请在管理后台添加 category=llm 的模型")

    import repositories.model_repo as model_repo
    model = await model_repo.get_model_internal(model_id)
    if not model:
        raise RuntimeError(f"LLM 模型 {model_id} 不存在")

    style_info = STYLE_PRESETS.get(style_preset, STYLE_PRESETS["custom"])
    style_desc = style_info["label"]
    style_instruction = style_info.get("matplotlib_style", "")

    # 根据类别选择不同的 system prompt
    if category == "flow_diagram":
        # 流程图优先用 Mermaid
        system = MERMAID_GEN_SYSTEM
    elif category == "network_diagram":
        system = NETWORK_DIAGRAM_SYSTEM.format(
            style_desc=style_desc,
            style_instruction=style_instruction or "Use professional, clean design with consistent colors.",
        )
    elif category == "schematic":
        system = SCHEMATIC_SYSTEM.format(
            style_desc=style_desc,
            style_instruction=style_instruction or "Use creative, clear visualization with distinct shapes and colors.",
        )
    else:
        system = CODE_GEN_SYSTEM.format(
            style_desc=style_desc,
            style_instruction=style_instruction or "Use standard scientific plotting conventions.",
        )

    # 构建 user message，明确包含类别信息
    category_label = CATEGORY_LABELS.get(category, "科研图表")
    user_msg = f"请生成以下【{category_label}】的代码：\n{description}"
    if chart_params:
        if chart_params.get("title"):
            user_msg += f"\n标题：{chart_params['title']}"
        if chart_params.get("x_label"):
            user_msg += f"\nX轴标签：{chart_params['x_label']}"
        if chart_params.get("y_label"):
            user_msg += f"\nY轴标签：{chart_params['y_label']}"
        if chart_params.get("csv_data"):
            user_msg += f"\n数据（CSV格式）：\n{chart_params['csv_data']}"
        if chart_params.get("mermaid_text"):
            user_msg += f"\nMermaid 语法：\n{chart_params['mermaid_text']}"
    if attachment_context.strip():
        user_msg += (
            "\n\n用户上传的实验数据/文档附件如下。请优先使用其中真实数据、变量、实验条件和结论；"
            "如果是表格数据，请直接基于数据绘图，不要编造数值：\n"
            f"{attachment_context[:60000]}"
        )

    code = await call_llm_chat(
        system=system,
        user=user_msg,
        model=model,
        max_tokens=2000,
        temperature=0.3,
    )

    # 清理代码：去掉 markdown fences
    code = code.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        # 去掉首尾的 ``` 行
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)

    return code


# ─── 代码执行（沙箱）──────────────────────────────────────────────────────────

async def execute_code(code: str, category: str = "data_chart") -> tuple[bytes, str]:
    """
    在子进程中执行 Python 代码，返回 (png_bytes, svg_bytes_or_empty)。
    如果是 Mermaid 类别，则调用 mmdc 渲染。
    """
    # Mermaid 类别：调用 Node.js mmdc
    if category == "flow_diagram" and not code.strip().startswith("import"):
        return await _render_mermaid(code)

    # Python matplotlib 代码执行
    return await _execute_matplotlib(code)


def _indent_code(code: str) -> str:
    """将代码缩进4空格，用于放入 try: 块"""
    lines = code.split('\n')
    return '\n'.join('    ' + line if line.strip() else '' for line in lines)


async def _execute_matplotlib(code: str) -> tuple[bytes, str]:
    """在子进程中执行 matplotlib 代码"""
    # 预检查：确保 matplotlib 可用
    try:
        check_result = await asyncio.wait_for(
            asyncio.to_thread(
                functools.partial(
                    subprocess.run,
                    [sys.executable, "-c", "import matplotlib; print(matplotlib.__version__)"],
                    capture_output=True,
                    timeout=10,
                )
            ),
            timeout=15,
        )
        if check_result.returncode != 0:
            err = check_result.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"matplotlib 未安装或不可用：{err}")
    except asyncio.TimeoutError:
        raise RuntimeError("检查 matplotlib 超时")
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"检查 matplotlib 失败：{e}")

    with tempfile.TemporaryDirectory(prefix="scifig_") as tmpdir:
        script_path = os.path.join(tmpdir, "render.py")
        output_png = os.path.join(tmpdir, "output.png")
        output_svg = os.path.join(tmpdir, "output.svg")

        # 构建安全脚本（Windows 路径需要用正斜杠或 raw string）
        # 注意：不使用 import 沙箱，matplotlib 依赖大量系统模块，拦截反而导致连锁失败
        safe_code = f"""
import sys
import warnings
warnings.filterwarnings('ignore')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

try:
{_indent_code(code)}

    # ── 确保保存 ──
    import matplotlib.pyplot as _plt
    _fignums = _plt.get_fignums()
    if _fignums:
        _plt.savefig(r'{output_png}', dpi=200, bbox_inches='tight', facecolor='white')
        try:
            _plt.savefig(r'{output_svg}', bbox_inches='tight', facecolor='white')
        except Exception:
            pass
        _plt.close('all')
    else:
        print("ERROR: No figure was created by the code", file=sys.stderr)
        sys.exit(1)
except Exception as _exc:
    import traceback
    traceback.print_exc()
    sys.exit(1)
"""
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(safe_code)

        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    functools.partial(
                        subprocess.run,
                        [sys.executable, script_path],
                        capture_output=True,
                        cwd=tmpdir,
                        timeout=25,
                    )
                ),
                timeout=30,
            )
            stdout = result.stdout
            stderr = result.stderr
            proc_returncode = result.returncode
        except asyncio.TimeoutError:
            raise RuntimeError("代码执行超时（30秒）")
        except Exception as e:
            err_detail = str(e) or type(e).__name__ or "未知子进程错误"
            raise RuntimeError(f"代码执行失败：{err_detail}")

        stdout_str = stdout.decode("utf-8", errors="replace").strip()
        stderr_str = stderr.decode("utf-8", errors="replace").strip()

        # 记录完整输出到日志
        logger.error(f"[SciFig] Return code: {proc_returncode}")
        logger.error(f"[SciFig] STDOUT: {stdout_str[:500]}")
        logger.error(f"[SciFig] STDERR: {stderr_str[:1000]}")

        if proc_returncode != 0:
            # 提取完整的错误信息
            err_msg = stderr_str or stdout_str
            if not err_msg:
                err_msg = f"未知错误（无 stderr/stdout），退出码: {proc_returncode}"
            raise RuntimeError(f"代码执行错误：\n{err_msg}")

        # 读取输出
        png_path = Path(output_png)
        if not png_path.exists():
            error_info = stderr_str or stdout_str or "无输出"
            raise RuntimeError(f"代码执行完成但未生成图像。输出：{error_info[:500]}")

        png_bytes = png_path.read_bytes()

        svg_bytes = ""
        svg_path = Path(output_svg)
        if svg_path.exists():
            svg_bytes = svg_path.read_bytes().decode("utf-8", errors="replace")

        return png_bytes, svg_bytes


async def _render_mermaid(mermaid_text: str) -> tuple[bytes, str]:
    """通过 Node.js mmdc 渲染 Mermaid 图"""
    with tempfile.TemporaryDirectory(prefix="scifig_mmd_") as tmpdir:
        input_file = os.path.join(tmpdir, "diagram.mmd")
        output_png = os.path.join(tmpdir, "output.png")
        output_svg = os.path.join(tmpdir, "output.svg")

        # 去掉可能的 markdown fences
        text = mermaid_text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines)

        with open(input_file, "w", encoding="utf-8") as f:
            f.write(text)

        # 尝试找 mmdc
        mmdc = shutil.which("mmdc")
        if not mmdc:
            # 尝试 npx
            mmdc = "npx"
            args = [mmdc, "-y", "@mermaid-js/mermaid-cli", "-i", input_file, "-o", output_png, "-b", "white"]
        else:
            args = [mmdc, "-i", input_file, "-o", output_png, "-b", "white"]

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("Mermaid 渲染超时")
        except FileNotFoundError:
            raise RuntimeError("未安装 Mermaid CLI，请运行: npm install -g @mermaid-js/mermaid-cli")

        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"Mermaid 渲染失败：{err}")

        png_path = Path(output_png)
        if not png_path.exists():
            raise RuntimeError("Mermaid 渲染完成但未生成图像")

        svg_args = args.copy()
        try:
            output_index = svg_args.index("-o") + 1
            svg_args[output_index] = output_svg
            svg_proc = await asyncio.create_subprocess_exec(
                *svg_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(svg_proc.communicate(), timeout=30)
        except Exception:
            logger.warning("[SciFig] Mermaid SVG render skipped", exc_info=True)

        png_bytes = png_path.read_bytes()
        svg_data = Path(output_svg).read_text(encoding="utf-8", errors="replace") if Path(output_svg).exists() else ""
        return png_bytes, svg_data


# ─── 代码修复 ──────────────────────────────────────────────────────────────────

async def fix_code(
    original_code: str,
    error: str,
    user_feedback: str = "",
    llm_model_id: Optional[str] = None,
) -> str:
    """当代码执行失败时，将错误信息反馈给 LLM 重新生成"""
    model_id = llm_model_id or await get_default_model_id("llm")
    if not model_id:
        raise RuntimeError("未配置 LLM 模型")

    import repositories.model_repo as model_repo
    model = await model_repo.get_model_internal(model_id)
    if not model:
        raise RuntimeError(f"LLM 模型 {model_id} 不存在")

    system = """You are a Python code fixer. The user's matplotlib/mermaid code failed.
Fix the code and return ONLY the corrected code. No explanations, no markdown fences.
Do NOT include plt.savefig() or plt.show() - the system handles saving automatically.
Do NOT use seaborn styles - only use matplotlib built-in styles or set rcParams directly.
Common fixes: missing imports, wrong API usage, encoding issues, style library unavailable."""

    user_msg = f"原始代码：\n```python\n{original_code}\n```\n\n错误信息：\n{error}"
    if user_feedback:
        user_msg += f"\n\n用户额外要求：{user_feedback}"

    code = await call_llm_chat(
        system=system,
        user=user_msg,
        model=model,
        max_tokens=2000,
        temperature=0.2,
    )

    code = code.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)

    return code


# ─── image2img 增强 ───────────────────────────────────────────────────────────

async def enhance_with_img2img(
    image_b64: str,
    model_id: str,
    prompt: str = "学术风格，高对比度，清晰的线条，Nature 期刊风格，高质量科研图表",
    strength: float = 0.3,
) -> str:
    """用图像模型对渲染结果做风格增强，返回 base64"""
    from services.ai_client import call_image

    model = None
    try:
        import repositories.model_repo as model_repo
        model = await model_repo.get_model_internal(model_id)
    except Exception:
        pass

    if not model:
        raise RuntimeError(f"图像模型 {model_id} 不存在或已禁用")

    # 将 base64 转为 bytes
    if image_b64.startswith("data:"):
        import base64 as b64
        image_bytes = b64.b64decode(image_b64.split(",", 1)[1])
    else:
        image_bytes = base64.b64decode(image_b64)

    result = await call_image(
        model_id=model_id,
        prompt=prompt,
        ref_images=[image_bytes],
        size="1024x1024",
    )
    return base64.b64encode(result).decode()


# ─── 格式转换 ──────────────────────────────────────────────────────────────────

async def convert_to_pdf(png_bytes: bytes) -> bytes:
    """PNG → PDF"""
    from PIL import Image
    import io

    img = Image.open(io.BytesIO(png_bytes))
    if img.mode == "RGBA":
        img = img.convert("RGB")

    pdf_bytes = io.BytesIO()
    img.save(pdf_bytes, format="PDF", resolution=200)
    return pdf_bytes.getvalue()


async def get_result_bytes(job_id: str, fmt: str) -> bytes:
    """获取指定格式的渲染结果"""
    state = await _load_state(job_id)
    if not state:
        raise RuntimeError("任务不存在或已过期")

    if fmt == "png":
        image_b64 = state["rendered_b64"]
        if image_b64.startswith("data:"):
            image_b64 = image_b64.split(",", 1)[1]
        return base64.b64decode(image_b64)
    elif fmt == "svg":
        svg = state.get("svg_data", "")
        if not svg:
            raise RuntimeError("该任务没有 SVG 数据")
        return svg.encode("utf-8")
    elif fmt == "pdf":
        image_b64 = state["rendered_b64"]
        if image_b64.startswith("data:"):
            image_b64 = image_b64.split(",", 1)[1]
        png_bytes = base64.b64decode(image_b64)
        return await convert_to_pdf(png_bytes)
    else:
        raise ValueError(f"不支持的格式：{fmt}")
