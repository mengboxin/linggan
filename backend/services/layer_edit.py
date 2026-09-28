"""图层单独编辑业务逻辑"""
import os
import json
import base64
from io import BytesIO

import httpx
from PIL import Image

import repositories.task_repo as task_repo
from services.ai_client import call_image
from services import asset_storage


async def run_layer_edit(task_id: str, image_bytes: bytes, params: dict, user_id: str = ""):
    try:
        await task_repo.set_processing(task_id, 10)
        img = Image.open(BytesIO(image_bytes)).convert("RGBA")
        await task_repo.set_progress(task_id, 30)

        model_id = params.get("model_id", "")

        # 优先从数据库读取模型配置，根据 endpoint 和 category 决定调用方式
        import repositories.model_repo as model_repo
        model = await model_repo.get_model_internal(model_id)

        if model and model.get("endpoint") and model.get("api_key"):
            # 有完整配置，走通用 endpoint 调用
            result_img = await _call_model_endpoint(img, params, model)
        elif model_id.startswith("qwen") or model_id.startswith("wanx"):
            result_img = await _qwen_generate(img, params)
        elif model_id.startswith("sd") or model_id.startswith("stable"):
            result_img = await _sd_inpaint(img, params)
        else:
            raise ValueError(f"模型 {model_id!r} 未配置或不支持，请在管理后台配置模型的 endpoint 和 API Key")

        result_buffer = BytesIO()
        result_img.save(result_buffer, format="PNG")
        result_bytes = result_buffer.getvalue()
        stored_asset = None
        if user_id:
            stored_asset = await asset_storage.store_generated_image_best_effort(
                image_bytes=result_bytes,
                user_id=user_id,
                conversation_id=None,
                task_id=task_id,
                item_id="layer-edit-result",
                prompt=str(params.get("prompt") or "layer image edit"),
                model_id=model_id,
                category="image_edit",
            )
        image_base64 = "" if stored_asset else base64.b64encode(result_bytes).decode()
        await task_repo.set_completed(task_id, {
            "imageBase64": image_base64,
            "imageUrl": stored_asset.original_url if stored_asset else "",
            "previewUrl": stored_asset.preview_url if stored_asset else "",
            "thumbnailUrl": stored_asset.thumb_url if stored_asset else "",
            "assetId": stored_asset.id if stored_asset else "",
        })

    except Exception as e:
        import traceback
        err_msg = str(e) or repr(e) or "未知错误"
        print(f"[layer_edit] 任务 {task_id} 失败: {err_msg}")
        print(f"[layer_edit] 详细堆栈:\n{traceback.format_exc()}")
        await task_repo.set_failed(task_id, err_msg)


async def _qwen_generate(img: Image.Image, params: dict) -> Image.Image:
    """调用通义万象 / Qwen 图像生成 API"""
    import repositories.model_repo as model_repo

    model_id = params.get("model_id", "")
    # 用 internal 接口获取含 api_key 的完整模型信息
    model = await model_repo.get_model_internal(model_id)
    if not model:
        raise ValueError(f"模型 {model_id!r} 不存在或未启用")

    api_key = model.get("api_key") or os.getenv("DASHSCOPE_API_KEY", "")
    endpoint = model.get("endpoint", "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis")
    prompt = params.get("prompt", "high quality, detailed")

    # 将图像转为 base64
    buf = BytesIO()
    img.save(buf, format="PNG")
    img_b64 = base64.b64encode(buf.getvalue()).decode()

    payload = {
        "model": model.get("model_name", "wanx-v1"),
        "input": {
            "prompt": prompt,
            "base_image_url": f"data:image/png;base64,{img_b64}",
        },
        "parameters": {
            "size": "1024*1024",
            "n": 1,
            "strength": float(params.get("strength", 0.75)),
        }
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()

    # 解析返回的图像 URL
    output = data.get("output", {})
    results = output.get("results", [])
    if not results:
        raise ValueError(f"API 返回无结果: {data}")

    img_url = results[0].get("url", "")
    if not img_url:
        raise ValueError("API 未返回图像 URL")

    async with httpx.AsyncClient(timeout=30) as client:
        img_resp = await client.get(img_url)
        img_resp.raise_for_status()
        result_img = Image.open(BytesIO(img_resp.content)).convert("RGBA")

    return result_img


async def _sd_inpaint(img: Image.Image, params: dict) -> Image.Image:
    """调用 Replicate Stable Diffusion Inpainting"""
    import repositories.model_repo as model_repo

    model_id = params.get("model_id", "")
    # 用 internal 接口获取含 api_key 的完整模型信息
    model = await model_repo.get_model_internal(model_id)
    if not model:
        raise ValueError(f"模型 {model_id!r} 不存在")

    api_key = model.get("api_key") or os.getenv("REPLICATE_API_TOKEN", "")
    if not api_key:
        raise ValueError("未配置 Replicate API Token")

    prompt = params.get("prompt", "high quality, detailed")
    strength = float(params.get("strength", 0.75))

    buf = BytesIO()
    img.save(buf, format="PNG")
    img_b64 = base64.b64encode(buf.getvalue()).decode()

    # 创建全白蒙版（对整张图重绘）
    mask = Image.new("L", img.size, 255)
    mask_buf = BytesIO()
    mask.save(mask_buf, format="PNG")
    mask_b64 = base64.b64encode(mask_buf.getvalue()).decode()

    payload = {
        "version": "95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3",
        "input": {
            "image": f"data:image/png;base64,{img_b64}",
            "mask": f"data:image/png;base64,{mask_b64}",
            "prompt": prompt,
            "num_inference_steps": 25,
            "guidance_scale": 7.5,
            "strength": strength,
        }
    }

    async with httpx.AsyncClient(timeout=120) as client:
        # 提交预测
        resp = await client.post(
            "https://api.replicate.com/v1/predictions",
            headers={"Authorization": f"Token {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        prediction = resp.json()
        prediction_id = prediction["id"]

        # 轮询等待完成（最多 90 秒）
        import asyncio
        for _ in range(45):
            await asyncio.sleep(2)
            poll = await client.get(
                f"https://api.replicate.com/v1/predictions/{prediction_id}",
                headers={"Authorization": f"Token {api_key}"},
            )
            poll.raise_for_status()
            pred_data = poll.json()
            if pred_data["status"] == "succeeded":
                output_url = pred_data["output"][0] if isinstance(pred_data["output"], list) else pred_data["output"]
                img_resp = await client.get(output_url)
                return Image.open(BytesIO(img_resp.content)).convert("RGBA")
            elif pred_data["status"] == "failed":
                raise ValueError(f"Replicate 任务失败: {pred_data.get('error')}")

    raise ValueError("Replicate 任务超时")


async def _call_model_endpoint(img: Image.Image, params: dict, model: dict | None = None) -> Image.Image:
    """Call the configured generate model through the unified image path."""
    import repositories.model_repo as model_repo

    model_id = params.get("model_id", "")
    if model is None:
        model = await model_repo.get_model_internal(model_id)
        if not model:
            raise ValueError(f"Model {model_id!r} is missing or disabled")

    prompt = params.get("prompt", "high quality")
    buf = BytesIO()
    img.save(buf, format="PNG")
    result_bytes = await call_image(
        model_id or model.get("id", ""),
        prompt,
        ref_images=[buf.getvalue()],
        size="1024x1024",
    )
    return Image.open(BytesIO(result_bytes)).convert("RGBA")
