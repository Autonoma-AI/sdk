defmodule Autonoma.Ecto.AdapterTest do
  use ExUnit.Case, async: false

  alias Autonoma.TestRepo
  alias Autonoma.TestSchemas.{Organization, User, Application}

  setup do
    # Clean tables before each test
    TestRepo.delete_all(Application)
    TestRepo.delete_all(User)
    TestRepo.delete_all(Organization)

    adapter =
      Autonoma.Ecto.Adapter.new(
        TestRepo,
        [Organization, User, Application],
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

    test "returns correct fields for User", %{adapter: adapter} do
      {schema, _adapter} = Autonoma.Ecto.Adapter.get_schema(adapter)
      user_model = Enum.find(schema["models"], fn m -> m["name"] == "User" end)
      field_names = Enum.map(user_model["fields"], fn f -> f["name"] end) |> MapSet.new()
      assert MapSet.member?(field_names, "id")
      assert MapSet.member?(field_names, "email")
      assert MapSet.member?(field_names, "organization_id")
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
    test "creates records in the database", %{adapter: adapter} do
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

      # Verify in DB
      assert TestRepo.aggregate(Organization, :count) == 1
      assert TestRepo.aggregate(User, :count) == 1
    end
  end

  describe "teardown/3" do
    test "removes all scoped records", %{adapter: adapter} do
      # Create data
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
      assert TestRepo.aggregate(Organization, :count) == 1
      assert TestRepo.aggregate(User, :count) == 1
      assert TestRepo.aggregate(Application, :count) == 1

      # Teardown
      :ok = Autonoma.Ecto.Adapter.teardown(adapter, "org-1", nil)

      assert TestRepo.aggregate(Organization, :count) == 0
      assert TestRepo.aggregate(User, :count) == 0
      assert TestRepo.aggregate(Application, :count) == 0
    end
  end

  describe "full round-trip" do
    test "introspect → create → verify → teardown → verify gone", %{adapter: adapter} do
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
      assert TestRepo.aggregate(Organization, :count) == 1
      assert TestRepo.aggregate(User, :count) == 2
      assert TestRepo.aggregate(Application, :count) == 1

      :ok = Autonoma.Ecto.Adapter.teardown(adapter, "org-rt", refs)
      assert TestRepo.aggregate(Organization, :count) == 0
      assert TestRepo.aggregate(User, :count) == 0
      assert TestRepo.aggregate(Application, :count) == 0
    end
  end
end
