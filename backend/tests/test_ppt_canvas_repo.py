"""
PPT 画布幻灯片仓库集成测试

覆盖场景：
- save_slide: 创建和覆盖幻灯片
- get_slides: 获取 job 下所有幻灯片（按 index 排序）
- get_slide: 获取单张幻灯片
- update_element: 更新单个元素（含乐观锁）
- 并发更新冲突检测（ConcurrentUpdateError）
- R5.7: 失败编辑不删除原始数据

Requirements: R5.6, R5.7
"""
import asyncio
import json
import os
import sys
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from repositories.ppt_canvas_repo import (
    ConcurrentUpdateError,
    _index_set_key,
    _slide_key,
    _version_key,
    delete_all_slides,
    delete_slide,
    get_slide,
    get_slides,
    save_slide,
    update_element,
)


# ─── 测试辅助 ─────────────────────────────────────────────────────────────────


def _make_elements(count: int = 3) -> list[dict]:
    """生成测试用元素列表"""
    elements = []
    for i in range(count):
        elements.append({
            "id": f"elem-{i}",
            "type": ["text", "icon", "image", "shape"][i % 4],
            "bbox": {"x": i * 100, "y": 0, "w": 200, "h": 100},
            "text": f"文本内容 {i}" if i % 4 == 0 else None,
            "src": f"https://example.com/img-{i}.png" if i % 4 == 2 else None,
        })
    return elements


def _make_background() -> dict:
    """生成测试用背景配置"""
    return {"kind": "solid", "value": "#1a1a2e"}


class FakeRedis:
    """模拟 Redis 客户端，用于单元测试"""

    def __init__(self):
        self._store: dict[str, str] = {}
        self._sets: dict[str, set] = {}
        self._ttls: dict[str, int] = {}

    async def get(self, key: str):
        return self._store.get(key)

    async def set(self, key: str, value: str, ex: int = None):
        self._store[key] = value
        if ex:
            self._ttls[key] = ex
        return True

    async def incr(self, key: str):
        current = int(self._store.get(key, "0"))
        new_val = current + 1
        self._store[key] = str(new_val)
        return new_val

    async def expire(self, key: str, ttl: int):
        self._ttls[key] = ttl
        return True

    async def delete(self, *keys: str):
        count = 0
        for key in keys:
            if key in self._store:
                del self._store[key]
                count += 1
            if key in self._sets:
                del self._sets[key]
                count += 1
        return count

    async def sadd(self, key: str, *members: str):
        if key not in self._sets:
            self._sets[key] = set()
        added = 0
        for m in members:
            if m not in self._sets[key]:
                self._sets[key].add(m)
                added += 1
        return added

    async def srem(self, key: str, *members: str):
        if key not in self._sets:
            return 0
        removed = 0
        for m in members:
            if m in self._sets[key]:
                self._sets[key].discard(m)
                removed += 1
        return removed

    async def smembers(self, key: str):
        return self._sets.get(key, set())

    async def watch(self, *keys):
        pass  # 模拟 WATCH（无实际锁定）

    def pipeline(self, transaction: bool = False):
        return FakePipeline(self, transaction=transaction)


