# Start the test repo
Application.put_env(:autonoma, Autonoma.TestRepo, database: ":memory:", pool_size: 1)
{:ok, _} = Autonoma.TestRepo.start_link()

# Run migrations
Autonoma.TestMigrations.up(Autonoma.TestRepo)

# Exclude postgres integration tests by default (run with: mix test --include postgres)
ExUnit.start(exclude: [:postgres])
