import sys
import json
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from autonoma.hmac_util import sign_body, verify_signature
from autonoma.refs import sign_refs, verify_refs

data = json.loads(sys.stdin.read())

try:
    mod = data["module"]
    fn = data["function"]
    inp = data["input"]

    dispatch = {
        ("hmac", "signBody"): lambda: sign_body(inp["body"], inp["secret"]),
        ("hmac", "verifySignature"): lambda: verify_signature(inp["body"], inp["signature"], inp["secret"]),
        ("refs", "signRefs"): lambda: sign_refs(inp["payload"], inp["secret"]),
        ("refs", "verifyRefs"): lambda: verify_refs(inp["token"], inp["secret"]),
    }

    result = dispatch[(mod, fn)]()
    print(json.dumps({"ok": True, "result": result}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
