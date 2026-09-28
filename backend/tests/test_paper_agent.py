import asyncio

from services.agents import paper_agent as paper_agent_module
from services.agents.creative_contract import build_delivery_contract
from services.agents.paper_agent import (
    _build_evidence_ledger,
    _citation_report,
    _ensure_lifecycle_message,
    _markdown_to_typst,
    _normalize_outline,
    _status_reply,
    paper_agent,
)


class _FakePipeline:
    def __init__(self, redis):
        self.redis = redis
        self.operations = []

    def set(self, key, value, ex=None):
        self.operations.append(("set", key, value))
        return self

    def delete(self, key):
        self.operations.append(("delete", key, None))
        return self

    async def execute(self):
        for operation, key, value in self.operations:
            if operation == "set":
                self.redis.values[key] = value
            else:
                self.redis.values.pop(key, None)


class _FakeRedis:
    def __init__(self):
        self.values = {}

    async def exists(self, key):
        return int(key in self.values)

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, ex=None):
        self.values[key] = value

    def pipeline(self, transaction=True):
        return _FakePipeline(self)


def test_deleted_paper_job_cannot_be_resurrected_by_worker(monkeypatch):
    redis = _FakeRedis()

    async def no_run_sync(*_args, **_kwargs):
        return None

    monkeypatch.setattr(paper_agent_module, "get_redis", lambda: redis)
    monkeypatch.setattr(paper_agent_module, "sync_specialist_run", no_run_sync)
    state = {"job_id": "paper-delete-test", "user_id": "user-1", "status": "planning"}

    async def scenario():
        await paper_agent_module._save_state(state)
        assert await paper_agent.delete_state("paper-delete-test", user_id="user-1")
        # This simulates a queue worker completing after the user removed history.
        state["status"] = "done"
        await paper_agent_module._save_state(state)
        return await paper_agent_module._load_state("paper-delete-test")

    assert asyncio.run(scenario()) is None


def test_paper_delivery_contract_requires_traceable_sources():
    contract = build_delivery_contract(
        module="paper",
        action="create",
        instruction="基于实验资料撰写论文",
        context={"attachment_count": 2},
    )

    assert contract.artifact_type == "research_paper"
    assert contract.revision_scope == "paper"
    assert any("追溯" in criterion for criterion in contract.acceptance_criteria)


def test_evidence_ledger_uses_only_uploaded_materials():
    ledger = _build_evidence_ledger({
        "attachments": [
            {"filename": "实验记录.pdf", "kind": "pdf", "text": "样本 A 在条件 X 下完成测试。"},
            {"filename": "数据.csv", "kind": "csv", "text": "sample,value\nA,42"},
        ],
    })

    assert [item["key"] for item in ledger] == ["src-1", "src-2"]
    assert ledger[0]["citation_label"] == "用户资料 1：实验记录.pdf"
    assert "42" in ledger[1]["excerpt"]


def test_outline_discards_unknown_evidence_keys():
    ledger = [{"key": "src-1", "label": "实验记录", "excerpt": "可追溯事实"}]
    outline = _normalize_outline({
        "title": "测试论文",
        "sections": [{
            "title": "结果",
            "purpose": "分析实验结果",
            "evidence_keys": ["src-1", "invented-source"],
        }],
        "figures": [{
            "title": "结果趋势",
            "purpose": "展示结果",
            "strategy": "generated_illustration",
            "evidence_keys": ["invented-source"],
        }],
    }, "默认标题", ledger)

    assert outline["sections"][0]["evidence_keys"] == ["src-1"]
    assert outline["figures"][0]["evidence_keys"] == []


def test_typst_source_keeps_user_source_statement():
    typst = _markdown_to_typst(
        "# 测试论文\n\n## 研究背景\n来自用户资料的事实。",
        "测试论文",
        [{"citation_label": "用户资料 1：实验记录.pdf"}],
    )

    assert "资料来源说明" in typst
    assert "用户资料 1：实验记录.pdf" in typst


def test_citation_report_flags_unverifiable_doi_pattern():
    report = _citation_report("结果参见 doi:10.1000/example", [])

    assert report["passed"] is False


def test_confirmation_state_adds_one_visible_outline_update():
    state = {
        "status": "awaiting_confirmation",
        "outline": {"sections": [{"title": "研究背景"}, {"title": "研究方法"}]},
        "chat_messages": [],
    }

    assert _ensure_lifecycle_message(state)
    assert "正文与排版尚未开始" in state["chat_messages"][-1]["content"]
    assert not _ensure_lifecycle_message(state)
    assert len(state["chat_messages"]) == 1


def test_done_status_reply_explains_delivery_and_evidence_gaps():
    state = {
        "status": "done",
        "artifacts": [{"name": "可编辑正文草稿", "available": True}],
        "qa_report": {"source_count": 0, "placeholders": 3},
    }

    assert "可编辑正文草稿" in _status_reply(state)
    assert "3 处待补充证据" in _status_reply(state)
