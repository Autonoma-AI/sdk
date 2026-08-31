defmodule Autonoma.Plug.HandlerTest do
  use ExUnit.Case, async: true
  import Plug.Test
  import Plug.Conn

  alias Autonoma.{HMAC, Scenario, Unique}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  defp make_config do
    %{
      shared_secret: @shared_secret,
      signing_secret: @signing_secret,
      scenarios: [
        Scenario.define_scenario(
          name: "standard",
          description: "A standard seeded environment",
          up: fn ctx ->
            %{
              auth: %{"headers" => %{"Authorization" => "Bearer token-#{ctx.test_run_id}"}},
              teardown: %{"userId" => "user-#{ctx.test_run_id}"},
              data: %{"userEmail" => Unique.unique_email(ctx.test_run_id)}
            }
          end,
          down: fn _ctx -> :ok end
        )
      ]
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

  test "discover lists scenarios with sdk.server = plug" do
    conn = post_action("discover")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["sdk"]["server"] == "plug"
    assert body["sdk"]["language"] == "elixir"
    assert List.first(body["scenarios"])["name"] == "standard"
  end

  test "up returns a teardownToken and auth" do
    conn = post_action("up", %{"scenario" => %{"name" => "standard"}, "testRunId" => "run-1"})
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert is_binary(body["teardownToken"])
    assert body["auth"]["headers"]["Authorization"] == "Bearer token-run-1"
    refute Map.has_key?(body, "refsToken")
  end

  test "down tears down with a valid teardownToken" do
    up = post_action("up", %{"scenario" => %{"name" => "standard"}, "testRunId" => "run-td"})
    token = Jason.decode!(up.resp_body)["teardownToken"]

    conn = post_action("down", %{"teardownToken" => token})
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["ok"] == true
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
