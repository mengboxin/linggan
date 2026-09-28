"""
增强版批处理路由
支持参数模板、队列管理、批量编辑等功能
"""
import os
import json
import uuid
import asyncio
from datetime import datetime
from typing import List, Dict, Optional, Any, Literal
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse

from models.schemas import TaskStatusResponse
import repositories.task_repo as task_repo
from services.segmentation import run_segmentation
from core.config import settings

router = APIRouter(prefix="/api/batch-enhanced", tags=["增强批处理"])

# ─── 数据模型 ─────────────────────────────────────────────────────────────

class BatchItem(BaseModel):
    id: str
    name: str
    path: str
    status: Literal["pending", "processing", "completed", "failed", "skipped"] = "pending"
    progress: float = 0.0
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

class BatchTemplate(BaseModel):
    id: str
    name: str
    description: str
    settings: Dict[str, Any]
    created_at: datetime
    created_by: str
    is_public: bool = False

class BatchJob(BaseModel):
    id: str
    name: str
    items: List[BatchItem]
    template_id: Optional[str] = None
    status: Literal["created", "running", "paused", "completed", "failed"] = "created"
    total_items: int
    completed_items: int = 0
    failed_items: int = 0
    current_item_index: int = 0
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    settings: Dict[str, Any] = {}

# ─── 批处理队列管理器 ─────────────────────────────────────────────────────

class BatchQueueManager:
    def __init__(self, max_concurrent: int = 3):
        self.max_concurrent = max_concurrent
        self.running_jobs: Dict[str, BatchJob] = {}
        self.completed_jobs: Dict[str, BatchJob] = {}
        self.job_queue: List[str] = []
        self.currently_running = 0

    async def add_job(self, job: BatchJob) -> str:
        job_id = job.id
        self.running_jobs[job_id] = job
        self.job_queue.append(job_id)
        await self._process_next()
        return job_id

    async def _process_next(self):
        if self.currently_running >= self.max_concurrent:
            return

        if not self.job_queue:
            return

        job_id = self.job_queue.pop(0)
        job = self.running_jobs.get(job_id)
        if not job or job.status != "created":
            return

        job.status = "running"
        job.start_time = datetime.now()
        self.currently_running += 1

        # 处理作业
        asyncio.create_task(self._process_job(job_id))

    async def _process_job(self, job_id: str):
        job = self.running_jobs.get(job_id)
        if not job:
            return

        try:
            for i, item in enumerate(job.items):
                if item.status == "completed":
                    continue

                job.current_item_index = i
                item.status = "processing"
                item.started_at = datetime.now()
                item.progress = 0.0

                # 处理单个项目
                try:
                    result = await self._process_item(item, job.settings)
                    item.result = result
                    item.status = "completed"
                    item.completed_at = datetime.now()
                    job.completed_items += 1
                except Exception as e:
                    item.status = "failed"
                    item.error = str(e)
                    item.completed_at = datetime.now()
                    job.failed_items += 1

                # 更新进度
                item.progress = 100.0
                await self._update_job_progress(job_id)

            # 所有项目完成
            job.status = "completed"
            job.end_time = datetime.now()
            self.completed_jobs[job_id] = job
            del self.running_jobs[job_id]
            self.currently_running -= 1

        except Exception as e:
            job.status = "failed"
            job.end_time = datetime.now()
            self.completed_jobs[job_id] = job
            del self.running_jobs[job_id]
            self.currently_running -= 1

        # 处理下一个作业
        await self._process_next()

    async def _process_item(self, item: BatchItem, settings: Dict[str, Any]) -> Dict[str, Any]:
        # 这里实现具体的批处理逻辑
        # 示例：AI分割
        await run_segmentation(
            task_id=item.id,
            image_path=item.path,
            params=settings
        )
        return {"layers": []}  # 实际应该返回处理结果

    async def _update_job_progress(self, job_id: str):
        job = self.running_jobs.get(job_id)
        if not job:
            return

        # 更新任务状态（可以发送到Redis或数据库）
        pass

    def get_job(self, job_id: str) -> Optional[BatchJob]:
        return self.running_jobs.get(job_id) or self.completed_jobs.get(job_id)

    def get_all_jobs(self) -> Dict[str, BatchJob]:
        return {**self.running_jobs, **self.completed_jobs}

    def pause_job(self, job_id: str) -> bool:
        job = self.running_jobs.get(job_id)
        if job and job.status == "running":
            job.status = "paused"
            return True
        return False

    def resume_job(self, job_id: str) -> bool:
        job = self.running_jobs.get(job_id)
        if job and job.status == "paused":
            job.status = "running"
            return True
        return False

    def cancel_job(self, job_id: str) -> bool:
        job = self.running_jobs.get(job_id)
        if job:
            job.status = "failed"
            del self.running_jobs[job_id]
            self.currently_running -= 1
            return True
        return False

    def cleanup_old_jobs(self, days: int = 7):
        cutoff = datetime.now() - timedelta(days=days)
        to_remove = []

        for job_id, job in self.completed_jobs.items():
            if job.end_time and job.end_time < cutoff:
                to_remove.append(job_id)

        for job_id in to_remove:
            del self.completed_jobs[job_id]

