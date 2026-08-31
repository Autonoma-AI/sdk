package autonoma

import "fmt"

// AutonomaError is the base error carried across the wire with a stable code
// and HTTP status.
type AutonomaError struct {
	Message string
	Code    string
	Status  int
}

func (e *AutonomaError) Error() string {
	return e.Message
}

func ErrUnknownAction(action string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Unknown action: %s", action),
		Code:    "UNKNOWN_ACTION",
		Status:  400,
	}
}

// ErrUnknownEnvironment is thrown by up when the request names a scenario that
// is not registered.
func ErrUnknownEnvironment(name string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Unknown environment: %s", name),
		Code:    "UNKNOWN_ENVIRONMENT",
		Status:  400,
	}
}

func ErrInvalidSignature() *AutonomaError {
	return &AutonomaError{
		Message: "Invalid HMAC signature",
		Code:    "INVALID_SIGNATURE",
		Status:  401,
	}
}

func ErrInvalidTeardownToken(reason string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Invalid teardown token: %s", reason),
		Code:    "INVALID_TEARDOWN_TOKEN",
		Status:  403,
	}
}

// ErrProductionBlocked is deprecated: the SDK no longer gates on production, so
// this error is never returned. HMAC signing is the gate.
func ErrProductionBlocked(reason string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Environment factory is disabled. %s", reason),
		Code:    "PRODUCTION_BLOCKED",
		Status:  404,
	}
}

func ErrInvalidBody(reason string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Invalid request body: %s", reason),
		Code:    "INVALID_BODY",
		Status:  400,
	}
}

func ErrSameSecrets() *AutonomaError {
	return &AutonomaError{
		Message: "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
		Code:    "SAME_SECRETS",
		Status:  500,
	}
}
