defmodule Autonoma.Ecto.PostgresIntegrationTest do
  use ExUnit.Case, async: false

  alias Autonoma.PostgresTestRepo, as: Repo
  alias Autonoma.TestSchemas.{Organization, User}
  alias Autonoma.TestSchemas.Application, as: App

  @moduletag :postgres

  setup_all do
    # Start testcontainers
    {:ok, _} = Testcontainers.start_link()

    config =
      Testcontainers.PostgresContainer.new()
      |> Testcontainers.PostgresContainer.with_image("postgres:16-alpine")

    {:ok, container} = Testcontainers.start_container(config)

    # Get connection parameters from the container
    params = Testcontainers.PostgresContainer.connection_parameters(container)

    # Configure and start the Postgres repo
    :application.set_env(:autonoma, Autonoma.PostgresTestRepo,
      Keyword.merge(params, pool_size: 2)
    )

    {:ok, _pid} = Repo.start_link()

    # Create tables
    Repo.query!("""
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    """)

    Repo.query!("""
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(id)
      )
    """)

    Repo.query!("""
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(id)
      )
    """)

    :ok
  end

  setup do
    # Clean tables before each test (reverse FK order)
    Repo.delete_all(App)
    Repo.delete_all(User)
    Repo.delete_all(Organization)

    adapter =
      Autonoma.Ecto.Adapter.new(
        Repo,
        [Organization, User, App],
        scope_field: "organization_id"
      )

    {:ok, adapter: adapter}
  end

  describe "get_schema/1" do
    test "returns correct models", %{adapter: adapter} do
      {schema, _adapter} = Autonoma.Ecto.Adapter.get_schema(adapter)
      model_names = Enum.map(schema["models"], fn m -> m["name"] end) |> MapSet.new()
      assert MapSet.equal?(model_names, MapSet.new(["Organization", "User", "Application"]))
    end

    test "returns FK edges", %{adapter: adapter} do
      {schema, _adapter} = Autonoma.Ecto.Adapter.get_schema(adapter)
      edge_pairs = Enum.map(schema["edges"], fn e -> {e["from"], e["to"]} end) |> MapSet.new()
      assert MapSet.member?(edge_pairs, {"User", "Organization"})
      assert MapSet.member?(edge_pairs, {"Application", "Organization"})
    end

    test "returns scope field", %{adapter: adapter} do
      {schema, _adapter} = Autonoma.Ecto.Adapter.get_schema(adapter)
      assert schema["scopeField"] == "organization_id"
    end
  end

  describe "create_entities/3" do
    test "creates records in PostgreSQL", %{adapter: adapter} do
      spec = %{
        "Organization" => %{"fields" => [%{"id" => "org-1", "name" => "Test Org"}]},
        "User" => %{
          "fields" => [%{"id" => "user-1", "email" => "test@test.com", "organization_id" => "org-1"}]
        }
      }

      {:ok, refs} = Autonoma.Ecto.Adapter.create_entities(adapter, spec, %{})

      assert Map.has_key?(refs, "Organization")
      assert hd(refs["Organization"])["id"] == "org-1"
      assert Map.has_key?(refs, "User")
      assert hd(refs["User"])["email"] == "test@test.com"

      assert Repo.aggregate(Organization, :count) == 1
      assert Repo.aggregate(User, :count) == 1
    end

    test "enforces FK constraints", %{adapter: adapter} do
      spec = %{
        "User" => %{
          "fields" => [%{"id" => "orphan", "email" => "x@y.com", "organization_id" => "nonexistent"}]
        }
      }

      assert_raise Ecto.ConstraintError, fn ->
        Autonoma.Ecto.Adapter.create_entities(adapter, spec, %{})
      end
    end
  end

  describe "teardown/3" do
    test "removes all scoped records", %{adapter: adapter} do
      spec = %{
        "Organization" => %{"fields" => [%{"id" => "org-1", "name" => "Test Org"}]},
        "User" => %{
          "fields" => [%{"id" => "u1", "email" => "a@b.com", "organization_id" => "org-1"}]
        },
        "Application" => %{
          "fields" => [%{"id" => "a1", "name" => "App", "organization_id" => "org-1"}]
        }
      }

      {:ok, _refs} = Autonoma.Ecto.Adapter.create_entities(adapter, spec, %{})

      assert Repo.aggregate(Organization, :count) == 1
      assert Repo.aggregate(User, :count) == 1
      assert Repo.aggregate(App, :count) == 1

      :ok = Autonoma.Ecto.Adapter.teardown(adapter, "org-1", nil)

      assert Repo.aggregate(Organization, :count) == 0
      assert Repo.aggregate(User, :count) == 0
      assert Repo.aggregate(App, :count) == 0
    end

    test "only removes scoped records", %{adapter: adapter} do
      spec = %{
        "Organization" => %{
          "fields" => [
            %{"id" => "org-a", "name" => "Org A"},
            %{"id" => "org-b", "name" => "Org B"}
          ]
        },
        "User" => %{
          "fields" => [
            %{"id" => "u-a", "email" => "a@a.com", "organization_id" => "org-a"},
            %{"id" => "u-b", "email" => "b@b.com", "organization_id" => "org-b"}
          ]
        }
      }

      {:ok, _refs} = Autonoma.Ecto.Adapter.create_entities(adapter, spec, %{})

      :ok = Autonoma.Ecto.Adapter.teardown(adapter, "org-a", nil)

      assert Repo.aggregate(Organization, :count) == 1
      assert Repo.aggregate(User, :count) == 1
      remaining = Repo.one(User)
      assert remaining.id == "u-b"
    end
  end

  describe "full round-trip" do
    test "introspect -> create -> verify -> teardown -> verify gone", %{adapter: adapter} do
      {schema, adapter} = Autonoma.Ecto.Adapter.get_schema(adapter)
      assert length(schema["models"]) == 3

      spec = %{
        "Organization" => %{"fields" => [%{"id" => "org-rt", "name" => "RT Org"}]},
        "User" => %{
          "fields" => [
            %{"id" => "u1", "email" => "u1@test.com", "organization_id" => "org-rt"},
            %{"id" => "u2", "email" => "u2@test.com", "organization_id" => "org-rt"}
          ]
        },
        "Application" => %{
          "fields" => [%{"id" => "a1", "name" => "MyApp", "organization_id" => "org-rt"}]
        }
      }

      {:ok, refs} = Autonoma.Ecto.Adapter.create_entities(adapter, spec, %{})

      assert Repo.aggregate(Organization, :count) == 1
      assert Repo.aggregate(User, :count) == 2
      assert Repo.aggregate(App, :count) == 1

      :ok = Autonoma.Ecto.Adapter.teardown(adapter, "org-rt", refs)

      assert Repo.aggregate(Organization, :count) == 0
      assert Repo.aggregate(User, :count) == 0
      assert Repo.aggregate(App, :count) == 0
    end
  end
end
