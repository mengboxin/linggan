"""
图层编辑 Agent 路由

- POST /api/layer-edit/agent-submit   边界感知图层编辑（调用 LayerEditAgentGraph）
"""
import logging
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from routers.auth import get_current_user
import repositories.model_repo as model_repo
from services.image_upload_validation import read_image_upload
from services.billing_operation import model_billing_operation_key
from services.model_billing import execute_billed_model_call

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/layer-edit", tags=["图层编辑 Agent"])


@router.post("/agent-submit")
async def agent_submit(
    image: UploadFile = File(..., description="图层图像文件"),
    prompt: str = Form(default="", description="编辑提示词"),
    model_id: str = Form(default="", description="模型 ID"),
    bounds_x: int = Form(default=0, description="图层边界 X"),
    bounds_y: int = Form(default=0, description="图层边界 Y"),
    bounds_width: int = Form(default=0, description="图层边界宽度"),
    bounds_height: int = Form(default=0, description="图层边界高度"),
    client_request_id: str = Form(default=""),
    user: dict = Depends(get_current_user),
):
    """
    边界感知图层编辑。
    使用 LayerEditAgentGraph 执行：
    extract_bounds → build_constrained_prompt → call_model → validate_output_size → output
    """
    image_bytes = await read_image_upload(image, label="图层图像")

    bounds = {
        "x": bounds_x,
        "y": bounds_y,
        "width": bounds_width,
        "height": bounds_height,
    }

    logger.info(
        f"[layer_edit_agent] submit: user_id={user['id']} "
        f"model_id={model_id} bounds={bounds} "
        f"prompt={prompt[:50]!r}"
    )

    model = await model_repo.get_model(model_id) if model_id else None
    if not model:
        raise HTTPException(status_code=404, detail="请选择可用的图层编辑模型")

    async def invoke_edit() -> dict:
        try:
            from services.agents import LayerEditAgent
            result = await LayerEditAgent().run(
                image_bytes=image_bytes,
                prompt=prompt,
                bounds=bounds,
                model_id=model_id,
            )
        except ImportError:
            logger.warning("[layer_edit_agent] langgraph not available, using direct call")
            result = await _direct_call(image_bytes, prompt, bounds, model_id)

        # The legacy graph preserves the source image when the provider fails.
        # That fallback is useful for recovery but is not a successful model
        # result and must never reach the debit step.
        if result.get("error"):
            raise RuntimeError(str(result["error"]))
        if not result.get("result"):
            raise RuntimeError("图层编辑模型未返回结果图像")
        return result

    try:
        request_scope = client_request_id if isinstance(client_request_id, str) else ""
        result = await execute_billed_model_call(
            user_id=str(user["id"]),
            model_id=model_id,
            expected_category="generate",
            description=f"图层 AI 处理 · {model.get('name', model_id)}",
            idempotency_key=model_billing_operation_key(
                namespace="layer-edit-agent",
                user_id=str(user["id"]),
                operation_scope=request_scope,
                material={
                    "model_id": model_id,
                    "prompt": prompt,
                    "bounds": bounds,
                    "image": image_bytes,
                },
            ),
            invoke=invoke_edit,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[layer_edit_agent] failed: {e}")
        raise HTTPException(status_code=502, detail=f"图层编辑失败：{str(e)}") from e

    return {
        "result": result["result"],
        "imageBase64": result["result"],  # 兼容旧字段名
        "size_valid": result.get("size_valid", True),
        "bounds": bounds,
    }


async def _direct_call(
    image_bytes: bytes,
    prompt: str,
    bounds: dict,
    model_id: str,
) -> dict:
    """直接调用模型 endpoint（不经过 LangGraph）"""
    from io import BytesIO
    import base64
    from PIL import Image
    from services.layer_edit import _call_model_endpoint
    import repositories.model_repo as model_repo

    img = Image.open(BytesIO(image_bytes)).convert("RGBA")
    target_w = bounds.get("width") or img.width
    target_h = bounds.get("height") or img.height

    constrained_prompt = (
        f"{prompt}, constrained to {target_w}x{target_h} pixel area, "
        f"maintain original dimensions"
    )

    model = await model_repo.get_model_internal(model_id) if model_id else None
    params = {"model_id": model_id, "prompt": constrained_prompt}
    result_img = await _call_model_endpoint(img, params, model)

    if result_img.width != target_w or result_img.height != target_h:
        result_img = result_img.resize((target_w, target_h), Image.LANCZOS)

    buf = BytesIO()
    result_img.save(buf, format="PNG")
    result_base64 = base64.b64encode(buf.getvalue()).decode()

    return {
        "result": result_base64,
        "imageBase64": result_base64,
        "size_valid": True,
        "bounds": bounds,
    }
