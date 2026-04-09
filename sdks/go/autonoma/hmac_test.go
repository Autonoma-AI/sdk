package autonoma

import "testing"

func TestSignBody(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		secret string
		want   string
	}{
		{
			name:   "signs JSON body deterministically",
			body:   `{"action":"discover"}`,
			secret: "test-secret-key",
			want:   "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
		},
		{
			name:   "signs empty body",
			body:   "",
			secret: "test-secret-key",
			want:   "d1011b593027040df27a8cdd7a95af3021523909894a214033c69b508fcb9b05",
		},
		{
			name:   "different secret produces different signature",
			body:   `{"action":"up","environment":"standard"}`,
			secret: "another-secret",
			want:   "ef2e8267e43842c889f86b436a407d62d3d29e43a82005b1f21a0b49d6e584c8",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SignBody(tt.body, tt.secret)
			if got != tt.want {
				t.Errorf("SignBody() = %q, want %q", got, tt.want)
			}
			if len(got) != 64 {
				t.Errorf("SignBody() length = %d, want 64", len(got))
			}
		})
	}
}

func TestVerifySignature(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		signature string
		secret    string
		want      bool
	}{
		{
			name:      "verifies valid signature",
			body:      `{"action":"discover"}`,
			signature: "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
			secret:    "test-secret-key",
			want:      true,
		},
		{
			name:      "rejects invalid signature",
			body:      `{"action":"discover"}`,
			signature: "0000000000000000000000000000000000000000000000000000000000000000",
			secret:    "test-secret-key",
			want:      false,
		},
		{
			name:      "rejects wrong secret",
			body:      `{"action":"discover"}`,
			signature: "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
			secret:    "wrong-secret",
			want:      false,
		},
		{
			name:      "rejects different body",
			body:      `{"action":"up"}`,
			signature: "2c5588170f06ff28479566d72d45969927913c56bcba01d36c3122f2284cbba2",
			secret:    "test-secret-key",
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := VerifySignature(tt.body, tt.signature, tt.secret)
			if got != tt.want {
				t.Errorf("VerifySignature() = %v, want %v", got, tt.want)
			}
		})
	}
}
