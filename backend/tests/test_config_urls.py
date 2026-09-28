from core import config


def test_database_url_builder_percent_encodes_credentials(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DB_HOST", "postgres")
    monkeypatch.setenv("DB_PORT", "5432")
    monkeypatch.setenv("DB_NAME", "pixel data")
    monkeypatch.setenv("DB_USER", "pixel@user")
    monkeypatch.setenv("DB_PASSWORD", "p@ss:word#1")

    assert config._build_database_url() == (
        "postgresql+asyncpg://pixel%40user:p%40ss%3Aword%231@postgres:5432/pixel%20data"
    )
