defmodule Autonoma.Error do
  @moduledoc "Structured error carried across the wire with a stable code and HTTP status."

  defexception [:message, :code, :status]

  @type t :: %__MODULE__{
          message: String.t(),
          code: String.t(),
          status: integer()
        }

  def invalid_signature do
    %__MODULE__{message: "Invalid HMAC signature", code: "INVALID_SIGNATURE", status: 401}
  end

  def invalid_body(detail) do
    %__MODULE__{message: "Invalid request body: #{detail}", code: "INVALID_BODY", status: 400}
  end

  def unknown_action(action) do
    %__MODULE__{message: "Unknown action: #{action}", code: "UNKNOWN_ACTION", status: 400}
  end

  @doc "Raised by `up` when the request names a scenario that is not registered."
  def unknown_environment(name) do
    %__MODULE__{message: "Unknown environment: #{name}", code: "UNKNOWN_ENVIRONMENT", status: 400}
  end

  def invalid_teardown_token(detail) do
    %__MODULE__{message: "Invalid teardown token: #{detail}", code: "INVALID_TEARDOWN_TOKEN", status: 403}
  end

  @deprecated "The SDK no longer gates on production; this error is never returned."
  def production_blocked do
    %__MODULE__{
      message: "Environment factory is disabled",
      code: "PRODUCTION_BLOCKED",
      status: 404
    }
  end

  def same_secrets do
    %__MODULE__{
      message:
        "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
      code: "SAME_SECRETS",
      status: 500
    }
  end
end
