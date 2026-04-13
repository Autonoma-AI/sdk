<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('organizations', function (Blueprint $table) {
            $table->uuid('id')->primary()->default(DB::raw('gen_random_uuid()::text'));
            $table->string('name');
            $table->timestamps();
        });

        Schema::create('users', function (Blueprint $table) {
            $table->uuid('id')->primary()->default(DB::raw('gen_random_uuid()::text'));
            $table->string('email')->unique();
            $table->string('name');
            $table->string('organization_id', 36);
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->timestamps();
        });

        Schema::create('projects', function (Blueprint $table) {
            $table->uuid('id')->primary()->default(DB::raw('gen_random_uuid()::text'));
            $table->string('name');
            $table->string('organization_id', 36);
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->timestamps();
        });

        Schema::create('tasks', function (Blueprint $table) {
            $table->uuid('id')->primary()->default(DB::raw('gen_random_uuid()::text'));
            $table->string('title');
            $table->string('status')->default('todo');
            $table->string('organization_id', 36);
            $table->string('project_id', 36);
            $table->string('assignee_id', 36);
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->foreign('project_id')->references('id')->on('projects');
            $table->foreign('assignee_id')->references('id')->on('users');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tasks');
        Schema::dropIfExists('projects');
        Schema::dropIfExists('users');
        Schema::dropIfExists('organizations');
    }
};
