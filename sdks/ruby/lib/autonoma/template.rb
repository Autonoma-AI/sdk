# frozen_string_literal: true

require "time"

module Autonoma
  module Template
    TEMPLATE_RE = /\{\{(.+?)\}\}/

    # Resolve all {{...}} expressions in a value. Handles strings, hashes, arrays recursively.
    def self.resolve_template(value, ctx)
      case value
      when String
        resolve_string(value, ctx)
      when Array
        value.map { |v| resolve_template(v, ctx) }
      when Hash
        value.transform_values { |v| resolve_template(v, ctx) }
      else
        value
      end
    end

    def self.resolve_string(s, ctx)
      # If the entire string is a single expression, return raw value (preserving type)
      full_match = s.match(/\A\{\{(.+?)\}\}\z/)
      return evaluate_expression(full_match[1].strip, ctx) if full_match

      # Otherwise, interpolate expressions into the string
      s.gsub(TEMPLATE_RE) do
        val = evaluate_expression(::Regexp.last_match(1).strip, ctx)
        val.to_s
      end
    end

    def self.evaluate_expression(expr, ctx)
      test_run_id = ctx["testRunId"] || ctx["test_run_id"] || ""
      index = ctx["index"] || 0

      case expr
      when "testRunId"
        test_run_id
      when "index"
        index
      when "index1"
        index + 1
      when "now()"
        Time.now.utc.iso8601(3).sub(/\+00:00\z/, "Z")
      else
        # cycle([...])
        if (m = expr.match(/\Acycle\(\[(.+)\]\)\z/))
          items = parse_array_literal(m[1])
          return items[index % items.length]
        end

        # pick([...])
        if (m = expr.match(/\Apick\(\[(.+)\]\)\z/))
          items = parse_array_literal(m[1])
          return items.sample
        end

        # random.int(a,b)
        if (m = expr.match(/\Arandom\.int\((\d+),\s*(\d+)\)\z/))
          min_val = m[1].to_i
          max_val = m[2].to_i
          return rand(min_val..max_val)
        end

        # random.float(a,b)
        if (m = expr.match(/\Arandom\.float\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)\z/))
          min_val = m[1].to_f
          max_val = m[2].to_f
          return rand * (max_val - min_val) + min_val
        end

        # daysAgo(n)
        if (m = expr.match(/\AdaysAgo\((\d+)\)\z/))
          n = m[1].to_i
          dt = Time.now.utc - (n * 86_400)
          return dt.iso8601(3).sub(/\+00:00\z/, "Z")
        end

        raise "Template error: unknown expression '#{expr}'"
      end
    end

    def self.parse_array_literal(raw)
      raw.split(",").map do |s|
        s = s.strip
        s = s[1..-2] if (s.start_with?("'") && s.end_with?("'")) || (s.start_with?('"') && s.end_with?('"'))
        s
      end
    end

    private_class_method :resolve_string, :evaluate_expression, :parse_array_literal
  end
end
