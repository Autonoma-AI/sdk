input = IO.read(:stdio, :eof) |> Jason.decode!()

result =
  try do
    mod = input["module"]
    func = input["function"]
    inp = input["input"]

    value =
      case {mod, func} do
        {"hmac", "signBody"} ->
          Autonoma.HMAC.sign_body(inp["body"], inp["secret"])

        {"hmac", "verifySignature"} ->
          Autonoma.HMAC.verify_signature(inp["body"], inp["signature"], inp["secret"])

        {"refs", "signRefs"} ->
          Autonoma.Refs.sign(inp["payload"], inp["secret"])

        {"refs", "verifyRefs"} ->
          Autonoma.Refs.verify!(inp["token"], inp["secret"])

        _ ->
          raise "Unknown function: #{mod}.#{func}"
      end

    %{"ok" => true, "result" => value}
  rescue
    e -> %{"ok" => false, "error" => Exception.message(e)}
  end

IO.puts(Jason.encode!(result))
