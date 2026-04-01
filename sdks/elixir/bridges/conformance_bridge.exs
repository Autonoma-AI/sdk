input = IO.read(:stdio, :eof) |> Jason.decode!()

result =
  try do
    mod = input["module"]
    func = input["function"]
    inp = input["input"]

    value =
      case {mod, func} do
        {"graph", "topoSort"} ->
          Autonoma.Graph.topo_sort(inp["nodes"], inp["edges"])

        {"graph", "findDeferrableEdge"} ->
          Autonoma.Graph.find_deferrable_edge(inp["cycle"], inp["edges"])

        {"hmac", "signBody"} ->
          Autonoma.HMAC.sign_body(inp["body"], inp["secret"])

        {"hmac", "verifySignature"} ->
          Autonoma.HMAC.verify_signature(inp["body"], inp["signature"], inp["secret"])

        {"refs", "signRefs"} ->
          Autonoma.Refs.sign(inp["payload"], inp["secret"])

        {"refs", "verifyRefs"} ->
          Autonoma.Refs.verify!(inp["token"], inp["secret"])

        {"fingerprint", "fingerprint"} ->
          Autonoma.Fingerprint.compute(inp["value"])

        {"template", "resolveTemplate"} ->
          Autonoma.Template.resolve(inp["value"], inp["ctx"])

        _ ->
          raise "Unknown function: #{mod}.#{func}"
      end

    %{"ok" => true, "result" => value}
  rescue
    e -> %{"ok" => false, "error" => Exception.message(e)}
  end

IO.puts(Jason.encode!(result))
