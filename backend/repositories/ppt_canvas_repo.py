"""
PPT 画布幻灯片持久化仓库 —— Redis（实时读写）+ 乐观锁并发控制

Redis 键：
- ppt:slide:{job_id}:{index} → JSON（单张幻灯片数据）
- ppt:slides:{job_id} → set（该 job 所有 slide index 集合）
- ppt:slide:{job_id}:{index}:version → string（版本号，用于乐观锁）

设计原则：
- Redis 作为主存储，保证快速读写（R5.6 持久化）
- 乐观锁（version 字段）防止并发更新冲突
- 失败编辑不删除原始数据（R5.7 状态保留）

Requirements: R5.6, R5.7
"""
import json
import logging
from typing import Any, Optional

from core.redis import get_redis

logger = logging.getLogger(__name__)

# 幻灯片数据 TTL：7 天
_SLIDE_TTL = 7 * 24 * 3600


class ConcurrentUpdateError(Exception):
    """并发更新冲突异常：当前版本与预期版本不匹配"""

    def __init__(self, job_id: str, index: int, expected_version: int, actual_version: int):
        self.job_id = job_id
        self.index = index
        self.expected_version = expected_version
        self.actual_version = actual_version
        super().__init__(
            f"并发更新冲突: job_id={job_id}, index={index}, "
            f"expected_version={expected_version}, actual_version={actual_version}"
        )


def _slide_key(job_id: str, index: int) -> str:
    """单张幻灯片数据的 Redis key"""
    return f"ppt:slide:{job_id}:{index}"


def _version_key(job_id: str, index: int) -> str:
    """幻灯片版本号的 Redis key"""
    return f"ppt:slide:{job_id}:{index}:version"


def _index_set_key(job_id: str) -> str:
    """job 下所有 slide index 集合的 Redis key"""
    return f"ppt:slides:{job_id}"


async def save_slide(
    job_id: str,
    index: int,
    elements: list[dict[str, Any]],
    background: Optional[dict[str, Any]] = None,
) -> int:
    """保存/覆盖一张幻灯片数据

    参数:
        job_id: PPT 任务 ID
        index: 幻灯片序号（0-based）
        elements: 元素列表，每个元素包含 id, type, bbox, content, style 等
        background: 背景配置 {kind: 'solid'|'gradient'|'image', value: str}

    返回:
        新版本号

    注意:
        此操作为全量覆盖，不做版本检查（用于初始创建或全量保存）
    """
    r = get_redis()
    slide_data = {
        "job_id": job_id,
        "index": index,
        "elements": elements,
        "background": background,
    }

    slide_key = _slide_key(job_id, index)
    version_key = _version_key(job_id, index)
    index_set_key = _index_set_key(job_id)

    # 使用 pipeline 保证原子性
    pipe = r.pipeline()
    pipe.set(slide_key, json.dumps(slide_data), ex=_SLIDE_TTL)
    pipe.incr(version_key)
    pipe.expire(version_key, _SLIDE_TTL)
    pipe.sadd(index_set_key, str(index))
    pipe.expire(index_set_key, _SLIDE_TTL)
    results = await pipe.execute()

    # incr 返回新版本号（results[1]）
    new_version = int(results[1])
    logger.info(f"[ppt_canvas_repo] save_slide: job_id={job_id}, index={index}, version={new_version}")
    return new_version


async def get_slides(job_id: str) -> list[dict[str, Any]]:
    """获取指定 job 的所有幻灯片数据

    参数:
        job_id: PPT 任务 ID

    返回:
        按 index 排序的幻灯片列表，每项包含 job_id, index, elements, background, version
        如果 job 不存在或无幻灯片，返回空列表
    """
    r = get_redis()
    index_set_key = _index_set_key(job_id)

    # 获取所有 slide index
    indices = await r.smembers(index_set_key)
    if not indices:
        return []

    # 批量获取所有 slide 数据和版本号
    pipe = r.pipeline()
    sorted_indices = sorted(int(i) for i in indices)
    for idx in sorted_indices:
        pipe.get(_slide_key(job_id, idx))
        pipe.get(_version_key(job_id, idx))
    results = await pipe.execute()

    slides = []
    for i, idx in enumerate(sorted_indices):
        raw_data = results[i * 2]
        raw_version = results[i * 2 + 1]
        if raw_data:
            slide = json.loads(raw_data)
            slide["version"] = int(raw_version) if raw_version else 0
            slides.append(slide)

    return slides


async def get_slide(job_id: str, index: int) -> Optional[dict[str, Any]]:
    """获取单张幻灯片数据

    参数:
        job_id: PPT 任务 ID
        index: 幻灯片序号

    返回:
        幻灯片数据（含 version 字段），不存在时返回 None
    """
    r = get_redis()
    pipe = r.pipeline()
    pipe.get(_slide_key(job_id, index))
    pipe.get(_version_key(job_id, index))
    results = await pipe.execute()

    raw_data, raw_version = results[0], results[1]
    if not raw_data:
        return None

    slide = json.loads(raw_data)
    slide["version"] = int(raw_version) if raw_version else 0
    return slide


