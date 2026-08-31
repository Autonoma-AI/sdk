# Minimal stdlib :gen_tcp server that runs the Elixir SDK's v2 handler with a
# couple of scenarios. Used by run-suites.mjs to exercise the shared
# protocol/suites/* against a real Elixir endpoint. It mirrors
# protocol/servers/ruby-server.rb and php-server.php, calling
# Autonoma.Handler.handle/2 directly.
#
# Run with `mix run <this file>` from sdks/elixir so the compiled Autonoma
# modules and Jason are on the code path. Secrets and PORT come from env.

defmodule ElixirProtocolServer do
  @reason_phrases %{
    200 => "OK",
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    500 => "Internal Server Error"
  }

  def start(config, port) do
    {:ok, socket} =
      :gen_tcp.listen(port, [:binary, packet: :raw, active: false, reuseaddr: true])

    IO.puts("elixir-server listening on #{port}")
    accept_loop(socket, config)
  end

  defp accept_loop(socket, config) do
    case :gen_tcp.accept(socket) do
      {:ok, conn} ->
        handle_conn(conn, config)
        accept_loop(socket, config)

      {:error, _reason} ->
        accept_loop(socket, config)
    end
  end

  defp handle_conn(conn, config) do
    try do
      case read_request(conn) do
        {:ok, headers, body} ->
          result = Autonoma.Handler.handle(config, %{body: body, headers: headers})
          json = Jason.encode!(Autonoma.Refs.sanitize_for_json(result.body))
          write_response(conn, result.status, json)

        :error ->
          :ok
      end
    rescue
      e ->
        IO.puts(:stderr, "elixir-server error: #{Exception.message(e)}")

        write_response(
          conn,
          500,
          Jason.encode!(%{"error" => Exception.message(e), "code" => "INTERNAL_ERROR"})
        )
    after
      :gen_tcp.close(conn)
    end
  end

  # Read the request line + headers, then a body of Content-Length bytes.
  defp read_request(conn) do
    case read_until_headers(conn, "") do
      {:ok, headers_blob, rest} ->
        headers = parse_headers(headers_blob)
        length = content_length(headers)
        already = byte_size(rest)

        body =
          cond do
            length <= 0 -> ""
            already >= length -> binary_part(rest, 0, length)
            true -> rest <> read_n(conn, length - already)
          end

        {:ok, headers, body}

      :error ->
        :error
    end
  end

  defp read_until_headers(conn, acc) do
    case :binary.match(acc, "\r\n\r\n") do
      {pos, _len} ->
        headers_blob = binary_part(acc, 0, pos)
        rest_start = pos + 4
        rest = binary_part(acc, rest_start, byte_size(acc) - rest_start)
        {:ok, headers_blob, rest}

      :nomatch ->
        case :gen_tcp.recv(conn, 0) do
          {:ok, data} -> read_until_headers(conn, acc <> data)
          {:error, _} -> :error
        end
    end
  end

  defp read_n(_conn, n) when n <= 0, do: ""

  defp read_n(conn, n) do
    case :gen_tcp.recv(conn, n) do
      {:ok, data} ->
        got = byte_size(data)
        if got >= n, do: data, else: data <> read_n(conn, n - got)

      {:error, _} ->
        ""
    end
  end

  defp parse_headers(blob) do
    blob
    |> String.split(["\r\n", "\n"])
    |> Enum.drop(1)
    |> Enum.reduce(%{}, fn line, acc ->
      case String.split(line, ":", parts: 2) do
        [key, value] -> Map.put(acc, String.downcase(String.trim(key)), String.trim(value))
        _ -> acc
      end
    end)
  end

  defp content_length(headers) do
    case Map.get(headers, "content-length") do
      nil ->
        0

      value ->
        case Integer.parse(value) do
          {n, _} -> n
          :error -> 0
        end
    end
  end

  defp write_response(conn, status, body_json) do
    reason = Map.get(@reason_phrases, status, "OK")

    head =
      "HTTP/1.1 #{status} #{reason}\r\n" <>
        "Content-Type: application/json\r\n" <>
        "Content-Length: #{byte_size(body_json)}\r\n" <>
        "Connection: close\r\n\r\n"

    :gen_tcp.send(conn, head <> body_json)
  end
end

shared_secret = System.get_env("AUTONOMA_SHARED_SECRET") || "protocol-shared"
signing_secret = System.get_env("AUTONOMA_SIGNING_SECRET") || "protocol-signing"
port = String.to_integer(System.get_env("PORT") || "4592")

config = %{
  shared_secret: shared_secret,
  signing_secret: signing_secret,
  sdk: %{"orm" => "none", "server" => "socket"},
  scenarios: [
    Autonoma.Scenario.define_scenario(
      name: "standard",
      description: "A standard seeded environment",
      up: fn ctx ->
        %{
          auth: %{"headers" => %{"Authorization" => "Bearer token-#{ctx.test_run_id}"}},
          teardown: %{"userId" => "user-#{ctx.test_run_id}"}
        }
      end,
      down: fn _ctx -> :ok end
    ),
    Autonoma.Scenario.define_scenario(
      name: "empty",
      description: "Nothing seeded",
      up: fn _ctx -> %{} end
    )
  ]
}

ElixirProtocolServer.start(config, port)
