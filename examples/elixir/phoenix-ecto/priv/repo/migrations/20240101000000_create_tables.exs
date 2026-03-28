defmodule AutonomaExample.Repo.Migrations.CreateTables do
  use Ecto.Migration

  def change do
    # Organizations — the root scope model
    create table(:organizations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :name, :string, null: false

      timestamps()
    end

    # Users — belong to an Organization
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :email, :string, null: false
      add :name, :string, null: false
      add :organization_id, references(:organizations, type: :binary_id), null: false

      timestamps()
    end

    create unique_index(:users, [:email])

    # Projects — belong to an Organization
    create table(:projects, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :name, :string, null: false
      add :organization_id, references(:organizations, type: :binary_id), null: false

      timestamps()
    end

    # Tasks — belong to a Project, assigned to a User
    create table(:tasks, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :title, :string, null: false
      add :status, :string, null: false, default: "todo"
      add :organization_id, references(:organizations, type: :binary_id), null: false
      add :project_id, references(:projects, type: :binary_id), null: false
      add :assignee_id, references(:users, type: :binary_id), null: false

      timestamps()
    end
  end
end
