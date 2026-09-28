from __future__ import annotations

import ast
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[1]


def _calls_named(tree: ast.AST, name: str) -> bool:
    return any(
        isinstance(node, ast.Call)
        and ((isinstance(node.func, ast.Name) and node.func.id == name)
             or (isinstance(node.func, ast.Attribute) and node.func.attr == name))
        for node in ast.walk(tree)
    )


def test_api_and_worker_startup_do_not_execute_schema_migrations():
    for filename in ("main.py", "worker_main.py"):
        tree = ast.parse((BACKEND / filename).read_text(encoding="utf-8"))
        assert not _calls_named(tree, "run_schema_migrations"), filename


def test_migrations_have_an_explicit_cli_entrypoint():
    script = (BACKEND / "scripts" / "run_migrate.py").read_text(encoding="utf-8")
    assert "run_schema_migrations" in script


def test_legacy_database_module_does_not_open_a_second_pool():
    source = (BACKEND / "core" / "database.py").read_text(encoding="utf-8")
    assert "create_async_engine" not in source
    assert "pool_size" not in source
