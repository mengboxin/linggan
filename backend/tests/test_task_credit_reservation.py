"""Focused regression coverage for task-scoped platform-credit reservations."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from core import credit_reserve


class FakeTaskReservationRedis:
    """Small locked Redis model for the two task-reservation Lua scripts."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.eval_calls: list[tuple[object, ...]] = []
        self.fail_release = False
        self._lock = asyncio.Lock()

    async def hgetall(self, key: str) -> dict[str, str]:
        # Yield so two release callers can both observe an active record before
        # their scripts race.  The script lock is the assertion under test.
        await asyncio.sleep(0)
        return dict(self.hashes.get(key, {}))

    async def eval(self, script: str, key_count: int, *args: str) -> int:
        self.eval_calls.append((script, key_count, *args))
        async with self._lock:
            if script == credit_reserve._RESERVE_FOR_TASK_LUA:
                return self._reserve(key_count, *args)
            if script == credit_reserve._RELEASE_TASK_RESERVATION_LUA:
                if self.fail_release:
                    raise RuntimeError("redis connection dropped")
                return self._release(key_count, *args)
        raise AssertionError("unexpected Lua script")

    def _reserve(self, key_count: int, *args: str) -> int:
        assert key_count == 2
        aggregate_key, task_key, user_id, raw_amount, raw_balance, _ttl = args
        amount = float(raw_amount)
        balance = float(raw_balance)
        record = self.hashes.get(task_key)
        if record:
            if (
                record.get("state") == "active"
                and record.get("user_id") == user_id
                and abs(float(record["amount"]) - amount) <= 0.000000001
            ):
                return 2
            return -1

        aggregate = float(self.values.get(aggregate_key, "0"))
        if aggregate + amount > balance + 0.000000001:
            return 0
        self.values[aggregate_key] = str(aggregate + amount)
        self.hashes[task_key] = {
            "user_id": user_id,
            "amount": str(amount),
            "state": "active",
        }
        return 1

    def _release(self, key_count: int, *args: str) -> int:
        assert key_count == 2
        task_key, aggregate_key, expected_user_id, _ttl = args
        record = self.hashes.get(task_key, {})
        if record.get("state") != "active":
            return 0
        if record.get("user_id") != expected_user_id:
            return -1

        amount = float(record["amount"])
        record["state"] = "released"
        aggregate = float(self.values.get(aggregate_key, "0"))
        if aggregate <= 0 or aggregate + 0.000000001 < amount:
            return 1
        if aggregate <= amount + 0.000000001:
            self.values.pop(aggregate_key, None)
            return 1
        self.values[aggregate_key] = str(aggregate - amount)
        return 1


def _use_platform_billing(monkeypatch: pytest.MonkeyPatch, redis: FakeTaskReservationRedis, balance: float) -> None:
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", AsyncMock(return_value=balance))
    monkeypatch.setattr(credit_reserve, "get_redis", lambda: redis)


@pytest.mark.asyncio
async def test_task_reservation_is_idempotent_and_does_not_over_reserve(monkeypatch):
    redis = FakeTaskReservationRedis()
    _use_platform_billing(monkeypatch, redis, balance=10)

    assert await credit_reserve.reserve_for_task("user-1", "task-1", 4) is True
    assert await credit_reserve.reserve_for_task("user-1", "task-1", 4) is True
    assert float(redis.values["credit_reserve:user-1"]) == 4

    # A different task sees the first task's held credits in the same atomic
    # aggregate and cannot claim more than the user's current balance.
    assert await credit_reserve.reserve_for_task("user-1", "task-2", 7) is False
    assert float(redis.values["credit_reserve:user-1"]) == 4

    # Rebinding an already-created task to a different quote is rejected.
    assert await credit_reserve.reserve_for_task("user-1", "task-1", 5) is False
    assert float(redis.values["credit_reserve:user-1"]) == 4


@pytest.mark.asyncio
async def test_concurrent_task_releases_decrement_the_aggregate_exactly_once(monkeypatch):
    redis = FakeTaskReservationRedis()
    _use_platform_billing(monkeypatch, redis, balance=10)
    assert await credit_reserve.reserve_for_task("user-1", "task-release", 3) is True

    first, second = await asyncio.gather(
        credit_reserve.release_task_reservation("task-release"),
        credit_reserve.release_task_reservation("task-release"),
    )

    assert sorted((first, second)) == [0.0, 3.0]
    assert "credit_reserve:user-1" not in redis.values
    assert redis.hashes["credit_reserve:task:task-release"]["state"] == "released"
    assert await credit_reserve.release_task_reservation("task-release") == 0.0


@pytest.mark.asyncio
async def test_release_never_deletes_a_smaller_unrelated_aggregate(monkeypatch):
    redis = FakeTaskReservationRedis()
    _use_platform_billing(monkeypatch, redis, balance=10)
    redis.values["credit_reserve:user-1"] = "1"
    redis.hashes["credit_reserve:task:task-stale"] = {
        "user_id": "user-1",
        "amount": "3",
        "state": "active",
    }

    assert await credit_reserve.release_task_reservation("task-stale") == 3
    assert float(redis.values["credit_reserve:user-1"]) == 1
    assert redis.hashes["credit_reserve:task:task-stale"]["state"] == "released"


@pytest.mark.asyncio
async def test_zero_and_external_task_reservations_are_noops(monkeypatch):
    redis = MagicMock()
    get_balance = AsyncMock()
    monkeypatch.setattr(credit_reserve, "get_redis", redis)
    monkeypatch.setattr(credit_reserve.credit_repo, "get_balance", get_balance)
    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=False),
    )

    assert await credit_reserve.reserve_for_task("user-1", "free-task", 0) is True
    get_balance.assert_not_awaited()
    redis.assert_not_called()

    monkeypatch.setattr(
        credit_reserve.foxapi_credentials,
        "uses_external_billing",
        AsyncMock(return_value=True),
    )
    assert await credit_reserve.reserve_for_task("user-1", "external-task", 9) is True
    get_balance.assert_not_awaited()
    redis.assert_not_called()


@pytest.mark.asyncio
async def test_task_reservation_fails_closed_when_redis_cannot_record_the_marker(monkeypatch):
    _use_platform_billing(monkeypatch, FakeTaskReservationRedis(), balance=10)
    monkeypatch.setattr(credit_reserve, "get_redis", MagicMock(side_effect=RuntimeError("down")))

    assert await credit_reserve.reserve_for_task("user-1", "task-redis-down", 2) is False


@pytest.mark.asyncio
async def test_release_raises_for_an_unknown_redis_result_so_the_outbox_retries(monkeypatch):
    redis = FakeTaskReservationRedis()
    _use_platform_billing(monkeypatch, redis, balance=10)
    assert await credit_reserve.reserve_for_task("user-1", "task-release-retry", 2) is True
    redis.fail_release = True

    with pytest.raises(credit_reserve.TaskReservationUnavailable, match="task-release-retry"):
        await credit_reserve.release_task_reservation("task-release-retry")

    assert redis.hashes["credit_reserve:task:task-release-retry"]["state"] == "active"
