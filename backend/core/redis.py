"""Process-wide Redis clients with isolated command and Pub/Sub pools."""

import redis.asyncio as aioredis

from core.config import settings


_client: aioredis.Redis | None = None
_pubsub_client: aioredis.Redis | None = None

# Pub/Sub connections are long-lived. Keeping the shared event broker in a
# small isolated pool prevents it from starving OTP, queue, billing, and tasks.
_MAX_CONNECTIONS = 50
_PUBSUB_MAX_CONNECTIONS = 4


def _create_client(*, max_connections: int, socket_timeout: float | None = 10) -> aioredis.Redis:
    return aioredis.from_url(
        settings.REDIS_URL,
        protocol=2,
        encoding="utf-8",
        decode_responses=True,
        max_connections=max_connections,
        socket_connect_timeout=5,
        socket_timeout=socket_timeout,
        retry_on_timeout=True,
        health_check_interval=30,
    )


def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = _create_client(max_connections=_MAX_CONNECTIONS)
    return _client


def get_redis_pubsub() -> aioredis.Redis:
    global _pubsub_client
    if _pubsub_client is None:
        _pubsub_client = _create_client(
            max_connections=_PUBSUB_MAX_CONNECTIONS,
            socket_timeout=None,
        )
    return _pubsub_client


async def close_redis_clients() -> None:
    global _client, _pubsub_client
    clients = [client for client in (_client, _pubsub_client) if client is not None]
    _client = None
    _pubsub_client = None
    for client in clients:
        close = getattr(client, "aclose", None) or getattr(client, "close", None)
        if close is not None:
            await close()
