#!/usr/bin/env python3
"""Minimal Flask server that runs the Python SDK's v2 handler with a couple of
scenarios. Used by ``run-suites.mjs`` to exercise the shared
``protocol/suites/*`` against a real Python endpoint.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdks", "python", "src"))

from flask import Flask

from autonoma.scenario import define_scenario
from autonoma.types import HandlerConfig
from autonoma_flask import create_flask_handler

SHARED_SECRET = os.environ.get("AUTONOMA_SHARED_SECRET", "protocol-shared")
SIGNING_SECRET = os.environ.get("AUTONOMA_SIGNING_SECRET", "protocol-signing")
PORT = int(os.environ.get("PORT", "4598"))

config = HandlerConfig(
    shared_secret=SHARED_SECRET,
    signing_secret=SIGNING_SECRET,
    scenarios=[
        define_scenario(
            name="standard",
            description="A standard seeded environment",
            up=lambda ctx: {
                "auth": {"headers": {"Authorization": f"Bearer token-{ctx.test_run_id}"}},
                "teardown": {"user_id": f"user-{ctx.test_run_id}"},
            },
            down=lambda ctx: None,
        ),
        define_scenario(name="empty", description="Nothing seeded", up=lambda ctx: {}),
    ],
)

app = Flask(__name__)
app.register_blueprint(create_flask_handler(config))


if __name__ == "__main__":
    app.run(port=PORT, debug=False)
