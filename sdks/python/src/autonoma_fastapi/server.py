"""Autonoma SDK — FastAPI server adapter."""

from __future__ import annotations

import copy
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from autonoma.handler import handle_request
from autonoma.types import HandlerConfig, HandlerRequest


def _enrich_config(config: HandlerConfig, server_name: str) -> HandlerConfig:
    enriched: HandlerConfig = copy.copy(config)
    if enriched.sdk is None:
        enriched.sdk = {}
    enriched.sdk["server"] = server_name
    return enriched


def create_fastapi_handler(config: HandlerConfig) -> APIRouter:
    """Create a FastAPI router that handles the Autonoma protocol."""
    router: APIRouter = APIRouter()
    enriched: HandlerConfig = _enrich_config(config, "fastapi")

    @router.post("/")
    async def autonoma_handler(request: Request) -> JSONResponse:
        body: bytes = await request.body()
        body_str: str = body.decode("utf-8")
        headers: dict[str, str] = {k.lower(): v for k, v in request.headers.items()}

        req: HandlerRequest = HandlerRequest(body=body_str, headers=headers)
        result = await handle_request(enriched, req)

        return JSONResponse(status_code=result.status, content=result.body)

    return router


async def fastapi_handler(config: HandlerConfig, request: Request) -> JSONResponse:
    """Standalone async handler for use in custom routes."""
    enriched: HandlerConfig = _enrich_config(config, "fastapi")

    body: bytes = await request.body()
    body_str: str = body.decode("utf-8")
    headers: dict[str, str] = {k.lower(): v for k, v in request.headers.items()}

    req: HandlerRequest = HandlerRequest(body=body_str, headers=headers)
    result = await handle_request(enriched, req)

    return JSONResponse(status_code=result.status, content=result.body)
