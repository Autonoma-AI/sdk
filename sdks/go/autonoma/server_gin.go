package autonoma

import (
	"io"
	"strings"

	"github.com/gin-gonic/gin"
)

// GinHandler creates a gin.HandlerFunc that handles the Autonoma protocol.
//
// Usage:
//
//	config := &autonoma.HandlerConfig{...}
//	router.POST("/api/autonoma", autonoma.GinHandler(config))
func GinHandler(config *HandlerConfig) gin.HandlerFunc {
	enrichedConfig := *config
	if enrichedConfig.SDK == nil {
		enrichedConfig.SDK = &SdkInfo{}
	}
	enrichedConfig.SDK.Server = "gin"

	return func(c *gin.Context) {
		bodyBytes, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(500, gin.H{"error": "failed to read request body", "code": "INTERNAL_ERROR"})
			return
		}

		headers := make(map[string]string, len(c.Request.Header))
		for key, vals := range c.Request.Header {
			if len(vals) > 0 {
				headers[strings.ToLower(key)] = vals[0]
			}
		}

		req := HandlerRequest{
			Body:    string(bodyBytes),
			Headers: headers,
		}

		result := HandleRequest(&enrichedConfig, req)
		c.JSON(result.Status, result.Body)
	}
}
