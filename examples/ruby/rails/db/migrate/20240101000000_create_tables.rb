class CreateTables < ActiveRecord::Migration[7.1]
  def change
    create_table :organizations, id: false do |t|
      t.string :id, primary_key: true, limit: 36, default: -> { "gen_random_uuid()::text" }
      t.string :name, null: false
      t.timestamps
    end

    create_table :users, id: false do |t|
      t.string :id, primary_key: true, limit: 36, default: -> { "gen_random_uuid()::text" }
      t.string :email, null: false
      t.string :name, null: false
      t.string :organization_id, limit: 36, null: false
      t.timestamps
    end
    add_index :users, :email, unique: true
    add_foreign_key :users, :organizations

    create_table :projects, id: false do |t|
      t.string :id, primary_key: true, limit: 36, default: -> { "gen_random_uuid()::text" }
      t.string :name, null: false
      t.string :organization_id, limit: 36, null: false
      t.timestamps
    end
    add_foreign_key :projects, :organizations

    create_table :tasks, id: false do |t|
      t.string :id, primary_key: true, limit: 36, default: -> { "gen_random_uuid()::text" }
      t.string :title, null: false
      t.string :status, null: false, default: "todo"
      t.string :organization_id, limit: 36, null: false
      t.string :project_id, limit: 36, null: false
      t.string :assignee_id, limit: 36, null: false
      t.timestamps
    end
    add_foreign_key :tasks, :organizations
    add_foreign_key :tasks, :projects
    add_foreign_key :tasks, :users, column: :assignee_id
  end
end