class FakePipeline:
    """模拟 Redis pipeline"""

    def __init__(self, redis: FakeRedis, transaction: bool = False):
        self._redis = redis
        self._commands: list[tuple] = []
        self._transaction = transaction
        self._watching = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def watch(self, *keys):
        self._watching = True

    def multi(self):
        self._commands = []

    def set(self, key: str, value: str, ex: int = None):
        self._commands.append(("set", key, value, ex))

    def get(self, key: str):
        self._commands.append(("get", key))

    def incr(self, key: str):
        self._commands.append(("incr", key))

    def expire(self, key: str, ttl: int):
        self._commands.append(("expire", key, ttl))

    def sadd(self, key: str, *members: str):
        self._commands.append(("sadd", key, *members))

    def srem(self, key: str, *members: str):
        self._commands.append(("srem", key, *members))

    def delete(self, *keys: str):
        self._commands.append(("delete", *keys))

    async def execute(self):
        results = []
        for cmd in self._commands:
            op = cmd[0]
            if op == "set":
                _, key, value, ex = cmd
                await self._redis.set(key, value, ex=ex)
                results.append(True)
            elif op == "get":
                _, key = cmd
                results.append(await self._redis.get(key))
            elif op == "incr":
                _, key = cmd
                results.append(await self._redis.incr(key))
            elif op == "expire":
                _, key, ttl = cmd
                await self._redis.expire(key, ttl)
                results.append(True)
            elif op == "sadd":
                _, key, *members = cmd
                results.append(await self._redis.sadd(key, *members))
            elif op == "srem":
                _, key, *members = cmd
                results.append(await self._redis.srem(key, *members))
            elif op == "delete":
                _, *keys = cmd
                results.append(await self._redis.delete(*keys))
        return results


@pytest.fixture
def fake_redis():
    """提供一个 FakeRedis 实例并 patch get_redis"""
    redis = FakeRedis()
    with patch("repositories.ppt_canvas_repo.get_redis", return_value=redis):
        yield redis


# ─── save_slide 测试 ──────────────────────────────────────────────────────────


class TestSaveSlide:
    """测试 save_slide 创建和覆盖幻灯片"""

    def test_save_new_slide(self, fake_redis):
        """保存新幻灯片应返回版本号 1"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = _make_elements(2)
            background = _make_background()

            version = await save_slide(job_id, 0, elements, background)

            assert version == 1
            # 验证数据已存储
            raw = await fake_redis.get(_slide_key(job_id, 0))
            assert raw is not None
            data = json.loads(raw)
            assert data["job_id"] == job_id
            assert data["index"] == 0
            assert len(data["elements"]) == 2
            assert data["background"] == background

        asyncio.run(_run())

    def test_save_increments_version(self, fake_redis):
        """多次保存同一幻灯片应递增版本号"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = _make_elements(1)

            v1 = await save_slide(job_id, 0, elements)
            v2 = await save_slide(job_id, 0, elements)
            v3 = await save_slide(job_id, 0, elements)

            assert v1 == 1
            assert v2 == 2
            assert v3 == 3

        asyncio.run(_run())

    def test_save_multiple_slides(self, fake_redis):
        """保存多张幻灯片到同一 job"""
        async def _run():
            job_id = str(uuid.uuid4())

            await save_slide(job_id, 0, _make_elements(2))
            await save_slide(job_id, 1, _make_elements(3))
            await save_slide(job_id, 2, _make_elements(1))

            # 验证 index 集合
            indices = await fake_redis.smembers(_index_set_key(job_id))
            assert indices == {"0", "1", "2"}

        asyncio.run(_run())

    def test_save_with_none_background(self, fake_redis):
        """background 为 None 时正常保存"""
        async def _run():
            job_id = str(uuid.uuid4())
            version = await save_slide(job_id, 0, _make_elements(1), None)

            assert version == 1
            raw = await fake_redis.get(_slide_key(job_id, 0))
            data = json.loads(raw)
            assert data["background"] is None

        asyncio.run(_run())

    def test_save_overwrites_existing(self, fake_redis):
        """覆盖保存应更新数据"""
        async def _run():
            job_id = str(uuid.uuid4())
            old_elements = [{"id": "old-1", "type": "text", "bbox": {"x": 0, "y": 0, "w": 100, "h": 50}}]
            new_elements = [{"id": "new-1", "type": "image", "bbox": {"x": 10, "y": 10, "w": 200, "h": 100}}]

            await save_slide(job_id, 0, old_elements)
            await save_slide(job_id, 0, new_elements)

            raw = await fake_redis.get(_slide_key(job_id, 0))
            data = json.loads(raw)
            assert data["elements"][0]["id"] == "new-1"

        asyncio.run(_run())


# ─── get_slides 测试 ──────────────────────────────────────────────────────────


