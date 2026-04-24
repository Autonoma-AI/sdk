defmodule Autonoma.HandlerTest do
  use ExUnit.Case, async: false

  alias Autonoma.{Handler, HMAC, Refs}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  # Fake SQL executor that returns canned introspection results
  defp fake_executor do
    fn
      :query, sql, _params ->
        sql_lower = String.downcase(sql) |> String.trim()

        cond do
          String.starts_with?(sql_lower, "select table_name") ->
            [%{"table_name" => "user"}]

          String.contains?(sql_lower, "column_name") ->
            [
              %{
                "table_name" => "user",
                "column_name" => "id",
                "data_type" => "uuid",
                "udt_name" => "uuid",
                "is_nullable" => "NO",
                "column_default" => "gen_random_uuid()"
              },
              %{
                "table_name" => "user",
                "column_name" => "email",
                "data_type" => "character varying",
                "udt_name" => "varchar",
                "is_nullable" => "NO",
                "column_default" => nil
              }
            ]

          String.contains?(sql_lower, "pg_type") or String.contains?(sql_lower, "enum") ->
            []

          String.contains?(sql_lower, "tc.constraint_type = 'foreign key'") or
              String.contains?(sql_lower, "foreign key") ->
            []

          String.starts_with?(sql_lower, "insert") ->
            [%{"id" => "user-1", "email" => "test@test.com"}]

          String.starts_with?(sql_lower, "delete") ->
            []

          true ->
            []
        end

      :transaction, fun, _opts ->
        tx = fn :query, sql, params ->
          fake_executor().(:query, sql, params)
        end

        fun.(tx)
    end
  end

  defp make_config do
    %{
      executor: fake_executor(),
      scope_field: "organizationId",
      shared_secret: @shared_secret,
      signing_secret: @signing_secret,
      auth: fn user, _ctx ->
        user_id = if user, do: user["id"], else: "anon"
        %{"headers" => %{"Authorization" => "Bearer test-token-#{user_id}"}}
      end
    }
  end

  defp signed_req(body_map) do
    body = Jason.encode!(body_map)
    %{body: body, headers: %{"x-signature" => HMAC.sign_body(body, @shared_secret)}}
  end

  # --- Executor-based tests ---

  test "discover via executor" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "discover"}))
    assert result.status == 200
    assert is_list(result.body["schema"]["models"])
    assert result.body["sdk"]["language"] == "elixir"
  end

  test "down via executor" do
    token = Refs.sign(
      %{"refs" => %{"User" => [%{"id" => "u1"}]}, "testRunId" => "test-run-1", "environment" => "test"},
      @signing_secret
    )

    result = Handler.handle(make_config(), signed_req(%{"action" => "down", "refsToken" => token}))
    assert result.status == 200
    assert result.body["ok"] == true
  end

  # --- Error handling tests ---

  test "rejects same secrets" do
    config = %{shared_secret: "same", signing_secret: "same"}
    result = Handler.handle(config, signed_req(%{"action" => "discover"}))
    assert result.status == 500
    assert result.body["code"] == "SAME_SECRETS"
  end

  test "rejects invalid signature" do
    body = Jason.encode!(%{"action" => "discover"})
    req = %{body: body, headers: %{"x-signature" => "bad"}}
    result = Handler.handle(make_config(), req)
    assert result.status == 401
    assert result.body["code"] == "INVALID_SIGNATURE"
  end

  test "rejects invalid JSON" do
    raw = "not json"
    req = %{body: raw, headers: %{"x-signature" => HMAC.sign_body(raw, @shared_secret)}}
    result = Handler.handle(make_config(), req)
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  test "rejects unknown action" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "unknown"}))
    assert result.status == 400
    assert result.body["code"] == "UNKNOWN_ACTION"
  end

  test "rejects missing action" do
    result = Handler.handle(make_config(), signed_req(%{"foo" => "bar"}))
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  # --- Production gate tests ---

  defp with_env(vars, fun) do
    previous =
      for {k, _v} <- vars, into: %{} do
        {k, System.get_env(k)}
      end

    for {k, v} <- vars do
      if is_nil(v), do: System.delete_env(k), else: System.put_env(k, v)
    end

    try do
      fun.()
    after
      for {k, v} <- previous do
        if is_nil(v), do: System.delete_env(k), else: System.put_env(k, v)
      end
    end
  end

  test "blocks production when not allowed" do
    with_env(%{"MIX_ENV" => "prod", "AUTONOMA_ENABLED" => nil}, fn ->
      result = Handler.handle(make_config(), signed_req(%{"action" => "discover"}))
      assert result.status == 404
      assert result.body["code"] == "PRODUCTION_BLOCKED"
    end)
  end

  test "AUTONOMA_ENABLED=1 overrides production block" do
    with_env(%{"MIX_ENV" => "prod", "AUTONOMA_ENABLED" => "1"}, fn ->
      result = Handler.handle(make_config(), signed_req(%{"action" => "discover"}))
      assert result.status == 200
    end)
  end

  test "AUTONOMA_ENABLED=0 does not override production block" do
    with_env(%{"MIX_ENV" => "prod", "AUTONOMA_ENABLED" => "0"}, fn ->
      result = Handler.handle(make_config(), signed_req(%{"action" => "discover"}))
      assert result.status == 404
      assert result.body["code"] == "PRODUCTION_BLOCKED"
    end)
  end

  # --- Handler hook tests ---

  test "after_up hook modifies auth result" do
    config =
      Map.put(make_config(), :after_up, fn _ctx, auth ->
        Map.put(auth, "headers", Map.merge(auth["headers"] || %{}, %{"X-Custom" => "enriched"}))
      end)

    req =
      signed_req(%{
        "action" => "up",
        "create" => %{"User" => [%{"email" => "test@test.com"}]},
        "testRunId" => "run-1"
      })

    result = Handler.handle(config, req)
    assert result.status == 200
    assert result.body["auth"]["headers"]["X-Custom"] == "enriched"
  end

  test "before_down hook is called" do
    self = self()

    config =
      Map.put(make_config(), :before_down, fn ctx ->
        send(self, {:before_down_called, ctx})
      end)

    token =
      Refs.sign(
        %{"refs" => %{"User" => [%{"id" => "u1"}]}, "testRunId" => "run-1", "environment" => ""},
        @signing_secret
      )

    req = signed_req(%{"action" => "down", "refsToken" => token})
    result = Handler.handle(config, req)
    assert result.status == 200
    assert_receive {:before_down_called, ctx}
    assert is_map(ctx)
    assert is_map(ctx.refs)
  end
end
