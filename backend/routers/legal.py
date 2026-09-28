"""Public legal documents and authenticated acceptance records."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from repositories import legal_repo
from routers.auth import _authenticated_user, _make_token_response, bearer
from fastapi.security import HTTPAuthorizationCredentials
from services.legal_documents import (
    CURRENT_LEGAL_DOCUMENTS,
    LegalDocument,
    get_legal_document,
)


router = APIRouter(prefix="/api/legal", tags=["legal"])


async def get_legal_access_user(
    cred: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> dict:
    """Authenticate without the re-consent gate so users can resolve it."""
    return await _authenticated_user(cred)


class LegalAcceptanceClaim(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    document_type: Literal["terms", "privacy", "ai", "payment"] = Field(alias="documentType")
    version: str = Field(min_length=1, max_length=64)
    content_hash: str = Field(alias="contentHash", pattern=r"^[0-9a-f]{64}$")


class LegalAcceptanceRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    items: list[LegalAcceptanceClaim] = Field(min_length=1, max_length=4)
    source: str = Field(default="legal-center", min_length=1, max_length=64)


def resolve_acceptance_claims(
    claims: list[LegalAcceptanceClaim],
) -> list[LegalDocument]:
    documents: list[LegalDocument] = []
    seen: set[str] = set()
    for claim in claims:
        if claim.document_type in seen:
            raise HTTPException(400, f"协议类型重复：{claim.document_type}")
        seen.add(claim.document_type)

        document = get_legal_document(claim.document_type, claim.version)
        if document is None:
            current = CURRENT_LEGAL_DOCUMENTS[claim.document_type]
            raise HTTPException(
                409,
                detail={
                    "code": "LEGAL_DOCUMENT_OUTDATED",
                    "message": "协议版本已更新，请阅读最新版本后重新确认",
                    "document": current.public_payload(),
                },
            )
        if claim.content_hash != document.content_hash:
            raise HTTPException(
                409,
                detail={
                    "code": "LEGAL_DOCUMENT_HASH_MISMATCH",
                    "message": "协议内容校验失败，请刷新页面后重新确认",
                    "document": document.public_payload(),
                },
            )
        documents.append(document)
    return documents


def _client_evidence(request: Request | None) -> tuple[str, str]:
    if request is None:
        return "", ""
    direct_ip = str(request.client.host if request.client else "").strip()
    if direct_ip in {"127.0.0.1", "::1"}:
        direct_ip = str(request.headers.get("x-real-ip") or "").strip() or direct_ip
    return direct_ip[:128], str(request.headers.get("user-agent") or "")[:1024]


@router.get("/documents")
async def list_current_legal_documents():
    await legal_repo.ensure_document_snapshots()
    return {
        "documents": [
            document.public_payload()
            for document in CURRENT_LEGAL_DOCUMENTS.values()
        ]
    }


@router.get("/documents/{document_type}")
async def read_legal_document(
    document_type: Literal["terms", "privacy", "ai", "payment"],
    version: str | None = Query(default=None, max_length=64),
):
    document = get_legal_document(document_type, version)
    if document is None:
        snapshot = await legal_repo.get_document_snapshot(document_type, version or "")
        if snapshot is None:
            raise HTTPException(404, "未找到该协议版本")
        return snapshot
    await legal_repo.ensure_document_snapshots((document,))
    return document.public_payload(include_content=True)


@router.get("/acceptances/me")
async def my_legal_acceptances(user: dict = Depends(get_legal_access_user)):
    documents = await legal_repo.get_acceptance_status(user["id"])
    required = [
        document
        for document in documents
        if document["requiredAtLogin"] and document["requiresReacceptance"]
    ]
    return {
        "documents": documents,
        "allRequiredAccepted": all(document["accepted"] for document in required),
        "requiresAction": any(
            document["requiresReacceptance"] and not document["accepted"]
            for document in required
        ),
    }


@router.post("/acceptances")
async def accept_legal_documents(
    body: LegalAcceptanceRequest,
    request: Request,
    user: dict = Depends(get_legal_access_user),
):
    documents = resolve_acceptance_claims(body.items)
    client_ip, user_agent = _client_evidence(request)
    await legal_repo.record_acceptances(
        user["id"],
        documents,
        source=body.source,
        client_ip=client_ip,
        user_agent=user_agent,
    )
    status = await legal_repo.get_acceptance_status(user["id"])
    required = [
        document
        for document in status
        if document["requiredAtLogin"] and document["requiresReacceptance"]
    ]
    all_required_accepted = all(document["accepted"] for document in required)
    token_response = _make_token_response(user, legal_accepted=all_required_accepted)
    return {
        "ok": True,
        "documents": status,
        "allRequiredAccepted": all_required_accepted,
        "access_token": token_response.access_token,
        "refresh_token": token_response.refresh_token,
        "user": token_response.user,
    }
