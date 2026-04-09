<?php
namespace Autonoma\Sdk;

use DateTime;
use DateTimeZone;

class Template
{
    private const TEMPLATE_RE = '/\{\{(.+?)\}\}/';

    /** Resolve all {{...}} expressions in a value. Handles strings, arrays, dicts recursively. */
    public static function resolveTemplate(mixed $value, array $ctx): mixed
    {
        if (is_string($value)) {
            return self::resolveString($value, $ctx);
        }
        if (is_array($value)) {
            if (self::isAssoc($value)) {
                $result = [];
                foreach ($value as $k => $v) {
                    $result[$k] = self::resolveTemplate($v, $ctx);
                }
                return $result;
            }
            return array_map(fn($v) => self::resolveTemplate($v, $ctx), $value);
        }
        return $value;
    }

    private static function resolveString(string $s, array $ctx): mixed
    {
        // If the entire string is a single expression, return raw value (preserving type)
        if (preg_match('/^\{\{(.+?)\}\}$/', $s, $m)) {
            return self::evaluateExpression(trim($m[1]), $ctx);
        }
        // Otherwise, interpolate expressions into the string
        return preg_replace_callback(self::TEMPLATE_RE, function ($match) use ($ctx) {
            return (string) self::evaluateExpression(trim($match[1]), $ctx);
        }, $s);
    }

    private static function evaluateExpression(string $expr, array $ctx): mixed
    {
        if ($expr === 'testRunId') {
            return $ctx['testRunId'] ?? $ctx['test_run_id'] ?? '';
        }
        if ($expr === 'index') {
            return $ctx['index'] ?? 0;
        }
        if ($expr === 'index1') {
            return ($ctx['index'] ?? 0) + 1;
        }
        if ($expr === 'now()') {
            $dt = new DateTime('now', new DateTimeZone('UTC'));
            return $dt->format('Y-m-d\TH:i:s.v\Z');
        }

        // cycle([...])
        if (preg_match('/^cycle\(\[(.+)\]\)$/', $expr, $m)) {
            $items = self::parseArrayLiteral($m[1]);
            $index = $ctx['index'] ?? 0;
            return $items[$index % count($items)];
        }

        // pick([...])
        if (preg_match('/^pick\(\[(.+)\]\)$/', $expr, $m)) {
            $items = self::parseArrayLiteral($m[1]);
            return $items[array_rand($items)];
        }

        // random.int(a,b)
        if (preg_match('/^random\.int\((\d+),\s*(\d+)\)$/', $expr, $m)) {
            return random_int((int) $m[1], (int) $m[2]);
        }

        // random.float(a,b)
        if (preg_match('/^random\.float\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)$/', $expr, $m)) {
            $min = (float) $m[1];
            $max = (float) $m[2];
            return $min + (mt_rand() / mt_getrandmax()) * ($max - $min);
        }

        // daysAgo(n)
        if (preg_match('/^daysAgo\((\d+)\)$/', $expr, $m)) {
            $n = (int) $m[1];
            $dt = new DateTime('now', new DateTimeZone('UTC'));
            $dt->modify("-{$n} days");
            return $dt->format('Y-m-d\TH:i:s.v\Z');
        }

        throw new \RuntimeException("Template error: unknown expression '{$expr}'");
    }

    /** @return string[] */
    private static function parseArrayLiteral(string $raw): array
    {
        $items = [];
        foreach (explode(',', $raw) as $s) {
            $s = trim($s);
            if ((str_starts_with($s, "'") && str_ends_with($s, "'")) ||
                (str_starts_with($s, '"') && str_ends_with($s, '"'))) {
                $s = substr($s, 1, -1);
            }
            $items[] = $s;
        }
        return $items;
    }

    private static function isAssoc(array $arr): bool
    {
        if (empty($arr)) return false;
        return array_keys($arr) !== range(0, count($arr) - 1);
    }
}
