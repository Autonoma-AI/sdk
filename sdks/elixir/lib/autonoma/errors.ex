defmodule Autonoma.Error do
  @moduledoc "Structured error for Autonoma protocol responses."

  defexception [:message, :code, :status]

  @type t :: %__MODULE__{
          message: String.t(),
          code: String.t(),
          status: integer()
        }

  def invalid_signature do
    %__MODULE__{message: "Invalid signature", code: "INVALID_SIGNATURE", status: 401}
  end

  def invalid_body(detail) do
    %__MODULE__{message: "Invalid body: #{detail}", code: "INVALID_BODY", status: 400}
  end

  def unknown_action(action) do
    %__MODULE__{message: "Unknown action: #{action}", code: "UNKNOWN_ACTION", status: 400}
  end

  def production_blocked do
    %__MODULE__{message: "Environment factory is disabled", code: "PRODUCTION_BLOCKED", status: 404}
  end

  def invalid_refs_token(detail) do
    %__MODULE__{message: "Invalid refs token: #{detail}", code: "INVALID_REFS_TOKEN", status: 403}
  end

  def factory_missing_pk(model, pk_field) do
    %__MODULE__{
      message: "Factory for \"#{model}\" must return a record with \"#{pk_field}\"",
      code: "FACTORY_MISSING_PK",
      status: 500
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