# 全局队列管理器
batch_queue = BatchQueueManager()

# ─── 批处理模板 ─────────────────────────────────────────────────────────────

class TemplateManager:
    def __init__(self):
        self.templates: Dict[str, BatchTemplate] = {
            "quick-segment": BatchTemplate(
                id="quick-segment",
                name="快速分割",
                description="使用默认参数进行快速AI分割",
                settings={
                    "num_layers": 5,
                    "guidance_scale": 4.0,
                    "num_inference_steps": 30,
                    "cfg_normalization": True,
                    "auto_caption_en": True,
                },
                created_at=datetime.now(),
                created_by="system",
                is_public=True
            ),
            "high-quality": BatchTemplate(
                id="high-quality",
                name="高质量分割",
                description="使用高质量参数进行精细分割",
                settings={
                    "num_layers": 10,
                    "guidance_scale": 5.0,
                    "num_inference_steps": 50,
                    "cfg_normalization": True,
                    "auto_caption_en": True,
                },
                created_at=datetime.now(),
                created_by="system",
                is_public=True
            ),
            "custom": BatchTemplate(
                id="custom",
                name="自定义参数",
                description="使用自定义参数进行分割",
                settings={
                    "num_layers": 8,
                    "guidance_scale": 4.0,
                    "num_inference_steps": 40,
                    "cfg_normalization": True,
                    "auto_caption_en": False,
                },
                created_at=datetime.now(),
                created_by="system",
                is_public=True
            )
        }

    def get_template(self, template_id: str) -> Optional[BatchTemplate]:
        return self.templates.get(template_id)

    def get_all_templates(self) -> List[BatchTemplate]:
        return list(self.templates.values())

    def create_template(self, template: BatchTemplate) -> str:
        template_id = template.id
        self.templates[template_id] = template
        return template_id

    def update_template(self, template_id: str, template: BatchTemplate) -> bool:
        if template_id in self.templates:
            self.templates[template_id] = template
            return True
        return False

    def delete_template(self, template_id: str) -> bool:
        if template_id in self.templates:
            del self.templates[template_id]
            return True
        return False

# 全局模板管理器
template_manager = TemplateManager()

# ─── 路由 ──────────────────────────────────────────────────────────────────

@router.post("/submit")
async def submit_batch_job(
    background_tasks: BackgroundTasks,
    name: str = Form(...),
    folder_path: str = Form(...),
    template_id: Optional[str] = Form(None),
    settings: Optional[str] = Form(None),
):
    """提交新的批处理任务"""

    # 解析设置
    job_settings = {}
    if template_id:
        template = template_manager.get_template(template_id)
        if template:
            job_settings = template.settings

    if settings:
        try:
            custom_settings = json.loads(settings)
            job_settings.update(custom_settings)
        except json.JSONDecodeError:
            raise HTTPException(400, "无效的设置JSON")

    # 扫描文件夹
    items = []
    try:
        for file_path in Path(folder_path).glob("*"):
            if file_path.is_file() and file_path.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp']:
                item = BatchItem(
                    id=str(uuid.uuid4()),
                    name=file_path.name,
                    path=str(file_path),
                    status="pending"
                )
                items.append(item)
    except Exception as e:
        raise HTTPException(400, f"扫描文件夹失败: {str(e)}")

    if not items:
        raise HTTPException(400, "未找到支持的图片文件")

    # 创建批处理任务
    job = BatchJob(
        id=str(uuid.uuid4()),
        name=name,
        items=items,
        template_id=template_id,
        status="created",
        total_items=len(items),
        settings=job_settings
    )

    # 添加到队列
    job_id = await batch_queue.add_job(job)
    return {"job_id": job_id, "total_items": len(items)}

