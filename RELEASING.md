# Releasing the SDK

Stable releases are created by Release Please and published from an existing `vX.Y.Z` GitHub release tag. Release pull requests are drafts and require an explicit human merge.

## Scenario v2 first release

Scenario v2 is the `2.0.0` SDK major. The implementation pull request prepares the packages and workflows but does not publish it. When the implementation is approved and merged, ensure its release-preparation commit carries this footer:

```text
Release-As: 2.0.0
```

Release Please will open a draft `2.0.0` release pull request. Review the generated version changes and changelog before deciding whether to merge it.

## Package preflight

Run the **Package preflight** workflow before a release. It builds distributable artifacts for npm, PyPI, Hex, RubyGems, Go, crates.io, Maven Central, and Packagist without publishing anything.

The stable publish workflow refuses manual dispatches unless both an existing `vX.Y.Z` tag and `confirm_publish=true` are supplied. It also verifies that the tag belongs to `main`.

## Required protected environments

| Environment | Required setup |
|-------------|----------------|
| `npm` | `NPM_TOKEN` |
| `pypi` | PyPI trusted publisher for this repository/workflow |
| `hex` | `HEX_API_KEY` |
| `rubygems` | `RUBYGEMS_API_KEY` |
| `go` | Required reviewer approval before creating the public module tag |
| `crates-io` | `CARGO_REGISTRY_TOKEN` |
| `maven-central` | `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_TOKEN`, `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE` |
| `packagist` | `PHP_SPLIT_TOKEN`, an `Autonoma-AI/sdk-php` repository, and its Packagist package linkage |

Go uses the submodule tag `sdks/go/vX.Y.Z` and the module path `github.com/autonoma-ai/sdk/sdks/go/v2`.
