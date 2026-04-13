"""Autonoma SDK — Django server adapter (view handler)."""

from __future__ import annotations

import asyncio
import copy
import json
from typing import Any

from autonoma.handler import handle_request
from autonoma.serializer import default_serializer
from autonoma.types import HandlerConfig, HandlerRequest


def _enrich_config(config: HandlerConfig, server_name: str) -> HandlerConfig:
    enriched: HandlerConfig = copy.copy(config)
    if enriched.sdk is None:
        enriched.sdk = {}
    enriched.sdk["server"] = server_name
    return enriched


def create_django_handler(config: HandlerConfig) -> Any:
    """Create a Django view function for the Autonoma protocol endpoint."""
    from django.http import HttpResponse
    from django.views.decorators.csrf import csrf_exempt
    from django.views.decorators.http import require_POST

    enriched: HandlerConfig = _enrich_config(config, "django")

    @csrf_exempt
    @require_POST
    def handler(request: Any) -> HttpResponse:
        body_str: str = request.body.decode("utf-8")
        headers: dict[str, str] = {}
        for key, value in request.META.items():
            if key.startswith("HTTP_"):
                header_name: str = key[5:].lower().replace("_", "-")
                headers[header_name] = value
        if "CONTENT_TYPE" in request.META:
            headers["content-type"] = request.META["CONTENT_TYPE"]

        req: HandlerRequest = HandlerRequest(body=body_str, headers=headers)
        result = asyncio.run(handle_request(enriched, req))

        return HttpResponse(
            content=json.dumps(result.body, default=default_serializer),
            status=result.status,
            content_type="application/json",
        )

    return handler
