defmodule Autonoma.TestMigrations do
  def up(repo) do
    repo.query!("""
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    """)

    repo.query!("""
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        organization_id TEXT REFERENCES organizations(id)
      )
    """)

    repo.query!("""
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        organization_id TEXT REFERENCES organizations(id)
      )
    """)
  end

  def down(repo) do
    repo.query!("DROP TABLE IF EXISTS applications")
    repo.query!("DROP TABLE IF EXISTS users")
    repo.query!("DROP TABLE IF EXISTS organizations")
  end
end
