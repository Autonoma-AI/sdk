# =============================================================================
# Django Models
# =============================================================================
# A typical multi-tenant SaaS schema using Django ORM.
#
# Key concept: `organization_id` (via ForeignKey to Organization) is the scope
# field. Autonoma uses it to isolate and clean up test data.
#
# Note: In Django, the scope field on the Organization model itself doesn't
# need to be a FK — the adapter handles it as a self-reference to the PK.

import uuid
from django.db import models


class Organization(models.Model):
    """The root tenant model — everything belongs to an Organization."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "organizations"


class User(models.Model):
    """A user belongs to an Organization."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=255)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="users")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "users"


class Project(models.Model):
    """A project belongs to an Organization."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    name = models.CharField(max_length=255)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="projects")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects"


class Task(models.Model):
    """A task belongs to a Project and is assigned to a User."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    title = models.CharField(max_length=255)
    status = models.CharField(max_length=50, default="todo")
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    assignee = models.ForeignKey(User, on_delete=models.CASCADE, related_name="tasks")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tasks"
