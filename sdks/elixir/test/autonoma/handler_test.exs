defmodule Autonoma.HandlerTest do
  use ExUnit.Case, async: true

  alias Autonoma.{Handler, HMAC, Refs}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  # Legacy adapter-based config
  defp make_legacy_config do
    adapter = %{
      name: "fake",
      get_schema: fn ->
        %{
          "models" => [
            %{"name" => "User", "fields" => [
              %{"name" => "id", "type" => "string", "isRequired" => true, "isId" => true, "hasDefault" => true}
            ]}
          ],
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

  defp signed_req(body_map) do
    body = Jason.encode!(body_map)
    %{body: body, headers: %{"x-signature" => HMAC.sign_body(body, @shared_secret)}}
  end

  # --- Legacy adapter tests ---

  test "discover via legacy adapter" do
    result = Handler.handle(make_legacy_config(), signed_req(%{"action" => "discover"}))
    assert result.status == 200
    assert is_list(result.body["schema"]["models"])
    assert result.body["sdk"]["language"] == "elixir"
  end

  test "up via legacy adapter" do
    result = Handler.handle(
      make_legacy_config(),
      signed_req(%{"action" => "up", "create" => %{"User" => %{"fields" => [%{"id" => "u1"}]}}})
    )
    assert result.status == 200
    assert is_map(result.body["refs"])
    assert is_binary(result.body["refsToken"])
  end

  test "down via legacy adapter" do
    token = Refs.sign(
      %{"refs" => %{"User" => [%{"id" => "u1"}]}, "testRunId" => "test-run-1", "environment" => "test"},
      @signing_secret
    )

    result = Handler.handle(make_legacy_config(), signed_req(%{"action" => "down", "refsToken" => token}))
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
    result = Handler.handle(make_legacy_config(), req)
    assert result.status == 401
    assert result.body["code"] == "INVALID_SIGNATURE"
  end

  test "rejects invalid JSON" do
    raw = "not json"
    req = %{body: raw, headers: %{"x-signature" => HMAC.sign_body(raw, @shared_secret)}}
    result = Handler.handle(make_legacy_config(), req)
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end

  test "rejects unknown action" do
    result = Handler.handle(make_legacy_config(), signed_req(%{"action" => "unknown"}))
    assert result.status == 400
    assert result.body["code"] == "UNKNOWN_ACTION"
  end

  test "rejects missing action" do
    result = Handler.handle(make_legacy_config(), signed_req(%{"foo" => "bar"}))
    assert result.status == 400
    assert result.body["code"] == "INVALID_BODY"
  end
end