class TestGetSlides:
    """测试 get_slides 获取所有幻灯片"""

    def test_get_slides_empty_job(self, fake_redis):
        """不存在的 job 返回空列表"""
        async def _run():
            result = await get_slides("nonexistent-job")
            assert result == []

        asyncio.run(_run())

    def test_get_slides_returns_sorted(self, fake_redis):
        """返回结果按 index 排序"""
        async def _run():
            job_id = str(uuid.uuid4())

            # 乱序保存
            await save_slide(job_id, 2, [{"id": "e2", "type": "text"}])
            await save_slide(job_id, 0, [{"id": "e0", "type": "text"}])
            await save_slide(job_id, 1, [{"id": "e1", "type": "text"}])

            slides = await get_slides(job_id)

            assert len(slides) == 3
            assert slides[0]["index"] == 0
            assert slides[1]["index"] == 1
            assert slides[2]["index"] == 2

        asyncio.run(_run())

    def test_get_slides_includes_version(self, fake_redis):
        """返回结果包含 version 字段"""
        async def _run():
            job_id = str(uuid.uuid4())
            await save_slide(job_id, 0, _make_elements(1))
            await save_slide(job_id, 0, _make_elements(1))  # 版本 2

            slides = await get_slides(job_id)
            assert slides[0]["version"] == 2

        asyncio.run(_run())


# ─── get_slide 测试 ───────────────────────────────────────────────────────────


class TestGetSlide:
    """测试 get_slide 获取单张幻灯片"""

    def test_get_existing_slide(self, fake_redis):
        """获取已存在的幻灯片"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = _make_elements(2)
            bg = _make_background()
            await save_slide(job_id, 0, elements, bg)

            slide = await get_slide(job_id, 0)

            assert slide is not None
            assert slide["job_id"] == job_id
            assert slide["index"] == 0
            assert len(slide["elements"]) == 2
            assert slide["background"] == bg
            assert slide["version"] == 1

        asyncio.run(_run())

    def test_get_nonexistent_slide(self, fake_redis):
        """获取不存在的幻灯片返回 None"""
        async def _run():
            result = await get_slide("no-job", 99)
            assert result is None

        asyncio.run(_run())


# ─── update_element 测试 ──────────────────────────────────────────────────────


class TestUpdateElement:
    """测试 update_element 更新单个元素"""

    def test_update_element_success(self, fake_redis):
        """正常更新元素字段"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [
                {"id": "elem-1", "type": "text", "text": "原始文本", "bbox": {"x": 0, "y": 0, "w": 100, "h": 50}},
                {"id": "elem-2", "type": "icon", "src": "icon.png", "bbox": {"x": 100, "y": 0, "w": 50, "h": 50}},
            ]
            await save_slide(job_id, 0, elements)

            new_version = await update_element(
                job_id, 0, "elem-1",
                {"text": "更新后的文本", "color": "#ff0000"},
                expected_version=1,
            )

            assert new_version == 2
            # 验证更新后的数据
            slide = await get_slide(job_id, 0)
            elem = next(e for e in slide["elements"] if e["id"] == "elem-1")
            assert elem["text"] == "更新后的文本"
            assert elem["color"] == "#ff0000"
            # 其他字段保持不变
            assert elem["type"] == "text"
            assert elem["bbox"] == {"x": 0, "y": 0, "w": 100, "h": 50}

        asyncio.run(_run())

    def test_update_element_without_version_check(self, fake_redis):
        """不传 expected_version 时跳过版本检查"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [{"id": "elem-1", "type": "text", "text": "hello"}]
            await save_slide(job_id, 0, elements)

            new_version = await update_element(
                job_id, 0, "elem-1",
                {"text": "world"},
                expected_version=None,
            )

            assert new_version == 2

        asyncio.run(_run())

    def test_update_nonexistent_slide_raises(self, fake_redis):
        """更新不存在的幻灯片应抛出 ValueError"""
        async def _run():
            with pytest.raises(ValueError, match="幻灯片不存在"):
                await update_element("no-job", 0, "elem-1", {"text": "x"})

        asyncio.run(_run())

    def test_update_nonexistent_element_raises(self, fake_redis):
        """更新不存在的元素应抛出 ValueError"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [{"id": "elem-1", "type": "text"}]
            await save_slide(job_id, 0, elements)

            with pytest.raises(ValueError, match="元素不存在"):
                await update_element(job_id, 0, "nonexistent", {"text": "x"})

        asyncio.run(_run())

    def test_concurrent_update_conflict(self, fake_redis):
        """并发更新冲突应抛出 ConcurrentUpdateError"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [{"id": "elem-1", "type": "text", "text": "original"}]
            await save_slide(job_id, 0, elements)  # version = 1

            # 模拟另一个客户端先更新了（version 变为 2）
            await update_element(job_id, 0, "elem-1", {"text": "other update"}, expected_version=1)

            # 当前客户端仍持有 version=1，应冲突
            with pytest.raises(ConcurrentUpdateError) as exc_info:
                await update_element(job_id, 0, "elem-1", {"text": "my update"}, expected_version=1)

            err = exc_info.value
            assert err.job_id == job_id
            assert err.index == 0
            assert err.expected_version == 1
            assert err.actual_version == 2

        asyncio.run(_run())

    def test_update_preserves_other_elements(self, fake_redis):
        """更新一个元素不影响其他元素"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [
                {"id": "elem-1", "type": "text", "text": "first"},
                {"id": "elem-2", "type": "icon", "src": "icon.png"},
                {"id": "elem-3", "type": "image", "src": "photo.jpg"},
            ]
            await save_slide(job_id, 0, elements)

            await update_element(job_id, 0, "elem-2", {"src": "new-icon.png"}, expected_version=1)

            slide = await get_slide(job_id, 0)
            # elem-1 和 elem-3 不变
            assert slide["elements"][0]["text"] == "first"
            assert slide["elements"][2]["src"] == "photo.jpg"
            # elem-2 已更新
            assert slide["elements"][1]["src"] == "new-icon.png"

        asyncio.run(_run())


