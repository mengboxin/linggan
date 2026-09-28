"""Legacy SQLAlchemy helpers.

The API and worker use `core.pool` (asyncpg). This module only exists for
offline scripts that still import `Base`. It must not open a second process-wide
connection pool on import.
"""
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
