"""JSON serialization helpers for types not natively supported by json.dumps."""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


def default_serializer(obj: object) -> str:
    """Custom JSON serializer for types not serializable by default json module."""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, Decimal):
        return str(obj)
    return str(obj)