# ─── R5.7: 失败编辑不删除原始数据 ────────────────────────────────────────────


class TestStatePreservation:
    """R5.7: 验证失败编辑不会丢失原始数据"""

    def test_failed_update_preserves_original(self, fake_redis):
        """版本冲突后原始数据保持不变"""
        async def _run():
            job_id = str(uuid.uuid4())
            original_elements = [
                {"id": "elem-1", "type": "text", "text": "重要数据", "fontSize": 16},
            ]
            await save_slide(job_id, 0, original_elements)

            # 先更新一次（version 1 → 2）
            await update_element(job_id, 0, "elem-1", {"text": "已更新"}, expected_version=1)

            # 用旧版本号尝试更新（应失败）
            with pytest.raises(ConcurrentUpdateError):
                await update_element(job_id, 0, "elem-1", {"text": "冲突写入"}, expected_version=1)

            # 验证数据仍为上一次成功更新的结果
            slide = await get_slide(job_id, 0)
            assert slide["elements"][0]["text"] == "已更新"
            assert slide["elements"][0]["fontSize"] == 16

        asyncio.run(_run())

    def test_save_slide_is_atomic(self, fake_redis):
        """save_slide 操作是原子的，不会产生部分写入"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = _make_elements(5)
            bg = _make_background()

            version = await save_slide(job_id, 0, elements, bg)

            # 验证所有数据完整
            slide = await get_slide(job_id, 0)
            assert slide is not None
            assert len(slide["elements"]) == 5
            assert slide["background"] == bg
            assert slide["version"] == version

        asyncio.run(_run())


# ─── delete 测试 ──────────────────────────────────────────────────────────────


class TestDeleteSlide:
    """测试删除幻灯片"""

    def test_delete_existing_slide(self, fake_redis):
        """删除已存在的幻灯片"""
        async def _run():
            job_id = str(uuid.uuid4())
            await save_slide(job_id, 0, _make_elements(1))
            await save_slide(job_id, 1, _make_elements(1))

            result = await delete_slide(job_id, 0)

            assert result is True
            assert await get_slide(job_id, 0) is None
            # 另一张不受影响
            assert await get_slide(job_id, 1) is not None

        asyncio.run(_run())

    def test_delete_nonexistent_slide(self, fake_redis):
        """删除不存在的幻灯片返回 False"""
        async def _run():
            result = await delete_slide("no-job", 99)
            assert result is False

        asyncio.run(_run())

    def test_delete_all_slides(self, fake_redis):
        """删除 job 下所有幻灯片"""
        async def _run():
            job_id = str(uuid.uuid4())
            await save_slide(job_id, 0, _make_elements(1))
            await save_slide(job_id, 1, _make_elements(2))
            await save_slide(job_id, 2, _make_elements(3))

            count = await delete_all_slides(job_id)

            assert count == 3
            slides = await get_slides(job_id)
            assert slides == []

        asyncio.run(_run())

    def test_delete_all_empty_job(self, fake_redis):
        """删除空 job 返回 0"""
        async def _run():
            count = await delete_all_slides("empty-job")
            assert count == 0

        asyncio.run(_run())


# ─── 并发场景测试 ─────────────────────────────────────────────────────────────


class TestConcurrency:
    """测试并发更新场景"""

    def test_sequential_updates_increment_version(self, fake_redis):
        """顺序更新应正确递增版本号"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [{"id": "elem-1", "type": "text", "text": "v0"}]
            await save_slide(job_id, 0, elements)  # version 1

            v2 = await update_element(job_id, 0, "elem-1", {"text": "v1"}, expected_version=1)
            v3 = await update_element(job_id, 0, "elem-1", {"text": "v2"}, expected_version=v2)
            v4 = await update_element(job_id, 0, "elem-1", {"text": "v3"}, expected_version=v3)

            assert v2 == 2
            assert v3 == 3
            assert v4 == 4

            slide = await get_slide(job_id, 0)
            assert slide["elements"][0]["text"] == "v3"
            assert slide["version"] == 4

        asyncio.run(_run())

    def test_concurrent_update_error_attributes(self, fake_redis):
        """ConcurrentUpdateError 包含正确的诊断信息"""
        async def _run():
            job_id = str(uuid.uuid4())
            elements = [{"id": "elem-1", "type": "text", "text": "original"}]
            await save_slide(job_id, 0, elements)

            # 更新到 version 2
            await update_element(job_id, 0, "elem-1", {"text": "updated"}, expected_version=1)

            try:
                await update_element(job_id, 0, "elem-1", {"text": "conflict"}, expected_version=1)
                assert False, "应该抛出 ConcurrentUpdateError"
            except ConcurrentUpdateError as e:
                assert e.job_id == job_id
                assert e.index == 0
                assert e.expected_version == 1
                assert e.actual_version == 2
                assert "并发更新冲突" in str(e)

        asyncio.run(_run())

    def test_multiple_jobs_isolated(self, fake_redis):
        """不同 job 之间的数据完全隔离"""
        async def _run():
            job_a = str(uuid.uuid4())
            job_b = str(uuid.uuid4())

            await save_slide(job_a, 0, [{"id": "a-1", "type": "text"}])
            await save_slide(job_b, 0, [{"id": "b-1", "type": "icon"}])

            slide_a = await get_slide(job_a, 0)
            slide_b = await get_slide(job_b, 0)

            assert slide_a["elements"][0]["id"] == "a-1"
            assert slide_b["elements"][0]["id"] == "b-1"

            # 更新 job_a 不影响 job_b
            await update_element(job_a, 0, "a-1", {"text": "modified"}, expected_version=1)
            slide_b_after = await get_slide(job_b, 0)
            assert slide_b_after["elements"][0] == slide_b["elements"][0]

        asyncio.run(_run())
