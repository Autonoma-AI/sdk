defmodule Autonoma.Plug.HandlerTest do
  use ExUnit.Case, async: true
  import Plug.Test
  import Plug.Conn

  alias Autonoma.{HMAC, Refs}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  defp make_config do
    adapter = %{
      name: "fake",
      get_schema: fn ->
        %{
          "models" => [%{"name" => "User", "fields" => [%{"name" => "id", "type" => "string", "isRequired" => true, "isId" => true, "hasDefault" => true}]}],
          "edges" => [],
          "relations" => [],
          "scopeField" => "organizationId"
        }
      end,
      create_entities: fn _spec, _ctx -> {:ok, %{"User" => [%{"id" => "user-1"}]}} end,
      teardown: fn _scope, _refs -> :ok end
    }

    %{
      adapter: adapter,
      shared_secret: @shared_secret,
      signing_secret: @signing_secret
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
    conn = post_action("up", %{"create" => %{"User" => %{"fields" => [%{"id" => "u1"}]}}})
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
