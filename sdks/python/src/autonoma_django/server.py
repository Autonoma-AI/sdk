"""Autonoma SDK — Django server adapter (view handler)."""

from __future__ import annotations

import asyncio
import copy
from typing import Any

from autonoma.handler import handle_request
from autonoma.types import HandlerConfig, HandlerRequest


def _enrich_config(config: HandlerConfig, server_name: str) -> HandlerConfig:
    enriched: HandlerConfig = copy.copy(config)
    enriched.sdk_server = server_name  # type: ignore[attr-defined]
    return enriched


def create_django_handler(config: HandlerConfig) -> Any:
    """Create a Django view function for the Autonoma protocol endpoint.

    Usage::

        from autonoma_django import create_django_handler
        urlpatterns = [path("api/autonoma/", create_django_handler(config))]
    """
    from django.http import JsonResponse
    from django.views.decorators.csrf import csrf_exempt
    from django.views.decorators.http import require_POST

    enriched: HandlerConfig = _enrich_config(config, "django")

    @csrf_exempt
    @require_POST
    def handler(request: Any) -> JsonResponse:
        body_str: str = request.body.decode("utf-8")
        headers: dict[str, str] = {}
        for key, value in request.META.items():
            if key.startswith("HTTP_"):
                header_name: str = key[5:].lower().replace("_", "-")
                headers[header_name] = value
        if "CONTENT_TYPE" in request.META:
            headers["content-type"] = request.META["CONTENT_TYPE"]

        req: HandlerRequest = HandlerRequest(body=body_str, headers=headers)
        result: dict[str, Any] = asyncio.run(handle_request(enriched, req))

        return JsonResponse(result["body"], status=result["status"])

    return handler