@router.get("/status/{job_id}")
async def get_batch_status(job_id: str):
    """获取批处理任务状态"""
    job = batch_queue.get_job(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")

    return {
        "job_id": job_id,
        "status": job.status,
        "total_items": job.total_items,
        "completed_items": job.completed_items,
        "failed_items": job.failed_items,
        "progress": (job.completed_items / job.total_items * 100) if job.total_items > 0 else 0,
        "current_item": job.items[job.current_item_index] if job.current_item_index < len(job.items) else None,
        "start_time": job.start_time,
        "end_time": job.end_time,
    }

@router.get("/job/{job_id}/items")
async def get_batch_items(job_id: str):
    """获取批处理任务的所有项目"""
    job = batch_queue.get_job(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")

    return {"items": job.items}

@router.post("/job/{job_id}/pause")
async def pause_batch_job(job_id: str):
    """暂停批处理任务"""
    if not batch_queue.pause_job(job_id):
        raise HTTPException(400, "无法暂停任务")
    return {"ok": True}

@router.post("/job/{job_id}/resume")
async def resume_batch_job(job_id: str):
    """恢复批处理任务"""
    if not batch_queue.resume_job(job_id):
        raise HTTPException(400, "无法恢复任务")
    return {"ok": True}

@router.post("/job/{job_id}/cancel")
async def cancel_batch_job(job_id: str):
    """取消批处理任务"""
    if not batch_queue.cancel_job(job_id):
        raise HTTPException(400, "无法取消任务")
    return {"ok": True}

@router.get("/job/{job_id}/download")
async def download_batch_results(job_id: str):
    """下载批处理结果"""
    job = batch_queue.get_job(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")

    if job.status != "completed":
        raise HTTPException(400, "任务未完成")

    # 创建ZIP文件
    import io
    from zipfile import ZipFile

    zip_buffer = io.BytesIO()
    with ZipFile(zip_buffer, 'w') as zipf:
        for item in job.items:
            if item.status == "completed" and item.result:
                # 这里应该将实际结果添加到ZIP
                # 示例：添加处理后的图像
                pass

    zip_buffer.seek(0)

    return StreamingResponse(
        io.BytesIO(zip_buffer.getvalue()),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={job_id}.zip"}
    )

@router.get("/templates")
async def get_batch_templates():
    """获取所有批处理模板"""
    return {"templates": template_manager.get_all_templates()}

@router.post("/templates")
async def create_batch_template(template: BatchTemplate):
    """创建新的批处理模板"""
    template_id = template_manager.create_template(template)
    return {"template_id": template_id}

@router.put("/templates/{template_id}")
async def update_batch_template(template_id: str, template: BatchTemplate):
    """更新批处理模板"""
    if not template_manager.update_template(template_id, template):
        raise HTTPException(404, "模板不存在")
    return {"ok": True}

@router.delete("/templates/{template_id}")
async def delete_batch_template(template_id: str):
    """删除批处理模板"""
    if not template_manager.delete_template(template_id):
        raise HTTPException(404, "模板不存在")
    return {"ok": True}

@router.get("/queue")
async def get_batch_queue():
    """获取批处理队列状态"""
    return {
        "running_jobs": len(batch_queue.running_jobs),
        "completed_jobs": len(batch_queue.completed_jobs),
        "queued_jobs": len(batch_queue.job_queue),
        "max_concurrent": batch_queue.max_concurrent,
        "currently_running": batch_queue.currently_running,
        "jobs": batch_queue.get_all_jobs()
    }

@router.get("/stats")
async def get_batch_stats():
    """获取批处理统计信息"""
    jobs = batch_queue.get_all_jobs()

    total_jobs = len(jobs)
    completed_jobs = sum(1 for j in jobs.values() if j.status == "completed")
    failed_jobs = sum(1 for j in jobs.values() if j.status == "failed")
    total_items = sum(j.total_items for j in jobs.values())
    processed_items = sum(j.completed_items + j.failed_items for j in jobs.values())

    return {
        "total_jobs": total_jobs,
        "completed_jobs": completed_jobs,
        "failed_jobs": failed_jobs,
        "total_items": total_items,
        "processed_items": processed_items,
        "success_rate": (completed_jobs / total_jobs * 100) if total_jobs > 0 else 0,
        "item_success_rate": ((processed_items - failed_jobs) / total_items * 100) if total_items > 0 else 0,
    }

@router.post("/cleanup")
async def cleanup_old_jobs(days: int = 7):
    """清理旧的批处理任务"""
    batch_queue.cleanup_old_jobs(days)
    return {"ok": True, "days": days}