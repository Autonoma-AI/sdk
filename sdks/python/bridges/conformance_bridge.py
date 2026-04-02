import sys
import json
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from autonoma.graph import topo_sort, find_deferrable_edge
from autonoma.hmac_util import sign_body, verify_signature
from autonoma.refs import sign_refs, verify_refs
from autonoma.fingerprint import fingerprint
from autonoma.template import resolve_template

data = json.loads(sys.stdin.read())

try:
    mod = data["module"]
    fn = data["function"]
    inp = data["input"]

    dispatch = {
        ("graph", "topoSort"): lambda: topo_sort(inp["nodes"], inp["edges"]),
        ("graph", "findDeferrableEdge"): lambda: find_deferrable_edge(inp["cycle"], inp["edges"]),
        ("hmac", "signBody"): lambda: sign_body(inp["body"], inp["secret"]),
        ("hmac", "verifySignature"): lambda: verify_signature(inp["body"], inp["signature"], inp["secret"]),
        ("refs", "signRefs"): lambda: sign_refs(inp["payload"], inp["secret"]),
        ("refs", "verifyRefs"): lambda: verify_refs(inp["token"], inp["secret"]),
        ("fingerprint", "fingerprint"): lambda: fingerprint(inp["value"]),
        ("template", "resolveTemplate"): lambda: resolve_template(inp["value"], inp["ctx"]),
    }

    result = dispatch[(mod, fn)]()
    print(json.dumps({"ok": True, "result": result}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
