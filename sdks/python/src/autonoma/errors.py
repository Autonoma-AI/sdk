"""Structured error for Autonoma protocol responses."""

from typing import Optional


class AutonomaError(Exception):
    def __init__(self, message: str, code: str, status: int) -> None:
        super().__init__(message)
        self.message: str = message
        self.code: str = code
        self.status: int = status


def invalid_signature() -> AutonomaError:
    return AutonomaError("Invalid signature", "INVALID_SIGNATURE", 401)


def invalid_body(detail: str) -> AutonomaError:
    return AutonomaError(f"Invalid body: {detail}", "INVALID_BODY", 400)


def unknown_action(action: str) -> AutonomaError:
    return AutonomaError(f"Unknown action: {action}", "UNKNOWN_ACTION", 400)


def production_blocked(detail: Optional[str] = None) -> AutonomaError:
    """Deprecated - the SDK no longer gates on production; this is never raised."""
    return AutonomaError(
        "Environment factory is disabled"
        + ("" if detail is None else f". {detail}"),
        "PRODUCTION_BLOCKED",
        404,
    )


def invalid_refs_token(detail: str) -> AutonomaError:
    return AutonomaError(f"Invalid refs token: {detail}", "INVALID_REFS_TOKEN", 403)


def same_secrets() -> AutonomaError:
    return AutonomaError(
        "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
        "SAME_SECRETS",
        500,
    )
