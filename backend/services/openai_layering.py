"""OpenAI image-based layer separation.

The OpenAI Images API returns raster images, not native PSD documents. This
service uses the official image edit endpoint to produce transparent PNG layers
that the editor can import immediately and export as a layered ZIP.
"""
import base64
import uuid
from io import BytesIO

import httpx
from PIL import Image

from core.config import settings
import repositories.model_repo as model_repo
import repositories.task_repo as task_repo
from services.ai_client import call_image
from services.image_utils import pil_to_base64, to_png_bytes
from services.platform_provider_billing import execute_platform_provider_call


LAYER_SPECS = [
    {
        "key": "subject",
        "name": "AI 主体层",
        "prompt": "Extract the main subject as a clean transparent PNG layer. Preserve original pose, edges, colors, and details. Make all unrelated background fully transparent.",
    },
    {
        "key": "background",
        "name": "AI 背景层",
        "prompt": "Reconstruct only the background as a separate PNG layer. Remove the main subject and foreground objects naturally. Keep canvas size and perspective consistent.",
    },
    {
        "key": "foreground",
        "name": "AI 前景细节层",
        "prompt": "Extract foreground objects, decorative details, props, shadows, effects, and small elements as a transparent PNG layer. Exclude the main subject and background.",
    },
    {
        "key": "text",
        "name": "AI 文字/标识层",
        "prompt": "Extract visible text, logos, signs, UI labels, and graphic marks as a transparent PNG layer. If none exist, return a transparent image.",
    },
]


async def run_openai_layering(
    task_id: str,
    image_bytes: bytes,
    params: dict,
    user_id: str = "",
    billing_model_id: str = "",
):
    try:
        await task_repo.set_processing(task_id, 5)
        if not settings.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY 未配置，无法调用官方 GPT Image 分层能力")

        png_bytes, width, height = to_png_bytes(image_bytes)
        prompt = (params.get("prompt") or "").strip()
        max_layers = max(1, min(int(params.get("max_layers", 4)), len(LAYER_SPECS)))
        model_cfg = None
        provider_model_id = str(params.get("model_id") or settings.OPENAI_LAYER_IMAGE_MODEL)
        if provider_model_id:
            model_cfg = await model_repo.get_model_internal(provider_model_id)

        layers: list[dict] = []
        for index, spec in enumerate(LAYER_SPECS[:max_layers]):
            progress = 10 + int(index / max_layers * 75)
            await task_repo.set_progress(task_id, progress)
            model_id = billing_model_id or str(params.get("model_id") or "segmentation-openai-layer")
            layer_b64 = await execute_platform_provider_call(
                user_id=user_id,
                model_id=model_id,
                expected_category="segmentation",
                description=f"OpenAI image layer {index + 1}",
                related_task_id=None,
                reservation_task_id=task_id,
                idempotency_key=f"task:{task_id}:provider:{model_id}:layer:{index + 1}",
                invoke=lambda spec=spec: _call_openai_edit(
                    png_bytes,
                    spec["prompt"],
                    prompt,
                    model_cfg,
                ),
            )
            layer_b64 = _normalize_png_layer(layer_b64, width, height)
            layers.append({
                "id": str(uuid.uuid4()),
                "name": spec["name"],
                "type": spec["key"],
                "imageBase64": layer_b64,
                "visible": True,
                "opacity": 100,
                "bounds": {"x": 0, "y": 0, "width": width, "height": height},
            })

        await task_repo.set_progress(task_id, 92)
        layers.append({
            "id": str(uuid.uuid4()),
            "name": "原图参考层",
            "type": "source",
            "imageBase64": base64.b64encode(png_bytes).decode(),
            "visible": False,
            "opacity": 100,
            "bounds": {"x": 0, "y": 0, "width": width, "height": height},
        })

        await task_repo.set_completed(task_id, {
            "layers": layers,
            "model": _resolve_model_name(model_cfg),
            "format": "transparent-png-layers",
            "psdNote": "OpenAI Images API returns raster images. The app imports these as editable layers and can export them as ZIP.",
        })
    except Exception as e:
        print(f"[openai_layering] 任务 {task_id} 失败: {e}")
        await task_repo.set_failed(task_id, str(e))


async def _call_openai_edit(image_bytes: bytes, instruction: str, user_prompt: str, model_cfg: dict | None = None) -> str:
    prompt = (
        f"{instruction}\n\n"
        "Important: keep the same composition, output PNG with transparent background where applicable, "
        "do not add new objects, do not crop.\n"
        f"User creative context: {user_prompt or 'No extra prompt.'}"
    )
    model_id = model_cfg.get("id") if model_cfg else settings.OPENAI_LAYER_IMAGE_MODEL
    image = await call_image(
        model_id,
        prompt,
        ref_images=[image_bytes],
        size="1024x1024",
    )
    return base64.b64encode(image).decode()


def _normalize_png_layer(image_b64: str, width: int, height: int) -> str:
    raw = base64.b64decode(image_b64.split(",", 1)[-1])
    img = Image.open(BytesIO(raw)).convert("RGBA")
    if img.width != width or img.height != height:
        img = img.resize((width, height), Image.Resampling.LANCZOS)
    return pil_to_base64(img)


def _resolve_model_name(model_cfg: dict | None) -> str:
    if model_cfg:
        meta = model_cfg.get("meta") or {}
        return meta.get("model_name") or model_cfg.get("id") or settings.OPENAI_LAYER_IMAGE_MODEL
    return settings.OPENAI_LAYER_IMAGE_MODEL
