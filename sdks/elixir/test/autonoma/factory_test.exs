defmodule Autonoma.FactoryTest do
  use ExUnit.Case, async: true

  alias Autonoma.{Handler, HMAC, Factory}

  @shared_secret "test-secret"
  @signing_secret "test-signing-secret"

  # ---------------------------------------------------------------------------
  # Mock executor with Organization + User tables (User has FK to Organization)
  # ---------------------------------------------------------------------------

  defp mock_executor do
    insert_counter = :atomics.new(1, signed: false)

    fn
      :query, sql, params ->
        sql_lower = String.downcase(sql) |> String.trim()

        cond do
          String.starts_with?(sql_lower, "select table_name") ->
            [%{"table_name" => "organization"}, %{"table_name" => "user"}]

          String.contains?(sql_lower, "column_name") && !String.contains?(sql_lower, "table_constraints") ->
            [
              %{"table_name" => "organization", "column_name" => "id", "data_type" => "uuid", "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => "gen_random_uuid()"},
              %{"table_name" => "organization", "column_name" => "name", "data_type" => "character varying", "udt_name" => "varchar", "is_nullable" => "NO", "column_default" => nil},
              %{"table_name" => "user", "column_name" => "id", "data_type" => "uuid", "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => "gen_random_uuid()"},
              %{"table_name" => "user", "column_name" => "email", "data_type" => "character varying", "udt_name" => "varchar", "is_nullable" => "NO", "column_default" => nil},
              %{"table_name" => "user", "column_name" => "name", "data_type" => "character varying", "udt_name" => "varchar", "is_nullable" => "NO", "column_default" => nil},
              %{"table_name" => "user", "column_name" => "organization_id", "data_type" => "uuid", "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => nil}
            ]

          String.contains?(sql_lower, "tc.constraint_type = 'foreign key'") or String.contains?(sql_lower, "foreign key") ->
            [%{"from_table" => "user", "from_column" => "organization_id", "to_table" => "organization", "to_column" => "id", "is_nullable" => "NO"}]

          String.contains?(sql_lower, "primary key") ->
            [%{"table_name" => "organization", "column_name" => "id"}, %{"table_name" => "user", "column_name" => "id"}]

          String.contains?(sql_lower, "pg_type") or String.contains?(sql_lower, "enum") ->
            []

          String.starts_with?(sql_lower, "insert") ->
            idx = :atomics.add_get(insert_counter, 1, 1)
            record = %{"id" => "mock-id-#{idx}"}

            record =
              if params do
                case Regex.run(~r/\(([^)]+)\)\s*VALUES/i, sql) do
                  [_, col_str] ->
                    cols = col_str |> String.split(",") |> Enum.map(&(String.trim(&1) |> String.replace("\"", "")))
                    Enum.zip(cols, params) |> Enum.into(record)
                  _ ->
                    record
                end
              else
                record
              end

            [record]

          String.starts_with?(sql_lower, "delete") ->
            []

          String.starts_with?(sql_lower, "update") ->
            []

          true ->
            []
        end

      :transaction, fun, _opts ->
        tx = fn :query, sql, params ->
          mock_executor().(:query, sql, params)
        end

        fun.(tx)
    end
  end

  # Track queries through a wrapper that stores them in a process dict key
  defp tracking_executor do
    base = mock_executor()
    Process.put(:tracked_queries, [])

    fn
      :query, sql, params ->
        Process.put(:tracked_queries, Process.get(:tracked_queries, []) ++ [sql])
        base.(:query, sql, params)

      :transaction, fun, _opts ->
        tx = fn :query, sql, params ->
          Process.put(:tracked_queries, Process.get(:tracked_queries, []) ++ [sql])
          base.(:query, sql, params)
        end

        fun.(tx)
    end
  end

  defp make_config(overrides) do
    Map.merge(
      %{
        executor: mock_executor(),
        scope_field: "organizationId",
        shared_secret: @shared_secret,
        signing_secret: @signing_secret,
        auth: fn _user, _ctx ->
          %{"headers" => %{"Authorization" => "Bearer token"}}
        end
      },
      overrides
    )
  end

  defp signed_req(body_map) do
    body = Jason.encode!(body_map)
    %{body: body, headers: %{"x-signature" => HMAC.sign_body(body, @shared_secret)}}
  end

  # ===========================================================================
  # Factory module tests
  # ===========================================================================

  test "define_factory validates create is a 2-arity function" do
    assert_raise ArgumentError, fn ->
      Factory.define_factory(%{create: "not a function"})
    end
  end

  test "define_factory validates teardown if provided" do
    assert_raise ArgumentError, fn ->
      Factory.define_factory(%{create: fn _d, _c -> %{} end, teardown: "not a function"})
    end
  end

  test "define_factory accepts valid definition" do
    factory = Factory.define_factory(%{
      create: fn data, _ctx -> %{"id" => "1", "name" => data["name"]} end
    })
    assert is_function(factory.create, 2)
    assert factory.teardown == nil
  end

  # ===========================================================================
  # Factory integration tests
  # ===========================================================================

  test "factory create is used instead of SQL when factory is registered" do
    test_pid = self()

    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        send(test_pid, {:factory_called, data})
        %{"id" => "factory-org-1", "name" => data["name"]}
      end
    })

    executor = tracking_executor()
    config = make_config(%{executor: executor, factories: %{"Organization" => org_factory}})

    req = signed_req(%{"action" => "up", "create" => %{"Organization" => [%{"name" => "FactoryOrg"}]}, "testRunId" => "run-1"})
    result = Handler.handle(config, req)

    assert result.status == 200
    assert_receive {:factory_called, data}
    assert data["name"] == "FactoryOrg"
    assert result.body["refs"]["Organization"] |> List.first() |> Map.get("id") == "factory-org-1"

    # No INSERT query for Organization should have been issued
    queries = Process.get(:tracked_queries, [])
    org_inserts = Enum.filter(queries, fn q ->
      q_lower = String.downcase(q)
      String.starts_with?(q_lower, "insert") && String.contains?(q_lower, "organization")
    end)
    assert org_inserts == []
  end

  test "hybrid mode: factory for some models, SQL fallback for others" do
    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "factory-org-1", "name" => data["name"]}
      end
    })

    executor = tracking_executor()
    config = make_config(%{executor: executor, factories: %{"Organization" => org_factory}})

    req = signed_req(%{
      "action" => "up",
      "create" => %{
        "Organization" => [%{"name" => "HybridOrg"}],
        "User" => [%{"email" => "test@example.com", "name" => "Test"}]
      },
      "testRunId" => "run-hybrid"
    })

    result = Handler.handle(config, req)
    assert result.status == 200

    # User should have been created via SQL INSERT
    queries = Process.get(:tracked_queries, [])
    user_inserts = Enum.filter(queries, fn q ->
      q_lower = String.downcase(q)
      String.starts_with?(q_lower, "insert") && String.contains?(q_lower, "\"user\"")
    end)
    assert length(user_inserts) > 0
  end

  test "factory receives pre-resolved FK IDs (not temp IDs)" do
    test_pid = self()

    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "resolved-org-id", "name" => data["name"]}
      end
    })

    user_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        send(test_pid, {:user_data, data})
        %{"id" => "user-1", "email" => data["email"], "organizationId" => data["organizationId"]}
      end
    })

    config = make_config(%{factories: %{"Organization" => org_factory, "User" => user_factory}})

    # Nest User under Organization so tree resolver wires the FK
    req = signed_req(%{
      "action" => "up",
      "create" => %{
        "Organization" => [%{"name" => "Org", "User" => [%{"email" => "a@b.com", "name" => "A"}]}]
      },
      "testRunId" => "run-fk"
    })

    result = Handler.handle(config, req)
    assert result.status == 200

    # The User factory should receive the real org ID, not __temp_Organization_0
    assert_receive {:user_data, data}
    assert data["organizationId"] == "resolved-org-id"
  end

  test "errors when factory does not return PK field (FACTORY_MISSING_PK)" do
    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"name" => data["name"]}  # missing "id"
      end
    })

    config = make_config(%{factories: %{"Organization" => org_factory}})

    req = signed_req(%{
      "action" => "up",
      "create" => %{"Organization" => [%{"name" => "NoPK"}]},
      "testRunId" => "run-nopk"
    })

    result = Handler.handle(config, req)
    assert result.status == 500
    assert result.body["code"] == "FACTORY_MISSING_PK"
  end

  test "factory teardown is called per record in reverse order" do
    test_pid = self()

    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "org-#{data["name"]}", "name" => data["name"]}
      end,
      teardown: fn record, _ctx ->
        send(test_pid, {:teardown_called, record["id"]})
      end
    })

    config = make_config(%{factories: %{"Organization" => org_factory}})

    # Create
    up_req = signed_req(%{
      "action" => "up",
      "create" => %{"Organization" => [%{"name" => "A"}, %{"name" => "B"}]},
      "testRunId" => "run-teardown"
    })
    up_result = Handler.handle(config, up_req)
    assert up_result.status == 200
    refs_token = up_result.body["refsToken"]

    # Teardown
    down_req = signed_req(%{"action" => "down", "refsToken" => refs_token})
    down_result = Handler.handle(config, down_req)
    assert down_result.status == 200

    # Should receive teardown calls in reverse order: B first, then A
    assert_receive {:teardown_called, id1}
    assert_receive {:teardown_called, id2}
    assert id1 == "org-B"
    assert id2 == "org-A"
  end

  test "SQL DELETE used when factory has no teardown defined" do
    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "org-1", "name" => data["name"]}
        # No teardown -- SQL DELETE should be used
      end
    })

    executor = tracking_executor()
    config = make_config(%{executor: executor, factories: %{"Organization" => org_factory}})

    up_req = signed_req(%{
      "action" => "up",
      "create" => %{"Organization" => [%{"name" => "Org"}]},
      "testRunId" => "run-sql-td"
    })
    up_result = Handler.handle(config, up_req)
    assert up_result.status == 200

    refs_token = up_result.body["refsToken"]
    down_req = signed_req(%{"action" => "down", "refsToken" => refs_token})
    down_result = Handler.handle(config, down_req)
    assert down_result.status == 200

    # SQL DELETE should have been used
    queries = Process.get(:tracked_queries, [])
    delete_queries = Enum.filter(queries, fn q -> String.contains?(String.downcase(q), "delete") end)
    assert length(delete_queries) > 0
  end

  test "factory context contains refs of previously created models and test_run_id" do
    test_pid = self()

    org_factory = Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "org-ctx", "name" => data["name"]}
      end
    })

    user_factory = Factory.define_factory(%{
      create: fn data, ctx ->
        send(test_pid, {:user_ctx, ctx})
        %{"id" => "user-ctx", "email" => data["email"], "organizationId" => data["organizationId"]}
      end
    })

    config = make_config(%{factories: %{"Organization" => org_factory, "User" => user_factory}})

    req = signed_req(%{
      "action" => "up",
      "create" => %{
        "Organization" => [%{"name" => "Org"}],
        "User" => [%{"email" => "x@y.com", "name" => "X"}]
      },
      "testRunId" => "run-ctx"
    })

    Handler.handle(config, req)

    assert_receive {:user_ctx, ctx}
    # By the time User factory runs, Organization should already be in refs
    assert is_map(ctx.refs)
    assert Map.has_key?(ctx.refs, "Organization")
    assert length(ctx.refs["Organization"]) == 1
    assert List.first(ctx.refs["Organization"])["id"] == "org-ctx"
    assert ctx.test_run_id == "run-ctx"
  end
end
