defmodule Autonoma.Plug.HandlerTest do
  use ExUnit.Case, async: true
  import Plug.Test
  import Plug.Conn

  alias Autonoma.{HMAC, Refs}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  defp fake_executor do
    fn
      :query, sql, _params ->
        sql_lower = String.downcase(sql) |> String.trim()

        cond do
          String.starts_with?(sql_lower, "select table_name") ->
            [%{"table_name" => "user"}]

          String.contains?(sql_lower, "column_name") ->
            [
              %{"table_name" => "user", "column_name" => "id", "data_type" => "uuid",
                "udt_name" => "uuid", "is_nullable" => "NO", "column_default" => "gen_random_uuid()"},
              %{"table_name" => "user", "column_name" => "email", "data_type" => "character varying",
                "udt_name" => "varchar", "is_nullable" => "NO", "column_default" => nil}
            ]

          String.starts_with?(sql_lower, "insert") ->
            [%{"id" => "user-1", "email" => "test@test.com"}]

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
      auth: fn user ->
        user_id = if user, do: user["id"], else: "anon"
        %{"headers" => %{"Authorization" => "Bearer test-token-#{user_id}"}}
      end
    }
  end

  defp post_action(action, extra \\ %{}) do
    body = Jason.encode!(Map.merge(%{"action" => action}, extra))
    signature = HMAC.sign_body(body, @shared_secret)

    conn(:post, "/", body)
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-signature", signature)
    |> Autonoma.Plug.Handler.call(make_config())
  end

  test "discover returns schema with sdk.server = plug" do
    conn = post_action("discover")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["sdk"]["server"] == "plug"
    assert body["sdk"]["language"] == "elixir"
    assert is_list(body["schema"]["models"])
  end

  test "up returns refs and auth" do
    conn = post_action("up", %{"create" => %{"User" => [%{"id" => "u1"}]}})
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert is_map(body["refs"])
    assert is_binary(body["refsToken"])
    assert is_map(body["auth"])
  end

  test "down tears down" do
    token = Refs.sign(
      %{"refs" => %{"User" => [%{"id" => "u1"}]}, "testRunId" => "test-run-1", "environment" => "test"},
      @signing_secret
    )

    conn = post_action("down", %{"refsToken" => token})
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["ok"] == true
  end

  test "rejects invalid HMAC signature" do
    body = Jason.encode!(%{"action" => "discover"})

    conn =
      conn(:post, "/", body)
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-signature", "bad-signature")
      |> Autonoma.Plug.Handler.call(make_config())

    assert conn.status == 401
  end

  test "rejects invalid JSON" do
    raw = "not json"
    signature = HMAC.sign_body(raw, @shared_secret)

    conn =
      conn(:post, "/", raw)
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-signature", signature)
      |> Autonoma.Plug.Handler.call(make_config())

    assert conn.status == 400
  end
end
