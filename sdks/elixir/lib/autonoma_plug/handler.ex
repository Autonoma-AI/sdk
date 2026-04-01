defmodule Autonoma.Plug.Handler do
  @moduledoc """
  Plug-based HTTP handler for the Autonoma Environment Factory endpoint.
  """

  import Plug.Conn

  def init(opts), do: opts

  def call(conn, config) do
    {:ok, body, conn} = read_body(conn)

    headers =
      conn.req_headers
      |> Enum.into(%{})

    enriched_config = Map.put(config, :sdk_server, "plug")

    result =
      Autonoma.Handler.handle(enriched_config, %{
        body: body,
        headers: headers
      })

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(result.status, Jason.encode!(result.body))
  end
end
