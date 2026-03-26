"""Structured error for Autonoma protocol responses."""


class AutonomaError(Exception):
    def __init__(self, message: str, code: str, status: int):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def invalid_signature():
    return AutonomaError("Invalid signature", "INVALID_SIGNATURE", 401)


def invalid_body(detail: str):
    return AutonomaError(f"Invalid body: {detail}", "INVALID_BODY", 400)


def unknown_action(action: str):
    return AutonomaError(f"Unknown action: {action}", "UNKNOWN_ACTION", 400)


def production_blocked():
    return AutonomaError("Blocked in production", "PRODUCTION_BLOCKED", 404)


def invalid_refs_token(detail: str):
    return AutonomaError(f"Invalid refs token: {detail}", "INVALID_REFS_TOKEN", 403)


def same_secrets():
    return AutonomaError(
        "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
        "SAME_SECRETS",
        500,
    )
