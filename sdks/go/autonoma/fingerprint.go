package autonoma

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// Fingerprint computes a stable 16-char hex fingerprint of a value.
// Uses SHA256 of JSON-serialized data with sorted object keys.
func Fingerprint(value any) string {
	sorted := sortKeys(value)
	data, _ := json.Marshal(sorted)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])[:16]
}

// sortKeys recursively sorts object keys for deterministic serialization.
func sortKeys(value any) any {
	switch v := value.(type) {
	case map[string]any:
		sorted := make(sortedMap, 0, len(v))
		for key, val := range v {
			sorted = append(sorted, sortedMapEntry{Key: key, Value: sortKeys(val)})
		}
		sort.Slice(sorted, func(i, j int) bool {
			return sorted[i].Key < sorted[j].Key
		})
		return sorted
	case []any:
		result := make([]any, len(v))
		for i, item := range v {
			result[i] = sortKeys(item)
		}
		return result
	default:
		return value
	}
}

// sortedMap is a slice of key-value pairs that serializes with keys in order.
type sortedMap []sortedMapEntry

type sortedMapEntry struct {
	Key   string
	Value any
}

func (s sortedMap) MarshalJSON() ([]byte, error) {
	buf := []byte{'{'}
	for i, entry := range s {
		if i > 0 {
			buf = append(buf, ',')
		}
		keyBytes, err := json.Marshal(entry.Key)
		if err != nil {
			return nil, err
		}
		valBytes, err := json.Marshal(entry.Value)
		if err != nil {
			return nil, err
		}
		buf = append(buf, keyBytes...)
		buf = append(buf, ':')
		buf = append(buf, valBytes...)
	}
	buf = append(buf, '}')
	return buf, nil
}
