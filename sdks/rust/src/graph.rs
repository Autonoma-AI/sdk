//! Topological sorting via Kahn's algorithm and cycle detection via Tarjan's SCC.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Topological sort of nodes by FK dependency edges.
/// Returns {"sorted": [...], "cycles": [[...]]}.
pub fn topo_sort(nodes: &[String], edges: &[Value]) -> Value {
    let node_set: HashSet<&str> = nodes.iter().map(|s| s.as_str()).collect();

    // Filter to only edges between known nodes, skip self-referential
    let relevant_edges: Vec<(&str, &str)> = edges
        .iter()
        .filter_map(|e| {
            let from = e.get("from")?.as_str()?;
            let to = e.get("to")?.as_str()?;
            if from != to && node_set.contains(from) && node_set.contains(to) {
                Some((from, to))
            } else {
                None
            }
        })
        .collect();

    // Build in-degree map and adjacency list
    // e["from"] depends on e["to"] (from has the FK pointing to to)
    let mut in_degree: BTreeMap<&str, i32> = BTreeMap::new();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();

    for n in nodes {
        in_degree.insert(n.as_str(), 0);
    }

    for &(from, to) in &relevant_edges {
        adj.entry(to).or_default().push(from);
        *in_degree.entry(from).or_insert(0) += 1;
    }

    // First pass: standard Kahn's algorithm
    let mut queue: Vec<&str> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&n, _)| n)
        .collect();
    queue.sort();

    let mut sorted_nodes: Vec<String> = Vec::new();

    while let Some(node) = queue.first().cloned() {
        queue.remove(0);
        sorted_nodes.push(node.to_string());
        if let Some(neighbors) = adj.get(node) {
            for &neighbor in neighbors {
                if let Some(deg) = in_degree.get_mut(neighbor) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push(neighbor);
                    }
                }
            }
        }
        queue.sort();
    }

    // Find unsorted nodes
    let sorted_set: HashSet<&str> = sorted_nodes.iter().map(|s| s.as_str()).collect();
    let unsorted: Vec<String> = nodes
        .iter()
        .filter(|n| !sorted_set.contains(n.as_str()))
        .cloned()
        .collect();

    if unsorted.is_empty() {
        let empty_cycles: Vec<Vec<String>> = Vec::new();
        return serde_json::json!({
            "sorted": sorted_nodes,
            "cycles": empty_cycles
        });
    }

    let cycles = find_sccs(&unsorted, &relevant_edges);

    if cycles.is_empty() {
        let empty_cycles: Vec<Vec<String>> = Vec::new();
        return serde_json::json!({
            "sorted": sorted_nodes,
            "cycles": empty_cycles
        });
    }

    // Second pass: treat cycle nodes as resolved and re-sort remaining
    let cycle_nodes: HashSet<String> = cycles.iter().flatten().cloned().collect();
    let still_unsorted: Vec<String> = unsorted
        .into_iter()
        .filter(|n| !cycle_nodes.contains(n))
        .collect();

    if !still_unsorted.is_empty() {
        let still_set: HashSet<&str> = still_unsorted.iter().map(|s| s.as_str()).collect();
        let mut in_deg2: BTreeMap<&str, i32> = BTreeMap::new();
        let mut adj2: HashMap<&str, Vec<&str>> = HashMap::new();

        for n in &still_unsorted {
            in_deg2.insert(n.as_str(), 0);
        }

        for &(from, to) in &relevant_edges {
            if still_set.contains(from) && still_set.contains(to) {
                adj2.entry(to).or_default().push(from);
                *in_deg2.entry(from).or_insert(0) += 1;
            }
        }

        let mut queue2: Vec<&str> = in_deg2
            .iter()
            .filter(|(_, &d)| d == 0)
            .map(|(&n, _)| n)
            .collect();
        queue2.sort();

        while let Some(node) = queue2.first().cloned() {
            queue2.remove(0);
            sorted_nodes.push(node.to_string());
            if let Some(neighbors) = adj2.get(node) {
                for &neighbor in neighbors {
                    if let Some(deg) = in_deg2.get_mut(neighbor) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue2.push(neighbor);
                        }
                    }
                }
            }
            queue2.sort();
        }
    }

    serde_json::json!({
        "sorted": sorted_nodes,
        "cycles": cycles
    })
}

