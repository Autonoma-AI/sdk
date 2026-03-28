# =============================================================================
# SQLAlchemy Models
# =============================================================================
# This defines a typical multi-tenant SaaS schema. The key concept for Autonoma
# is the "scope field" — a field that exists on every model and ties all data
# to a specific tenant.
#
# In this example, `organization_id` is our scope field. Every model has it,
# and Autonoma uses it to scope test data creation and teardown.

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class Organization(Base):
    """The root tenant model — everything belongs to an Organization."""

    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    # Relations: an Organization has many Users and Projects
    users: Mapped[list["User"]] = relationship(back_populates="organization")
    projects: Mapped[list["Project"]] = relationship(back_populates="organization")


class User(Base):
    """A user belongs to an Organization."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)

    # Relations
    organization: Mapped["Organization"] = relationship(back_populates="users")
    tasks: Mapped[list["Task"]] = relationship(back_populates="assignee")


class Project(Base):
    """A project belongs to an Organization."""

    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)

    # Relations
    organization: Mapped["Organization"] = relationship(back_populates="projects")
    tasks: Mapped[list["Task"]] = relationship(back_populates="project")


class Task(Base):
    """A task belongs to a Project and is assigned to a User."""

    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="todo")
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), nullable=False)
    assignee_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)

    # Relations
    project: Mapped["Project"] = relationship(back_populates="tasks")
    assignee: Mapped["User"] = relationship(back_populates="tasks")
