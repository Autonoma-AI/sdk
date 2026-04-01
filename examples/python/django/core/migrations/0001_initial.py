# Auto-generated initial migration

import uuid
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Organization",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "organizations"},
        ),
        migrations.CreateModel(
            name="User",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ("email", models.EmailField(max_length=254, unique=True)),
                ("name", models.CharField(max_length=255)),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="users", to="core.organization")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "users"},
        ),
        migrations.CreateModel(
            name="Project",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=255)),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="projects", to="core.organization")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "projects"},
        ),
        migrations.CreateModel(
            name="Task",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, primary_key=True, serialize=False)),
                ("title", models.CharField(max_length=255)),
                ("status", models.CharField(default="todo", max_length=50)),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="core.organization")),
                ("project", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="tasks", to="core.project")),
                ("assignee", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="tasks", to="core.user")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "tasks"},
        ),
    ]
