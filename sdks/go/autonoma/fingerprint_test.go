package autonoma

import "testing"

func TestFingerprint(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  string
	}{
		{
			name:  "object fingerprint",
			value: map[string]any{"name": "test"},
			want:  "7d9fd2051fc32b32",
		},
		{
			name:  "order-independent for object keys",
			value: map[string]any{"z": float64(1), "a": float64(2), "m": float64(3)},
			want:  "ebba85cfdc0a724b",
		},
		{
			name:  "array fingerprint",
			value: []any{float64(1), float64(2), float64(3)},
			want:  "a615eeaee21de517",
		},
		{
			name:  "string fingerprint",
			value: "hello",
			want:  "5aa762ae383fbb72",
		},
		{
			name:  "number fingerprint",
			value: float64(42),
			want:  "73475cb40a568e8d",
		},
		{
			name:  "simple object",
			value: map[string]any{"a": float64(1)},
			want:  "015abd7f5cc57a2d",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Fingerprint(tt.value)
			if got != tt.want {
				t.Errorf("Fingerprint() = %q, want %q", got, tt.want)
			}
			if len(got) != 16 {
				t.Errorf("Fingerprint() length = %d, want 16", len(got))
			}
		})
	}

	t.Run("order-independent pair test", func(t *testing.T) {
		a := Fingerprint(map[string]any{"z": float64(1), "a": float64(2), "m": float64(3)})
		b := Fingerprint(map[string]any{"a": float64(2), "m": float64(3), "z": float64(1)})
		if a != b {
			t.Errorf("Expected same fingerprint for reordered keys: %q != %q", a, b)
		}
	})

	t.Run("different data produces different fingerprints", func(t *testing.T) {
		a := Fingerprint(map[string]any{"a": float64(1)})
		b := Fingerprint(map[string]any{"a": float64(2)})
		if a == b {
			t.Errorf("Expected different fingerprints for different values")
		}
	})
}
