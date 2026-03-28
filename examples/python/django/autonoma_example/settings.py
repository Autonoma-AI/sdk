# =============================================================================
# Django Settings
# =============================================================================
# Minimal Django settings for the Autonoma example.

import os

SECRET_KEY = "django-insecure-example-only"
DEBUG = True
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "autonoma_example.urls"

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "core",
]

MIDDLEWARE = []

# PostgreSQL database configuration
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "autonoma_example"),
        "USER": os.environ.get("POSTGRES_USER", "autonoma"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "autonoma"),
        "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
        "PORT": os.environ.get("POSTGRES_PORT", "5432"),
    }
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
