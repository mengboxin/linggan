"""
LayerEditAgent：边界感知图层编辑

工作流（4 步顺序执行）：
  1. 补全边界信息（从图像实际尺寸推断）
  2. 构建约束提示词
  3. 调用图像模型
  4. 验证并修正输出尺寸
"""
import base64
import logging
import time
from io import BytesIO
from typing import Optional

logger = logging.getLogger(__name__)


class LayerEditAgent:
    """边界感知图层编辑智能体"""

    async def run(
        self,
        image_bytes: bytes,
        prompt: str,
        bounds: dict,
        model_id: str,
    ) -> dict:
        t0 = time.time()
        result = await self._pipeline(image_bytes, prompt, bounds, model_id)
        logger.info(
            f"[LayerEditAgent] done: model_id={model_id} bounds={bounds} "
            f"duration={int((time.time()-t0)*1000)}ms"
        )
        return result

    async def _pipeline(
        self,
        image_bytes: bytes,
        prompt: str,
        bounds: dict,
        model_id: str,
    ) -> dict:
        from PIL import Image
        from services.layer_edit import _call_model_endpoint
        import repositories.model_repo as model_repo

        # ── 步骤 1：补全边界信息 ──────────────────────────────────────────
        try:
            img = Image.open(BytesIO(image_bytes))
            bounds = bounds.copy()
            if not bounds.get("width"):
                bounds["width"] = img.width
            if not bounds.get("height"):
                bounds["height"] = img.height
        except Exception as e:
            logger.warning(f"[LayerEditAgent] 读取图像尺寸失败: {e}")

        target_w = bounds.get("width", 0)
        target_h = bounds.get("height", 0)

        # ── 步骤 2：构建约束提示词 ────────────────────────────────────────
        constrained_prompt = (
            f"{prompt}, "
            f"constrained to {target_w}x{target_h} pixel area, "
            f"maintain original dimensions and position"
        )

        # ── 步骤 3：调用图像模型 ──────────────────────────────────────────
        try:
            img_rgba = Image.open(BytesIO(image_bytes)).convert("RGBA")
            model    = await model_repo.get_model_internal(model_id)
            params   = {"model_id": model_id, "prompt": constrained_prompt}
            result_img = await _call_model_endpoint(img_rgba, params, model)
        except Exception as e:
            logger.error(f"[LayerEditAgent] 模型调用失败: {e}")
            # 失败时返回原图
            return {
                "result":     base64.b64encode(image_bytes).decode(),
                "size_valid": False,
                "error":      str(e),
            }

        # ── 步骤 4：验证并修正输出尺寸 ────────────────────────────────────
        size_valid = True
        if target_w > 0 and target_h > 0:
            if result_img.width != target_w or result_img.height != target_h:
                size_valid = False
                logger.warning(
                    f"[LayerEditAgent] 尺寸不匹配: "
                    f"got {result_img.width}x{result_img.height}, "
                    f"expected {target_w}x{target_h}，自动 resize"
                )
                result_img = result_img.resize((target_w, target_h), Image.LANCZOS)

        buf = BytesIO()
        result_img.save(buf, format="PNG")
        result_b64 = base64.b64encode(buf.getvalue()).decode()

        return {"result": result_b64, "size_valid": size_valid}


# ── 向后兼容别名 ──────────────────────────────────────────────────────────────
LayerEditAgentGraph = LayerEditAgent
