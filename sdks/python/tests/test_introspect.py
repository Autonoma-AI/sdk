"""Contract tests for introspect name-derivation behavior.

These tests pin the documented behavior that `_snake_to_pascal` does NOT
pluralize. The Python and TypeScript SDKs both rely on this rule when
auto-deriving model names from SQL table names, and the docs/agent prompts
teach users to populate `table_name_map` sparsely based on it.
"""

from autonoma.introspect import _snake_to_pascal


def test_snake_to_pascal_does_not_pluralize():
    # Singular in → singular out
    assert _snake_to_pascal("user") == "User"
    assert _snake_to_pascal("api_key") == "ApiKey"
    assert _snake_to_pascal("branch_deployment") == "BranchDeployment"

    # Plural in → plural out (no stripping of trailing 's')
    assert _snake_to_pascal("organizations") == "Organizations"
    assert _snake_to_pascal("api_keys") == "ApiKeys"
    assert _snake_to_pascal("branch_deployments") == "BranchDeployments"


def test_snake_to_pascal_preserves_multi_segment_casing():
    assert _snake_to_pascal("application_setup") == "ApplicationSetup"
    assert _snake_to_pascal("web_application_data") == "WebApplicationData"


def test_snake_to_pascal_handles_empty_and_trailing_underscore():
    assert _snake_to_pascal("") == ""
    assert _snake_to_pascal("user_") == "User"
    assert _snake_to_pascal("_user") == "User"
