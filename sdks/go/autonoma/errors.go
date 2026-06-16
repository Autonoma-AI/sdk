package autonoma

import "fmt"

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

func ErrInvalidRefsToken(reason string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Invalid refs token: %s", reason),
		Code:    "INVALID_REFS_TOKEN",
		Status:  403,
	}
}

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

func ErrFactoryMissingPK(model, pkField string) *AutonomaError {
	return &AutonomaError{
		Message: fmt.Sprintf("Factory for %q must return a record with %q", model, pkField),
		Code:    "FACTORY_MISSING_PK",
		Status:  500,
	}
}

func ErrSameSecrets() *AutonomaError {
	return &AutonomaError{
		Message: "sharedSecret and signingSecret must be different. The shared secret is known by Autonoma; the signing secret must be private.",
		Code:    "SAME_SECRETS",
		Status:  500,
	}
}
