# =============================================================================
# Database Connection
# =============================================================================
# Sets up the SQLAlchemy engine, session factory, and base class.

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Database URL — connects to the PostgreSQL container
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://autonoma:autonoma@localhost:5432/autonoma_example",
)

# Create the SQLAlchemy engine
# - echo=True prints SQL statements to the console (helpful for learning)
engine = create_engine(DATABASE_URL, echo=True)

# Session factory — creates new database sessions
# - autocommit=False: we control when commits happen
# - autoflush=False: we control when SQLAlchemy syncs with the database
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


# Base class for all models
class Base(DeclarativeBase):
    pass
