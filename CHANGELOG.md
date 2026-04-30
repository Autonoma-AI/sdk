# Changelog

## [0.2.2](https://github.com/Autonoma-AI/sdk/compare/v0.2.1...v0.2.2) (2026-04-30)


### Bug Fixes

* use workflow_call instead of workflow_dispatch for publish ([1bb2b5e](https://github.com/Autonoma-AI/sdk/commit/1bb2b5e33db9d31019fef634c6d65c61be0cbca9))

## [0.2.1](https://github.com/Autonoma-AI/sdk/compare/v0.2.0...v0.2.1) (2026-04-30)


### Features

* factory-driven SDK redesign — all 8 languages ([#50](https://github.com/Autonoma-AI/sdk/issues/50)) ([109c88e](https://github.com/Autonoma-AI/sdk/commit/109c88e46295d7df4fcc0cb048b0f7e66f73aed5))


### Bug Fixes

* unblock 0.2.0 PyPI/Hex + make publish idempotent ([#47](https://github.com/Autonoma-AI/sdk/issues/47)) ([bbfed39](https://github.com/Autonoma-AI/sdk/commit/bbfed39191215cce58956524f61e769545a65521))

## [0.2.0](https://github.com/Autonoma-AI/sdk/compare/v0.1.13...v0.2.0) (2026-04-23)


### Features

* hybrid factory + SQL fallback for entity creation ([#44](https://github.com/Autonoma-AI/sdk/issues/44)) ([d91782f](https://github.com/Autonoma-AI/sdk/commit/d91782f879f6299534c605a05745a39ae3c63ca5))


### Miscellaneous Chores

* release 0.2.0 ([4c64507](https://github.com/Autonoma-AI/sdk/commit/4c64507c0fc764c0f6991680a7d3e8727ac9a710))

## [0.1.13](https://github.com/Autonoma-AI/sdk/compare/v0.1.12...v0.1.13) (2026-04-14)


### Features

* add hono implementation sdk ([#40](https://github.com/Autonoma-AI/sdk/issues/40)) ([ff81811](https://github.com/Autonoma-AI/sdk/commit/ff81811e6ca5fd31a50ac496a349d8aadd1d04bc))


### Bug Fixes

* pnpm lock file ([#42](https://github.com/Autonoma-AI/sdk/issues/42)) ([2bec029](https://github.com/Autonoma-AI/sdk/commit/2bec029008dc7868337fda3d69c4fa8118c89738))

## [0.1.12](https://github.com/Autonoma-AI/sdk/compare/v0.1.11...v0.1.12) (2026-04-14)


### Features

* add beforeDown/afterUp handler hooks across all SDKs ([#37](https://github.com/Autonoma-AI/sdk/issues/37)) ([06e7ea2](https://github.com/Autonoma-AI/sdk/commit/06e7ea210ae6371283a531dbae3b70061f23fe08))
* enrich auth callback with context (scope_value, refs) across all SDKs ([#36](https://github.com/Autonoma-AI/sdk/issues/36)) ([df33dd2](https://github.com/Autonoma-AI/sdk/commit/df33dd2b977d021e2efff599fdc05665d95d0f9c))
* support per-request executor in FastAPI adapter ([#35](https://github.com/Autonoma-AI/sdk/issues/35)) ([d898e69](https://github.com/Autonoma-AI/sdk/commit/d898e69133167e7303d3bdaccadb0953fb610f10))


### Bug Fixes

* composite PK identity and teardown cycle ordering ([#33](https://github.com/Autonoma-AI/sdk/issues/33)) ([63ff5d5](https://github.com/Autonoma-AI/sdk/commit/63ff5d5fa52e281ec6f41b63cb2623e30c793b28))
* remove legacy OrmAdapter code from Python and Elixir SDKs ([#29](https://github.com/Autonoma-AI/sdk/issues/29)) ([ee7a940](https://github.com/Autonoma-AI/sdk/commit/ee7a940a3afc9614e68fa8560dbe38065aa61e25))
* use custom JSON serializer for response bodies across server adapters ([#38](https://github.com/Autonoma-AI/sdk/issues/38)) ([08d967b](https://github.com/Autonoma-AI/sdk/commit/08d967bc98b93a4692b2a9597f6b03bc1f1ad7ed))

## [0.1.11](https://github.com/Autonoma-AI/sdk/compare/v0.1.10...v0.1.11) (2026-04-10)


### Bug Fixes

* stop stripping PK field ([#30](https://github.com/Autonoma-AI/sdk/issues/30)) ([a75809a](https://github.com/Autonoma-AI/sdk/commit/a75809ac939cbb45495829f1bb5a2fbc6ba09f3c))

## [0.1.10](https://github.com/Autonoma-AI/sdk/compare/v0.1.9...v0.1.10) (2026-04-10)


### Bug Fixes

* auto-trigger publish on release and add LICENSE to all SDKs ([#27](https://github.com/Autonoma-AI/sdk/issues/27)) ([a844216](https://github.com/Autonoma-AI/sdk/commit/a844216af92a019069968d31c17e6d2672c83c98))

## [0.1.9](https://github.com/Autonoma-AI/sdk/compare/v0.1.8...v0.1.9) (2026-04-10)


### Bug Fixes

* cross-SDK bugs (integer PKs, custom PK names, arrays, teardown, refs, user matching) ([#25](https://github.com/Autonoma-AI/sdk/issues/25)) ([55d8e65](https://github.com/Autonoma-AI/sdk/commit/55d8e651b607c74b3c79999949791dc61ce0a5b7))

## [0.1.8](https://github.com/Autonoma-AI/sdk/compare/v0.1.7...v0.1.8) (2026-04-10)


### Bug Fixes

* remove stale CLI and template resolution from all SDKs ([#23](https://github.com/Autonoma-AI/sdk/issues/23)) ([635a99a](https://github.com/Autonoma-AI/sdk/commit/635a99af20eed7ea1983566130485f432252e3f2))

## [0.1.7](https://github.com/Autonoma-AI/sdk/compare/v0.1.6...v0.1.7) (2026-04-09)


### Features

* add Rust SDK with Actix Web server adapter ([#18](https://github.com/Autonoma-AI/sdk/issues/18)) ([3cb2476](https://github.com/Autonoma-AI/sdk/commit/3cb2476311c9b90f6670ee132a37fbacc03dba54))


### Bug Fixes

* cross-SDK bugs from review (batch, refs, tinyint, cache, regex) ([#21](https://github.com/Autonoma-AI/sdk/issues/21)) ([7c3804c](https://github.com/Autonoma-AI/sdk/commit/7c3804c892eecfafbd4f8e4b06acb479d0e80ab0))

## [0.1.6](https://github.com/Autonoma-AI/sdk/compare/v0.1.5...v0.1.6) (2026-04-09)


### Features

* add Go SDK with Gin server adapter ([#14](https://github.com/Autonoma-AI/sdk/issues/14)) ([38704b3](https://github.com/Autonoma-AI/sdk/commit/38704b3fd0d4bf3c4da0a0b95789bc9504343b12))
* add PHP/Laravel SDK ([#8](https://github.com/Autonoma-AI/sdk/issues/8)) ([687a22c](https://github.com/Autonoma-AI/sdk/commit/687a22c6ecc69bf6d54a4ee54b45f393e71a0e42))

## [0.1.5](https://github.com/Autonoma-AI/sdk/compare/v0.1.4...v0.1.5) (2026-04-09)


### Features

* add Java SDK with Spring Boot server adapter ([#7](https://github.com/Autonoma-AI/sdk/issues/7)) ([2d6bcbb](https://github.com/Autonoma-AI/sdk/commit/2d6bcbbfe21ca08cc164fbfe6c50c79d9a49328f))

## [0.1.4](https://github.com/Autonoma-AI/sdk/compare/v0.1.3...v0.1.4) (2026-04-08)


### Features

* add Ruby SDK with ActiveRecord/Rails adapters ([#6](https://github.com/Autonoma-AI/sdk/issues/6)) ([6e3dafb](https://github.com/Autonoma-AI/sdk/commit/6e3dafb07f583e4e00a08b0e5d3534febf4ef576))
* expose tableName on each model in discover response ([#9](https://github.com/Autonoma-AI/sdk/issues/9)) ([86f40a1](https://github.com/Autonoma-AI/sdk/commit/86f40a1aaa12a89ca965fc2c7666cdef7f28abd6))
* make auth callback required and support cookies/headers/credentials ([#15](https://github.com/Autonoma-AI/sdk/issues/15)) ([4c2be70](https://github.com/Autonoma-AI/sdk/commit/4c2be70a63b19200aed6821ad4a85fb376eb712b))
* SQL-first architecture with PostgreSQL/MySQL support ([#4](https://github.com/Autonoma-AI/sdk/issues/4)) ([3bab121](https://github.com/Autonoma-AI/sdk/commit/3bab12116a9cbf2f191b3919538d13e737d3a917))
* support circular FKs better ([a73d678](https://github.com/Autonoma-AI/sdk/commit/a73d678d0f7c987e8030bdb2860540f6754d90d0))


### Bug Fixes

* add delay before publishing other packages ([228423e](https://github.com/Autonoma-AI/sdk/commit/228423e5dd30c878f61ea73bb9840727d40d28d1))
* guard publish workflow to only run for tags on main ([#13](https://github.com/Autonoma-AI/sdk/issues/13)) ([29733ad](https://github.com/Autonoma-AI/sdk/commit/29733ad8271cf565df6a645a33fc3da4ff351051))
* pass GITHUB_TOKEN to release-please action ([#16](https://github.com/Autonoma-AI/sdk/issues/16)) ([b19611a](https://github.com/Autonoma-AI/sdk/commit/b19611a7f8e36b90b23850d5f6d2dd4f467cd346))
* publish sdk before dependents ([538107f](https://github.com/Autonoma-AI/sdk/commit/538107f8882bcd4b0ce0f03502a5edeebbe97af7))
* reorganized docs ([#2](https://github.com/Autonoma-AI/sdk/issues/2)) ([64abbec](https://github.com/Autonoma-AI/sdk/commit/64abbecd4c67ba8864de3789de873865351e203c))
* tests in github ([#1](https://github.com/Autonoma-AI/sdk/issues/1)) ([884d2b6](https://github.com/Autonoma-AI/sdk/commit/884d2b6a3293f26ab3158f42b2c665c5e62c44ab))
* updated docs to match autonoma-ai instead of autonoma ([e2985e0](https://github.com/Autonoma-AI/sdk/commit/e2985e0d8653dcef4eb671e97380889f16659775))
* use generic type for elixir mix.exs in release-please config ([#11](https://github.com/Autonoma-AI/sdk/issues/11)) ([a8a643c](https://github.com/Autonoma-AI/sdk/commit/a8a643cec579a4fd55ed8fa1bd9bc67a21869ba7))
