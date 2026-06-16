defmodule Autonoma.HandlerTest do
  use ExUnit.Case, async: true

  alias Autonoma.{Handler, HMAC, Refs, Factory}

  @shared_secret "test-shared-secret-1234"
  @signing_secret "test-signing-secret-5678"

  defp user_factory do
    Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "user-#{data["email"]}", "email" => data["email"]}
      end,
      input_fields: [
        %{name: "email", type: :string, required: true}
      ],
      teardown: fn _record, _ctx -> :ok end
    })
  end

  defp org_factory do
    Factory.define_factory(%{
      create: fn data, _ctx ->
        %{"id" => "org-#{data["name"]}", "name" => data["name"]}
      end,
      input_fields: [
        %{name: "name", type: :string, required: true}
      ],
      teardown: fn _record, _ctx -> :ok end
    })
  end

  defp make_config(overrides \\ %{}) do
    Map.merge(
      %{
        scope_field: "organizationId",
        shared_secret: @shared_secret,
        signing_secret: @signing_secret,
        allow_production: true,
        factories: %{"User" => user_factory()},
        auth: fn user, _ctx ->
          user_id = if user, do: user["id"], else: "anon"
          %{"headers" => %{"Authorization" => "Bearer test-token-#{user_id}"}}
        end
      },
      overrides
    )
  end

  defp signed_req(body_map) do
    body = Jason.encode!(body_map)
    %{body: body, headers: %{"x-signature" => HMAC.sign_body(body, @shared_secret)}}
  end

  # --- Discover tests ---

  test "discover returns schema from factories" do
    result = Handler.handle(make_config(), signed_req(%{"action" => "discover"}))
    assert result.status == 200
    assert is_list(result.body["schema"]["models"])
    assert result.body["sdk"]["language"] == "elixir"

    user_model = Enum.find(result.body["schema"]["models"], fn m -> m["name"] == "User" end)
    assert user_model != nil
    assert Enum.any?(user_model["fields"], fn f -> f["name"] == "email" end)
  end

  # --- Up tests ---

  test "up creates entities via factory" do
    result =
      Handler.handle(
        make_config(),
        signed_req(%{
          "action" => "up",
          "create" => %{"User" => [%{"email" => "test@test.com"}]},
          "testRunId" => "run-1"
        })
      )

    assert result.status == 200
    assert result.body["refs"]["User"] |> List.first() |> Map.get("id") == "user-test@test.com"
    assert is_binary(result.body["refsToken"])
    assert is_map(result.body["auth"])
  end

  test "up resolves _alias/_ref dependencies" do
    test_pid = self()

    user_factory_with_tracking =
      Factory.define_factory(%{
        create: fn data, _ctx ->
          send(test_pid, {:user_data, data})
          %{"id" => "user-1", "email" => data["email"], "organizationId" => data["organizationId"]}
        end,
        input_fields: [
          %{name: "email", type: :string, required: true},
          %{name: "organizationId", type: :string, required: true}
        ]
      })

    config =
      make_config(%{
        factories: %{
          "Organization" => org_factory(),
          "User" => user_factory_with_tracking
        }
      })

    result =
      Handler.handle(
        config,
        signed_req(%{
          "action" => "up",
          "create" => %{
            "Organization" => [%{"_alias" => "org1", "name" => "TestOrg"}],
            "User" => [%{"email" => "a@b.com", "organizationId" => %{"_ref" => "org1"}}]
          },
          "testRunId" => "run-ref"
        })
      )

    assert result.status == 200
    assert_receive {:user_data, data}
    # The User factory should receive the real org ID, not __temp_Organization_0
    assert data["organizationId"] == "org-TestOrg"
  end

  # --- Down tests ---

  test "down tears down via factory" do
    config = make_config()

    # First create
    up_result =
      Handler.handle(
        config,
        signed_req(%{
          "action" => "up",
          "create" => %{"User" => [%{"email" => "td@test.com"}]},
          "testRunId" => "run-down"
        })
      )

    assert up_result.status == 200
    refs_token = up_result.body["refsToken"]

    # Then teardown
    down_result =
      Handler.handle(config, signed_req(%{"action" => "down", "refsToken" => refs_token}))

    assert down_result.status == 200
    assert down_result.body["ok"] == true
  end

  test "down skips models without teardown" do
    factory_no_teardown =
      Factory.define_factory(%{
        create: fn data, _ctx ->
          %{"id" => "u1", "email" => data["email"]}
        end,
        input_fields: [%{name: "email", type: :string, required: true}]
      })

    config = make_config(%{factories: %{"User" => factory_no_teardown}})

    token =
      Refs.sign(
        %{
          "refs" => %{"User" => [%{"id" => "u1"}]},
          "testRunId" => "test-run-1",
          "environment" => ""
        },
        @signing_secret
      )

    result =
      Handler.handle(config, signed_req(%{"action" => "down", "refsToken" => token}))

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

  test "blocks when allow_production is absent (PRODUCTION_BLOCKED)" do
    config = make_config() |> Map.delete(:allow_production)
    result = Handler.handle(config, signed_req(%{"action" => "discover"}))
    assert result.status == 404
    assert result.body["code"] == "PRODUCTION_BLOCKED"
  end

  test "blocks when allow_production is false (PRODUCTION_BLOCKED)" do
    config = make_config(%{allow_production: false})
    result = Handler.handle(config, signed_req(%{"action" => "discover"}))
    assert result.status == 404
    assert result.body["code"] == "PRODUCTION_BLOCKED"
  end

  test "operates normally when allow_production is true" do
    config = make_config(%{allow_production: true})
    result = Handler.handle(config, signed_req(%{"action" => "discover"}))
    assert result.status == 200
    assert is_list(result.body["schema"]["models"])
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

  test "errors when factory does not return id (FACTORY_MISSING_PK)" do
    bad_factory =
      Factory.define_factory(%{
        create: fn data, _ctx ->
          %{"name" => data["name"]}
        end,
        input_fields: [%{name: "name", type: :string, required: true}]
      })

    config = make_config(%{factories: %{"Organization" => bad_factory}})

    result =
      Handler.handle(
        config,
        signed_req(%{
          "action" => "up",
          "create" => %{"Organization" => [%{"name" => "NoPK"}]},
          "testRunId" => "run-nopk"
        })
      )

    assert result.status == 500
    assert result.body["code"] == "FACTORY_MISSING_PK"
  end

  # --- Handler hook tests ---

  test "after_up hook modifies auth result" do
    config =
      Map.put(make_config(), :after_up, fn _ctx, auth ->
        Map.put(auth, "headers", Map.merge(auth["headers"] || %{}, %{"X-Custom" => "enriched"}))
      end)

    result =
      Handler.handle(
        config,
        signed_req(%{
          "action" => "up",
          "create" => %{"User" => [%{"email" => "test@test.com"}]},
          "testRunId" => "run-1"
        })
      )

    assert result.status == 200
    assert result.body["auth"]["headers"]["X-Custom"] == "enriched"
  end

  test "before_down hook is called" do
    self_pid = self()

    config =
      Map.put(make_config(), :before_down, fn ctx ->
        send(self_pid, {:before_down_called, ctx})
      end)

    token =
      Refs.sign(
        %{
          "refs" => %{"User" => [%{"id" => "u1"}]},
          "testRunId" => "run-1",
          "environment" => ""
        },
        @signing_secret
      )

    result =
      Handler.handle(config, signed_req(%{"action" => "down", "refsToken" => token}))

    assert result.status == 200
    assert_receive {:before_down_called, ctx}
    assert is_map(ctx)
    assert is_map(ctx.refs)
  end

  test "factory teardown is called per record in reverse order" do
    test_pid = self()

    factory =
      Factory.define_factory(%{
        create: fn data, _ctx ->
          %{"id" => "org-#{data["name"]}", "name" => data["name"]}
        end,
        input_fields: [%{name: "name", type: :string, required: true}],
        teardown: fn record, _ctx ->
          send(test_pid, {:teardown_called, record["id"]})
        end
      })

    config = make_config(%{factories: %{"Organization" => factory}})

    up_result =
      Handler.handle(
        config,
        signed_req(%{
          "action" => "up",
          "create" => %{"Organization" => [%{"name" => "A"}, %{"name" => "B"}]},
          "testRunId" => "run-teardown"
        })
      )

    assert up_result.status == 200
    refs_token = up_result.body["refsToken"]

    down_result =
      Handler.handle(config, signed_req(%{"action" => "down", "refsToken" => refs_token}))

    assert down_result.status == 200

    assert_receive {:teardown_called, id1}
    assert_receive {:teardown_called, id2}
    assert id1 == "org-B"
    assert id2 == "org-A"
  end

  test "factory context contains refs of previously created models" do
    test_pid = self()

    user_factory_with_ctx =
      Factory.define_factory(%{
        create: fn data, ctx ->
          send(test_pid, {:user_ctx, ctx})
          %{"id" => "user-ctx", "email" => data["email"], "organizationId" => data["organizationId"]}
        end,
        input_fields: [
          %{name: "email", type: :string, required: true},
          %{name: "organizationId", type: :string, required: true}
        ]
      })

    config =
      make_config(%{
        factories: %{
          "Organization" => org_factory(),
          "User" => user_factory_with_ctx
        }
      })

    Handler.handle(
      config,
      signed_req(%{
        "action" => "up",
        "create" => %{
          "Organization" => [%{"_alias" => "org1", "name" => "Org"}],
          "User" => [%{"email" => "x@y.com", "organizationId" => %{"_ref" => "org1"}}]
        },
        "testRunId" => "run-ctx"
      })
    )

    assert_receive {:user_ctx, ctx}
    assert is_map(ctx.refs)
    assert Map.has_key?(ctx.refs, "Organization")
    assert length(ctx.refs["Organization"]) == 1
    assert List.first(ctx.refs["Organization"])["id"] == "org-Org"
    assert ctx.test_run_id == "run-ctx"
  end
end
