SELECT
  kcu.table_name AS from_table,
  kcu.column_name AS from_column,
  kcu.referenced_table_name AS to_table,
  kcu.referenced_column_name AS to_column,
  c.is_nullable
FROM information_schema.key_column_usage kcu
JOIN information_schema.columns c
  ON c.table_schema = kcu.table_schema
  AND c.table_name = kcu.table_name
  AND c.column_name = kcu.column_name
WHERE kcu.referenced_table_name IS NOT NULL
  AND kcu.table_schema = '{{schema}}'
ORDER BY kcu.table_name, kcu.ordinal_position
