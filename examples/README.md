# Autonoma SDK — Examples

Runnable example projects for every supported framework combination. Each example uses the same data model (Organization → User, Project → Task) and PostgreSQL via Docker.

## Examples

| Language | Framework | Directory |
|----------|-----------|-----------|
| TypeScript | Express | [`typescript/express-prisma`](typescript/express-prisma/) |
| TypeScript | Next.js (App Router) | [`typescript/nextjs-drizzle`](typescript/nextjs-drizzle/) |
| Python | FastAPI | [`python/fastapi-sqlalchemy`](python/fastapi-sqlalchemy/) |
| Python | Flask | [`python/flask-sqlalchemy`](python/flask-sqlalchemy/) |
| Python | Django | [`python/django`](python/django/) |
| Elixir | Phoenix | [`elixir/phoenix-ecto`](elixir/phoenix-ecto/) |
| Java | Spring Boot | [`java/spring-boot`](java/spring-boot/) |
| Ruby | Rails | [`ruby/rails`](ruby/rails/) |
| Rust | Axum | [`rust/axum-sqlx`](rust/axum-sqlx/) |
| Go | Gin | [`go/gin`](go/gin/) |
| PHP | Laravel | [`php/laravel`](php/laravel/) |

## Common setup

Every example uses the same PostgreSQL container:

```bash
docker run --rm -d \
  --name autonoma-postgres \
  -e POSTGRES_USER=autonoma \
  -e POSTGRES_PASSWORD=autonoma \
  -e POSTGRES_DB=autonoma_example \
  -p 5432:5432 \
  postgres:16-alpine
```

Then follow the README in each example directory.

## Testing the endpoint

Once a server is running, you can verify it with a `discover` request:

```bash
BODY='{"action":"discover"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "my-shared-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  -d "$BODY"
```

> **Note:** The Elixir/Phoenix example runs on port 4000 by default.

## Cleanup

```bash
docker stop autonoma-postgres
```
