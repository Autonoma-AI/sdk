package autonoma

import "testing"

func TestTopoSort(t *testing.T) {
	t.Run("sorts linear dependency chain", func(t *testing.T) {
		result := TopoSort(
			[]string{"Order", "User", "Product"},
			[]FKEdge{
				{From: "Order", To: "User", LocalField: "userId", ForeignField: "id", Nullable: false},
				{From: "Order", To: "Product", LocalField: "productId", ForeignField: "id", Nullable: false},
			},
		)
		if len(result.Sorted) != 3 {
			t.Errorf("expected 3 sorted, got %d", len(result.Sorted))
		}
		if len(result.Cycles) != 0 {
			t.Errorf("expected 0 cycles, got %d", len(result.Cycles))
		}
		// User and Product must come before Order
		assertBefore(t, result.Sorted, "User", "Order")
		assertBefore(t, result.Sorted, "Product", "Order")
	})

	t.Run("handles nodes with no edges", func(t *testing.T) {
		result := TopoSort([]string{"A", "B", "C"}, nil)
		if len(result.Sorted) != 3 {
			t.Errorf("expected 3 sorted, got %d", len(result.Sorted))
		}
		if len(result.Cycles) != 0 {
			t.Errorf("expected 0 cycles, got %d", len(result.Cycles))
		}
	})

	t.Run("detects 2-node cycle", func(t *testing.T) {
		result := TopoSort(
			[]string{"A", "B"},
			[]FKEdge{
				{From: "A", To: "B", LocalField: "bId", ForeignField: "id", Nullable: false},
				{From: "B", To: "A", LocalField: "aId", ForeignField: "id", Nullable: true},
			},
		)
		if len(result.Cycles) != 1 {
			t.Errorf("expected 1 cycle, got %d", len(result.Cycles))
		}
	})

	t.Run("ignores self-referential edges", func(t *testing.T) {
		result := TopoSort(
			[]string{"Category"},
			[]FKEdge{
				{From: "Category", To: "Category", LocalField: "parentId", ForeignField: "id", Nullable: true},
			},
		)
		if len(result.Sorted) != 1 || result.Sorted[0] != "Category" {
			t.Errorf("expected [Category], got %v", result.Sorted)
		}
		if len(result.Cycles) != 0 {
			t.Errorf("expected 0 cycles, got %d", len(result.Cycles))
		}
	})

	t.Run("sorts deep chain", func(t *testing.T) {
		result := TopoSort(
			[]string{"D", "C", "B", "A"},
			[]FKEdge{
				{From: "B", To: "A", LocalField: "aId", ForeignField: "id"},
				{From: "C", To: "B", LocalField: "bId", ForeignField: "id"},
				{From: "D", To: "C", LocalField: "cId", ForeignField: "id"},
			},
		)
		if len(result.Sorted) != 4 {
			t.Errorf("expected 4 sorted, got %d", len(result.Sorted))
		}
		assertBefore(t, result.Sorted, "A", "B")
		assertBefore(t, result.Sorted, "B", "C")
		assertBefore(t, result.Sorted, "C", "D")
	})
}

func TestFindDeferrableEdge(t *testing.T) {
	t.Run("finds nullable edge", func(t *testing.T) {
		edge := FindDeferrableEdge(
			[]string{"A", "B"},
			[]FKEdge{
				{From: "A", To: "B", LocalField: "bId", ForeignField: "id", Nullable: false},
				{From: "B", To: "A", LocalField: "aId", ForeignField: "id", Nullable: true},
			},
		)
		if edge == nil {
			t.Fatal("expected non-nil edge")
		}
		if !edge.Nullable {
			t.Error("expected nullable edge")
		}
	})

	t.Run("returns nil when no nullable edge", func(t *testing.T) {
		edge := FindDeferrableEdge(
			[]string{"A", "B"},
			[]FKEdge{
				{From: "A", To: "B", LocalField: "bId", ForeignField: "id", Nullable: false},
				{From: "B", To: "A", LocalField: "aId", ForeignField: "id", Nullable: false},
			},
		)
		if edge != nil {
			t.Error("expected nil edge")
		}
	})
}

func assertBefore(t *testing.T, sorted []string, a, b string) {
	t.Helper()
	ia, ib := -1, -1
	for i, s := range sorted {
		if s == a {
			ia = i
		}
		if s == b {
			ib = i
		}
	}
	if ia == -1 || ib == -1 || ia >= ib {
		t.Errorf("expected %s before %s in %v", a, b, sorted)
	}
}
