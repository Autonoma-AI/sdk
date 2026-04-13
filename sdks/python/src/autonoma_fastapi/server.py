"""Autonoma SDK — FastAPI server adapter."""

from __future__ import annotations

import copy
import json
from typing import Callable

from fastapi import APIRouter, Request
from starlette.responses import Response

from autonoma.handler import handle_request
from autonoma.serializer import default_serializer
from autonoma.types import HandlerConfig, HandlerRequest


def _enrich_config(config: HandlerConfig, server_name: str) -> HandlerConfig:
    enriched: HandlerConfig = copy.copy(config)
    if enriched.sdk is None:
        enriched.sdk = {}
    enriched.sdk["server"] = server_name
    return enriched


def create_fastapi_handler(
    config: HandlerConfig | None = None,
    *,
    config_factory: Callable[[], HandlerConfig] | None = None,
) -> APIRouter:
    """Create a FastAPI router that handles the Autonoma protocol.

    Pass either a fixed ``config`` (shared across requests) or a
    ``config_factory`` callable that returns a fresh ``HandlerConfig``
    per request (useful when the executor holds per-request state such
    as a DB transaction).
    """
    if config is not None and config_factory is not None:
        raise TypeError("Pass either config or config_factory, not both")
    if config is None and config_factory is None:
        raise TypeError("Either config or config_factory is required")

    # Pre-enrich once for the fixed-config path
    enriched: HandlerConfig | None = _enrich_config(config, "fastapi") if config is not None else None

    router: APIRouter = APIRouter()

    @router.post("/")
    async def autonoma_handler(request: Request) -> Response:
        req_config = enriched if enriched is not None else _enrich_config(config_factory(), "fastapi")

        body: bytes = await request.body()
        body_str: str = body.decode("utf-8")
        headers: dict[str, str] = {k.lower(): v for k, v in request.headers.items()}

        req: HandlerRequest = HandlerRequest(body=body_str, headers=headers)
        result = await handle_request(req_config, req)

        return Response(
            content=json.dumps(result.body, default=default_serializer),
            status_code=result.status,
            media_type="application/json",
        )

    return router


async def fastapi_handler(
    config: HandlerConfig | None = None,
    request: Request | None = None,
    *,
    config_factory: Callable[[], HandlerConfig] | None = None,
) -> Response:
    """Standalone async handler for use in custom routes.

    Accepts either a fixed ``config`` or a ``config_factory`` that
    produces a fresh config per call.
    """
    if config is not None and config_factory is not None:
        raise TypeError("Pass either config or config_factory, not both")
    if config is None and config_factory is None:
        raise TypeError("Either config or config_factory is required")
    if request is None:
        raise TypeError("request is required")

    enriched = _enrich_config(config if config is not None else config_factory(), "fastapi")

    body: bytes = await request.body()
    body_str: str = body.decode("utf-8")
    headers: dict[str, str] = {k.lower(): v for k, v in request.headers.items()}

    req: HandlerRequest = HandlerRequest(body=body_str, headers=headers)
    result = await handle_request(enriched, req)

    return Response(
        content=json.dumps(result.body, default=default_serializer),
        status_code=result.status,
        media_type="application/json",
    )
