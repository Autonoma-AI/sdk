module autonoma-gin-example

go 1.21

require (
	github.com/autonoma-ai/sdk/sdks/go v0.2.9
	github.com/gin-gonic/gin v1.12.0
	github.com/lib/pq v1.10.9
)

// This example lives inside the SDK monorepo, so it builds against the local
// source. An external project would instead run:
//   go get github.com/autonoma-ai/sdk/sdks/go/autonoma
replace github.com/autonoma-ai/sdk/sdks/go => ../../../sdks/go
