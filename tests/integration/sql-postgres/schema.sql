-- Postgres DDL — mirrors the Quarita schema (subset) for integration testing

CREATE TYPE "ApplicationArchitecture" AS ENUM ('WEB', 'IOS', 'ANDROID');
CREATE TYPE "run_step_status" AS ENUM ('pending', 'running', 'passed', 'failed', 'skipped');

CREATE TABLE "Organization" (
  "id"        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"      TEXT NOT NULL,
  "slug"      TEXT NOT NULL UNIQUE,
  "logo"      TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "User" (
  "id"            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"          TEXT NOT NULL,
  "email"         TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "image"         TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Member" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"         TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "role"           TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("userId", "organizationId")
);

CREATE TABLE "Invitation" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "email"          TEXT NOT NULL,
  "inviterId"      TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "role"           TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "expiresAt"      TIMESTAMPTZ NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "Application" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"           TEXT NOT NULL,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "architecture"   "ApplicationArchitecture" NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("name", "organizationId")
);

CREATE TABLE "ApiKey" (
  "id"        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "key"       TEXT NOT NULL,
  "userId"    TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "folder" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "application_id" TEXT NOT NULL REFERENCES "Application"("id") ON DELETE CASCADE,
  "parent_id"      TEXT REFERENCES "folder"("id"),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "tag" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"           TEXT NOT NULL,
  "color"          TEXT NOT NULL,
  "application_id" TEXT NOT NULL REFERENCES "Application"("id") ON DELETE CASCADE,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "TestPlan" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"           TEXT NOT NULL,
  "plan"           TEXT NOT NULL,
  "userId"         TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "applicationId"  TEXT NOT NULL REFERENCES "Application"("id") ON DELETE CASCADE,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "TestGeneration" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "testPlanId"     TEXT NOT NULL REFERENCES "TestPlan"("id") ON DELETE CASCADE,
  "application_id" TEXT NOT NULL REFERENCES "Application"("id") ON DELETE CASCADE,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "conversation"   JSONB NOT NULL DEFAULT '[]',
  "reasoning"      TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "test" (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "test_generation_id"  TEXT NOT NULL UNIQUE REFERENCES "TestGeneration"("id") ON DELETE CASCADE,
  "application_id"      TEXT NOT NULL REFERENCES "Application"("id") ON DELETE CASCADE,
  "folder_id"           TEXT REFERENCES "folder"("id") ON DELETE SET NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "test_step" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "test_id"     TEXT NOT NULL REFERENCES "test"("id") ON DELETE CASCADE,
  "order"       INTEGER NOT NULL,
  "interaction" TEXT NOT NULL,
  "params"      JSONB NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("test_id", "order")
);

CREATE TABLE "test_tag" (
  "id"      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "test_id" TEXT NOT NULL REFERENCES "test"("id") ON DELETE CASCADE,
  "tag_id"  TEXT NOT NULL REFERENCES "tag"("id") ON DELETE CASCADE,
  UNIQUE ("test_id", "tag_id")
);

CREATE TABLE "run" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "test_id"      TEXT NOT NULL REFERENCES "test"("id") ON DELETE CASCADE,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "started_at"   TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ
);

CREATE TABLE "run_step" (
  "id"           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "run_id"       TEXT NOT NULL REFERENCES "run"("id") ON DELETE CASCADE,
  "test_step_id" TEXT NOT NULL REFERENCES "test_step"("id") ON DELETE CASCADE,
  "order"        INTEGER NOT NULL,
  "status"       "run_step_status" NOT NULL,
  "output"       JSONB NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("run_id", "order"),
  UNIQUE ("run_id", "test_step_id")
);
