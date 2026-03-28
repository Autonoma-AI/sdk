# =============================================================================
# URL Configuration
# =============================================================================
# Mounts the Autonoma endpoint at /api/autonoma/

from django.urls import path
from core.autonoma_config import handler

urlpatterns = [
    path("api/autonoma/", handler),
]
