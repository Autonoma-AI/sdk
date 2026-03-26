"""Autonoma SDK — FastAPI server adapter."""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from autonoma.handler import handle_request
from autonoma.types import HandlerConfig, HandlerRequest

if TYPE_CHECKING:
    pass


def _enrich_config(config: HandlerConfig, server_name: str) -> HandlerConfig:
    enriched = copy.copy(config)
    enriched.sdk_server = server_name  # type: ignore[attr-defined]
    return enriched


def create_fastapi_handler(config: HandlerConfig) -> APIRouter:
    """Create a FastAPI router that handles the Autonoma protocol.

    Usage::

        from autonoma_fastapi import create_fastapi_handler
        router = create_fastapi_handler(config)
        app.include_router(router, prefix="/api/autonoma")
    """
    router = APIRouter()
    enriched = _enrich_config(config, "fastapi")

    @router.post("/")
    async def autonoma_handler(request: Request) -> JSONResponse:
        body = await request.body()
        body_str = body.decode("utf-8")
        headers = {k.lower(): v for k, v in request.headers.items()}

        req = HandlerRequest(body=body_str, headers=headers)
        result = await handle_request(enriched, req)

        return JSONResponse(status_code=result["status"], content=result["body"])

    return router


async def fastapi_handler(config: HandlerConfig, request: Request) -> JSONResponse:
    """Standalone async handler for use in custom routes."""
    enriched = _enrich_config(config, "fastapi")

    body = await request.body()
    body_str = body.decode("utf-8")
    headers = {k.lower(): v for k, v in request.headers.items()}

    req = HandlerRequest(body=body_str, headers=headers)
    result = await handle_request(enriched, req)

    return JSONResponse(status_code=result["status"], content=result["body"])
