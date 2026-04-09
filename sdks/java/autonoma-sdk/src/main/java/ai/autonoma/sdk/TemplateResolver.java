package ai.autonoma.sdk;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves all {{...}} expressions in values. Handles strings, objects, and arrays recursively.
 */
public final class TemplateResolver {

    private static final Pattern TEMPLATE_RE = Pattern.compile("\\{\\{(.+?)\\}\\}");
    private static final Pattern FULL_MATCH_RE = Pattern.compile("^\\{\\{(.+?)\\}\\}$");
    private static final Pattern CYCLE_RE = Pattern.compile("^cycle\\(\\[(.+)\\]\\)$");
    private static final Pattern PICK_RE = Pattern.compile("^pick\\(\\[(.+)\\]\\)$");
    private static final Pattern RAND_INT_RE = Pattern.compile("^random\\.int\\((\\d+),\\s*(\\d+)\\)$");
    private static final Pattern RAND_FLOAT_RE = Pattern.compile("^random\\.float\\((\\d+(?:\\.\\d+)?),\\s*(\\d+(?:\\.\\d+)?)\\)$");
    private static final Pattern DAYS_AGO_RE = Pattern.compile("^daysAgo\\((\\d+)\\)$");

    private static final Random RANDOM = new Random();

    private TemplateResolver() {}

    @SuppressWarnings("unchecked")
    public static Object resolveTemplate(Object value, String testRunId, int index) {
        if (value instanceof String str) {
            return resolveString(str, testRunId, index);
        }
        if (value instanceof List<?> list) {
            List<Object> result = new ArrayList<>(list.size());
            for (Object item : list) {
                result.add(resolveTemplate(item, testRunId, index));
            }
            return result;
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                result.put(String.valueOf(entry.getKey()), resolveTemplate(entry.getValue(), testRunId, index));
            }
            return result;
        }
        return value;
    }

    private static Object resolveString(String str, String testRunId, int index) {
        Matcher fullMatch = FULL_MATCH_RE.matcher(str);
        if (fullMatch.matches()) {
            return evaluateExpression(fullMatch.group(1).trim(), testRunId, index);
        }

        Matcher matcher = TEMPLATE_RE.matcher(str);
        StringBuilder sb = new StringBuilder();
        while (matcher.find()) {
            Object val = evaluateExpression(matcher.group(1).trim(), testRunId, index);
            matcher.appendReplacement(sb, Matcher.quoteReplacement(String.valueOf(val)));
        }
        matcher.appendTail(sb);
        return sb.toString();
    }

    private static Object evaluateExpression(String expr, String testRunId, int index) {
        if ("testRunId".equals(expr)) return testRunId;
        if ("index".equals(expr)) return index;
        if ("index1".equals(expr)) return index + 1;

        Matcher cycleMatch = CYCLE_RE.matcher(expr);
        if (cycleMatch.matches()) {
            List<String> items = parseArrayLiteral(cycleMatch.group(1));
            return items.get(index % items.size());
        }

        Matcher pickMatch = PICK_RE.matcher(expr);
        if (pickMatch.matches()) {
            List<String> items = parseArrayLiteral(pickMatch.group(1));
            return items.get(RANDOM.nextInt(items.size()));
        }

        Matcher randIntMatch = RAND_INT_RE.matcher(expr);
        if (randIntMatch.matches()) {
            int min = Integer.parseInt(randIntMatch.group(1));
            int max = Integer.parseInt(randIntMatch.group(2));
            return RANDOM.nextInt(max - min + 1) + min;
        }

        Matcher randFloatMatch = RAND_FLOAT_RE.matcher(expr);
        if (randFloatMatch.matches()) {
            double min = Double.parseDouble(randFloatMatch.group(1));
            double max = Double.parseDouble(randFloatMatch.group(2));
            return RANDOM.nextDouble() * (max - min) + min;
        }

        if ("now()".equals(expr)) return Instant.now().toString();

        Matcher daysAgoMatch = DAYS_AGO_RE.matcher(expr);
        if (daysAgoMatch.matches()) {
            int days = Integer.parseInt(daysAgoMatch.group(1));
            return Instant.now().minus(days, ChronoUnit.DAYS).toString();
        }

        throw new RuntimeException("Template error: unknown expression '" + expr + "'");
    }

    private static List<String> parseArrayLiteral(String raw) {
        List<String> items = new ArrayList<>();
        for (String s : raw.split(",")) {
            s = s.trim();
            if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith("\"") && s.endsWith("\""))) {
                s = s.substring(1, s.length() - 1);
            }
            items.add(s);
        }
        return items;
    }
}
