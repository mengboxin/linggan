"""JWT 签发/验证 + 密码哈希（直接用 bcrypt，不依赖 passlib）"""
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from jose import JWTError, jwt

from core.config import settings

ACCESS_TOKEN_EXPIRE_MINUTES  = 60 * 24       # 1 天
REFRESH_TOKEN_EXPIRE_MINUTES = 60 * 24 * 30  # 30 天
ALGORITHM = "HS256"


def _normalize(plain: str) -> bytes:
    """
    bcrypt 限制 72 字节，先用 SHA-256 摘要再哈希，
    这样任意长度密码都安全，且不截断。
    """
    return hashlib.sha256(plain.encode()).digest()


def hash_password(plain: str) -> str:
    hashed = bcrypt.hashpw(_normalize(plain), bcrypt.gensalt(rounds=12))
    return hashed.decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(_normalize(plain), hashed.encode())


def create_access_token(
    user_id: str,
    email: str,
    role: str,
    legal_fingerprint: str | None = None,
) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    claims = {"sub": user_id, "email": email, "role": role, "exp": expire, "type": "access"}
    if legal_fingerprint:
        claims["legal"] = legal_fingerprint
    return jwt.encode(
        claims,
        settings.SECRET_KEY, algorithm=ALGORITHM,
    )


def create_refresh_token(user_id: str, legal_fingerprint: str | None = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=REFRESH_TOKEN_EXPIRE_MINUTES)
    claims = {"sub": user_id, "exp": expire, "type": "refresh"}
    if legal_fingerprint:
        claims["legal"] = legal_fingerprint
    return jwt.encode(
        claims,
        settings.SECRET_KEY, algorithm=ALGORITHM,
    )


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
