import pytest

from services.agents import agent_run_store


class FakeRedis:
    def __init__(self):
        self.values: dict[str, str] = {}

    async def get(self, key: str):
        return self.values.get(key)

    async def set(self, key: str, value: str, ex: int):
        self.values[key] = value


@pytest.mark.asyncio
async def test_confirmed_run_rejects_a_changed_workflow_snapshot(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(agent_run_store, "get_redis", lambda: fake_redis)
    run = await agent_run_store.create_run(
        user_id="user-1",
        state={
            "snapshot_fingerprint": "snapshot-a",
            "workflow_snapshot": {"source_node_id": "node-1"},
            "plan": {"summary": "编辑源图"},
        },
    )

    with pytest.raises(agent_run_store.AgentRunTransitionError, match="工作流已变化"):
        await agent_run_store.confirm_run(
            run["run_id"],
            user_id="user-1",
            answers={},
            snapshot_fingerprint="snapshot-b",
        )

    confirmed = await agent_run_store.confirm_run(
        run["run_id"],
        user_id="user-1",
        answers={"reference-priority": "style"},
        snapshot_fingerprint="snapshot-a",
    )

    assert confirmed["status"] == "confirmed"
    assert confirmed["answers"] == {"reference-priority": "style"}
    assert [item["stage"] for item in confirmed["timeline"]][-1] == "user_confirmed"


@pytest.mark.asyncio
async def test_terminal_run_cannot_be_reopened(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(agent_run_store, "get_redis", lambda: fake_redis)
    run = await agent_run_store.create_run(user_id="user-1", state={})
    await agent_run_store.transition_run(
        run["run_id"],
        user_id="user-1",
        status="completed",
        stage="delivery",
        message="已交付",
    )

    with pytest.raises(agent_run_store.AgentRunTransitionError, match="already completed"):
        await agent_run_store.transition_run(
            run["run_id"],
            user_id="user-1",
            status="executing",
            stage="execution_started",
            message="不应重新执行",
        )


@pytest.mark.asyncio
async def test_paused_run_can_return_to_queue_after_user_continues(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(agent_run_store, "get_redis", lambda: fake_redis)
    run = await agent_run_store.create_run(user_id="user-1", state={"module": "ppt"})
    await agent_run_store.transition_run(
        run["run_id"],
        user_id="user-1",
        status="paused_budget",
        stage="budget_paused",
        message="budget unavailable",
    )

    resumed = await agent_run_store.resume_run(run["run_id"], user_id="user-1")

    assert resumed["status"] == "queued"
    assert resumed["timeline"][-1]["stage"] == "resume_requested"


@pytest.mark.asyncio
async def test_chat_note_preserves_the_current_lifecycle_state(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(agent_run_store, "get_redis", lambda: fake_redis)
    run = await agent_run_store.create_run(user_id="user-1", state={"module": "ppt"})
    await agent_run_store.transition_run(
        run["run_id"],
        user_id="user-1",
        status="paused_budget",
        stage="budget_paused",
        message="积分不足",
    )

    noted = await agent_run_store.append_run_note(
        run["run_id"],
        user_id="user-1",
        stage="chat_command",
        message="我会保留已完成内容，只继续尚未完成的步骤。",
        last_command={"kind": "continue_paused_run"},
    )

    assert noted["status"] == "paused_budget"
    assert noted["last_command"]["kind"] == "continue_paused_run"
    assert noted["timeline"][-1]["stage"] == "chat_command"