async def update_element(
    job_id: str,
    index: int,
    element_id: str,
    patch: dict[str, Any],
    expected_version: Optional[int] = None,
) -> int:
    """更新单个元素（乐观锁保护）

    参数:
        job_id: PPT 任务 ID
        index: 幻灯片序号
        element_id: 要更新的元素 ID
        patch: 要合并的字段（浅合并到目标元素）
        expected_version: 期望的当前版本号（乐观锁），为 None 时跳过版本检查

    返回:
        更新后的新版本号

    异常:
        ConcurrentUpdateError: 版本不匹配（并发冲突）
        ValueError: 幻灯片或元素不存在
    """
    r = get_redis()
    slide_key = _slide_key(job_id, index)
    version_key = _version_key(job_id, index)

    # 读取当前数据和版本
    pipe = r.pipeline()
    pipe.get(slide_key)
    pipe.get(version_key)
    results = await pipe.execute()

    raw_data, raw_version = results[0], results[1]
    if not raw_data:
        raise ValueError(f"幻灯片不存在: job_id={job_id}, index={index}")

    current_version = int(raw_version) if raw_version else 0

    # 乐观锁检查
    if expected_version is not None and current_version != expected_version:
        raise ConcurrentUpdateError(
            job_id=job_id,
            index=index,
            expected_version=expected_version,
            actual_version=current_version,
        )

    # 解析并更新元素
    slide = json.loads(raw_data)
    elements = slide.get("elements", [])

    # 查找目标元素
    target_idx = None
    for i, elem in enumerate(elements):
        if elem.get("id") == element_id:
            target_idx = i
            break

    if target_idx is None:
        raise ValueError(f"元素不存在: element_id={element_id}, job_id={job_id}, index={index}")

    # 浅合并 patch 到目标元素（R5.7: 失败不删除原始数据）
    original_element = elements[target_idx].copy()
    try:
        elements[target_idx].update(patch)
        slide["elements"] = elements

        # 使用 WATCH + MULTI 实现乐观锁写入
        # 简化实现：用 pipeline + version 递增
        # 如果在读取和写入之间有其他写入，version 会不匹配
        # 这里使用 Redis WATCH 机制确保原子性
        async with r.pipeline(transaction=True) as txn:
            await txn.watch(version_key)
            # 再次检查版本（WATCH 后读取）
            watched_version = await r.get(version_key)
            watched_version_int = int(watched_version) if watched_version else 0

            if expected_version is not None and watched_version_int != expected_version:
                raise ConcurrentUpdateError(
                    job_id=job_id,
                    index=index,
                    expected_version=expected_version,
                    actual_version=watched_version_int,
                )

            txn.multi()
            txn.set(slide_key, json.dumps(slide), ex=_SLIDE_TTL)
            txn.incr(version_key)
            txn.expire(version_key, _SLIDE_TTL)
            tx_results = await txn.execute()

        new_version = int(tx_results[1])
        logger.info(
            f"[ppt_canvas_repo] update_element: job_id={job_id}, index={index}, "
            f"element_id={element_id}, version={new_version}"
        )
        return new_version

    except ConcurrentUpdateError:
        raise
    except Exception as e:
        # R5.7: 失败时恢复原始元素数据
        elements[target_idx] = original_element
        logger.error(
            f"[ppt_canvas_repo] update_element 失败，已恢复原始数据: "
            f"job_id={job_id}, index={index}, element_id={element_id}, error={e}"
        )
        raise


async def delete_slide(job_id: str, index: int) -> bool:
    """删除单张幻灯片

    参数:
        job_id: PPT 任务 ID
        index: 幻灯片序号

    返回:
        是否成功删除（False 表示不存在）
    """
    r = get_redis()
    slide_key = _slide_key(job_id, index)
    version_key = _version_key(job_id, index)
    index_set_key = _index_set_key(job_id)

    pipe = r.pipeline()
    pipe.delete(slide_key)
    pipe.delete(version_key)
    pipe.srem(index_set_key, str(index))
    results = await pipe.execute()

    deleted = results[0] > 0
    if deleted:
        logger.info(f"[ppt_canvas_repo] delete_slide: job_id={job_id}, index={index}")
    return deleted


async def delete_all_slides(job_id: str) -> int:
    """删除指定 job 的所有幻灯片

    参数:
        job_id: PPT 任务 ID

    返回:
        删除的幻灯片数量
    """
    r = get_redis()
    index_set_key = _index_set_key(job_id)

    indices = await r.smembers(index_set_key)
    if not indices:
        return 0

    pipe = r.pipeline()
    for idx_str in indices:
        idx = int(idx_str)
        pipe.delete(_slide_key(job_id, idx))
        pipe.delete(_version_key(job_id, idx))
    pipe.delete(index_set_key)
    await pipe.execute()

    count = len(indices)
    logger.info(f"[ppt_canvas_repo] delete_all_slides: job_id={job_id}, count={count}")
    return count
