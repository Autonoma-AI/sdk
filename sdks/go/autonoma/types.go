// Package autonoma implements the Autonoma Environment Factory endpoint
// (Scenario v2). A host app registers named scenarios; the platform calls
// discover/up/down over an HMAC-signed HTTP request and the SDK owns the
// envelope: teardown-token signing, expiry defaults, and the protocol
// version field.
package autonoma

// SdkInfo carries SDK metadata echoed on every wire response.
type SdkInfo struct {
	Language string `json:"language"`
	Orm      string `json:"orm"`
	Server   string `json:"server"`
}

// AuthCookie is a single cookie a test runner sets to act as the seeded user.
type AuthCookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	HTTPOnly bool   `json:"httpOnly,omitempty"`
	SameSite string `json:"sameSite,omitempty"`
	Path     string `json:"path,omitempty"`
	Domain   string `json:"domain,omitempty"`
	Secure   bool   `json:"secure,omitempty"`
	MaxAge   int    `json:"maxAge,omitempty"`
}

// AuthResult holds the credentials the test runner uses to act as the seeded
// user. A scenario's Up returns it; the SDK echoes it on up verbatim.
type AuthResult struct {
	Cookies     []AuthCookie      `json:"cookies,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Credentials map[string]string `json:"credentials,omitempty"`
}

// HandlerConfig configures the Autonoma request handler.
type HandlerConfig struct {
	// SharedSecret is known by both you and Autonoma; it verifies HMAC signatures.
	SharedSecret string
	// SigningSecret is private to you; it signs the teardown token.
	SigningSecret string
	// Scenarios lists every scenario the platform can run.
	Scenarios []ScenarioDefinition
	// ExpiresInSeconds is the token/environment lifetime returned on up as
	// expiresInSeconds. Defaults to 3600 (one hour) when left zero.
	ExpiresInSeconds int
	// AllowProduction is deprecated and ignored; the endpoint is always enabled
	// and HMAC signing is the gate. Gate it in your handler if you want it dark
	// in your own production deployments.
	AllowProduction bool
	// SDK is optional identity metadata; server adapters populate it.
	SDK *SdkInfo
}

// HandlerRequest represents an incoming HTTP request.
type HandlerRequest struct {
	Body    string
	Headers map[string]string
}

// HandlerResponse represents the HTTP response to send back.
type HandlerResponse struct {
	Status int
	Body   map[string]any
}
