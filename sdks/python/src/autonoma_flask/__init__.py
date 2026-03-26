"""Autonoma SDK — Flask server adapter."""

from __future__ import annotations

import asyncio
import copy
import json

from flask import Blueprint, Request, make_response, request

from autonoma.handler import handle_request
from autonoma.types import HandlerConfig, HandlerRequest


def _enrich_config(config: HandlerConfig, server_name: str) -> HandlerConfig:
    enriched = copy.copy(config)
    enriched.sdk_server = server_name  # type: ignore[attr-defined]
    return enriched


def create_flask_handler(config: HandlerConfig) -> Blueprint:
    """Create a Flask blueprint for the Autonoma protocol endpoint.

    Usage::

        from autonoma_flask import create_flask_handler
        bp = create_flask_handler(config)
        app.register_blueprint(bp, url_prefix="/api/autonoma")
    """
    bp = Blueprint("autonoma", __name__)
    enriched = _enrich_config(config, "flask")

    @bp.route("/", methods=["POST"])
    def autonoma_handler():
        body_str = request.get_data(as_text=True)
        headers = {k.lower(): v for k, v in request.headers}

        req = HandlerRequest(body=body_str, headers=headers)
        result = asyncio.run(handle_request(enriched, req))

        response = make_response(json.dumps(result["body"]), result["status"])
        response.headers["Content-Type"] = "application/json"
        return response

    return bp


def flask_handler(config: HandlerConfig):
    """Standalone handler for use in custom routes.

    Returns a view function compatible with ``app.add_url_rule``.
    """
    enriched = _enrich_config(config, "flask")

    def handler():
        body_str = request.get_data(as_text=True)
        headers = {k.lower(): v for k, v in request.headers}

        req = HandlerRequest(body=body_str, headers=headers)
        result = asyncio.run(handle_request(enriched, req))

        response = make_response(json.dumps(result["body"]), result["status"])
        response.headers["Content-Type"] = "application/json"
        return response

    return handler