/// Tarjan's SCC algorithm to identify exact cycles among remaining nodes.
fn find_sccs(nodes: &[String], edges: &[(&str, &str)]) -> Vec<Vec<String>> {
    let node_set: HashSet<&str> = nodes.iter().map(|s| s.as_str()).collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();

    for &(from, to) in edges {
        if node_set.contains(from) && node_set.contains(to) {
            adj.entry(to).or_default().push(from);
        }
    }

    let mut index_counter: usize = 0;
    let mut stack: Vec<&str> = Vec::new();
    let mut on_stack: HashSet<&str> = HashSet::new();
    let mut indices: HashMap<&str, usize> = HashMap::new();
    let mut lowlinks: HashMap<&str, usize> = HashMap::new();
    let mut sccs: Vec<Vec<String>> = Vec::new();

    fn strong_connect<'a>(
        v: &'a str,
        adj: &HashMap<&str, Vec<&'a str>>,
        index_counter: &mut usize,
        stack: &mut Vec<&'a str>,
        on_stack: &mut HashSet<&'a str>,
        indices: &mut HashMap<&'a str, usize>,
        lowlinks: &mut HashMap<&'a str, usize>,
        sccs: &mut Vec<Vec<String>>,
    ) {
        indices.insert(v, *index_counter);
        lowlinks.insert(v, *index_counter);
        *index_counter += 1;
        stack.push(v);
        on_stack.insert(v);

        if let Some(neighbors) = adj.get(v) {
            for &w in neighbors {
                if !indices.contains_key(w) {
                    strong_connect(w, adj, index_counter, stack, on_stack, indices, lowlinks, sccs);
                    let wl = *lowlinks.get(w).unwrap();
                    let vl = lowlinks.get_mut(v).unwrap();
                    *vl = (*vl).min(wl);
                } else if on_stack.contains(w) {
                    let wi = *indices.get(w).unwrap();
                    let vl = lowlinks.get_mut(v).unwrap();
                    *vl = (*vl).min(wi);
                }
            }
        }

        if lowlinks.get(v) == indices.get(v) {
            let mut scc: Vec<String> = Vec::new();
            loop {
                let w = stack.pop().unwrap();
                on_stack.remove(w);
                scc.push(w.to_string());
                if w == v {
                    break;
                }
            }
            if scc.len() > 1 {
                sccs.push(scc);
            }
        }
    }

    for node in nodes {
        if !indices.contains_key(node.as_str()) {
            strong_connect(
                node.as_str(),
                &adj,
                &mut index_counter,
                &mut stack,
                &mut on_stack,
                &mut indices,
                &mut lowlinks,
                &mut sccs,
            );
        }
    }

    sccs
}

/// Find a nullable FK edge in a cycle that can be deferred.
pub fn find_deferrable_edge(cycle: &[String], edges: &[Value]) -> Value {
    let cycle_set: BTreeSet<&str> = cycle.iter().map(|s| s.as_str()).collect();

    for e in edges {
        let from = e.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = e.get("to").and_then(|v| v.as_str()).unwrap_or("");
        let nullable = e.get("nullable").and_then(|v| v.as_bool()).unwrap_or(false);

        if cycle_set.contains(from)
            && cycle_set.contains(to)
            && from != to
            && nullable
        {
            return e.clone();
        }
    }

    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn simple_linear_chain() {
        let nodes = vec!["A".into(), "B".into(), "C".into()];
        let edges = vec![
            json!({"from": "B", "to": "A"}),
            json!({"from": "C", "to": "B"}),
        ];
        let result = topo_sort(&nodes, &edges);
        let sorted: Vec<String> = result["sorted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(sorted, vec!["A", "B", "C"]);
    }

    #[test]
    fn detects_cycle() {
        let nodes = vec!["A".into(), "B".into()];
        let edges = vec![
            json!({"from": "A", "to": "B"}),
            json!({"from": "B", "to": "A"}),
        ];
        let result = topo_sort(&nodes, &edges);
        let cycles = result["cycles"].as_array().unwrap();
        assert!(!cycles.is_empty());
    }
}
