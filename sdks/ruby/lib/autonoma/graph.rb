# frozen_string_literal: true

require "set"

module Autonoma
  module Graph
    # Topological sort of nodes by FK dependency edges.
    # Returns {"sorted" => [...], "cycles" => [[...]]}.
    def self.topo_sort(nodes, edges)
      node_set = nodes.to_set

      # Filter to only edges between known nodes, skip self-referential
      relevant_edges = edges.select do |e|
        e["from"] != e["to"] && node_set.include?(e["from"]) && node_set.include?(e["to"])
      end

      # Build in-degree map and adjacency list
      in_degree = nodes.each_with_object({}) { |n, h| h[n] = 0 }
      adj = Hash.new { |h, k| h[k] = [] }

      relevant_edges.each do |e|
        # e["from"] depends on e["to"] (from has the FK pointing to to)
        adj[e["to"]] << e["from"]
        in_degree[e["from"]] = (in_degree[e["from"]] || 0) + 1
      end

      # First pass: standard Kahn's
      queue = in_degree.select { |_, d| d == 0 }.keys.sort
      sorted_nodes = []

      until queue.empty?
        node = queue.shift
        sorted_nodes << node
        (adj[node] || []).each do |neighbor|
          in_degree[neighbor] -= 1
          queue << neighbor if in_degree[neighbor] == 0
        end
        queue.sort!
      end

      # Find unsorted nodes
      unsorted = nodes.reject { |n| sorted_nodes.include?(n) }

      return { "sorted" => sorted_nodes, "cycles" => [] } if unsorted.empty?

      cycles = find_sccs(unsorted, relevant_edges)

      return { "sorted" => sorted_nodes, "cycles" => [] } if cycles.empty?

      # Second pass: treat cycle nodes as resolved and re-sort remaining
      cycle_nodes = cycles.flatten.to_set
      still_unsorted = unsorted.reject { |n| cycle_nodes.include?(n) }

      if still_unsorted.any?
        still_set = still_unsorted.to_set
        in_deg2 = still_unsorted.each_with_object({}) { |n, h| h[n] = 0 }
        adj2 = Hash.new { |h, k| h[k] = [] }

        relevant_edges.each do |e|
          if still_set.include?(e["from"]) && still_set.include?(e["to"])
            adj2[e["to"]] << e["from"]
            in_deg2[e["from"]] = (in_deg2[e["from"]] || 0) + 1
          end
        end

        queue2 = in_deg2.select { |_, d| d == 0 }.keys.sort
        until queue2.empty?
          node = queue2.shift
          sorted_nodes << node
          (adj2[node] || []).each do |neighbor|
            in_deg2[neighbor] -= 1
            queue2 << neighbor if in_deg2[neighbor] == 0
          end
          queue2.sort!
        end
      end

      { "sorted" => sorted_nodes, "cycles" => cycles }
    end

    # Find a nullable FK edge in a cycle that can be deferred.
    def self.find_deferrable_edge(cycle, edges)
      cycle_set = cycle.to_set
      edges.find do |e|
        cycle_set.include?(e["from"]) &&
          cycle_set.include?(e["to"]) &&
          e["from"] != e["to"] &&
          e["nullable"] == true
      end
    end

    # Tarjan's SCC algorithm to identify exact cycles among remaining nodes.
    def self.find_sccs(nodes, edges)
      node_set = nodes.to_set
      adj = Hash.new { |h, k| h[k] = [] }

      edges.each do |e|
        adj[e["to"]] << e["from"] if node_set.include?(e["from"]) && node_set.include?(e["to"])
      end

      index_counter = [0]
      stack = []
      on_stack = Set.new
      indices = {}
      lowlinks = {}
      sccs = []

      strong_connect = lambda do |v|
        indices[v] = index_counter[0]
        lowlinks[v] = index_counter[0]
        index_counter[0] += 1
        stack.push(v)
        on_stack.add(v)

        (adj[v] || []).each do |w|
          if !indices.key?(w)
            strong_connect.call(w)
            lowlinks[v] = [lowlinks[v], lowlinks[w]].min
          elsif on_stack.include?(w)
            lowlinks[v] = [lowlinks[v], indices[w]].min
          end
        end

        if lowlinks[v] == indices[v]
          scc = []
          loop do
            w = stack.pop
            on_stack.delete(w)
            scc << w
            break if w == v
          end
          sccs << scc if scc.length > 1
        end
      end

      nodes.each do |node|
        strong_connect.call(node) unless indices.key?(node)
      end

      sccs
    end

    private_class_method :find_sccs
  end
end
