-- MySQL DDL — mirrors the Quarita schema (subset) for integration testing

CREATE TABLE `Organization` (
  `id`        VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`      VARCHAR(255) NOT NULL,
  `slug`      VARCHAR(255) NOT NULL,
  `logo`      TEXT,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `Organization_slug_key` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `User` (
  `id`            VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`          VARCHAR(255) NOT NULL,
  `email`         VARCHAR(255) NOT NULL,
  `emailVerified` TINYINT(1) NOT NULL DEFAULT 0,
  `image`         TEXT,
  `createdAt`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `User_email_key` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `Member` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `userId`         VARCHAR(36) NOT NULL,
  `organizationId` VARCHAR(36) NOT NULL,
  `role`           VARCHAR(50) NOT NULL,
  `createdAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `Member_userId_organizationId_key` (`userId`, `organizationId`),
  CONSTRAINT `Member_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE,
  CONSTRAINT `Member_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `Invitation` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `email`          VARCHAR(255) NOT NULL,
  `inviterId`      VARCHAR(36) NOT NULL,
  `organizationId` VARCHAR(36) NOT NULL,
  `role`           VARCHAR(50) NOT NULL,
  `status`         VARCHAR(50) NOT NULL DEFAULT 'pending',
  `expiresAt`      DATETIME NOT NULL,
  `createdAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `Invitation_inviterId_fkey` FOREIGN KEY (`inviterId`) REFERENCES `User`(`id`) ON DELETE CASCADE,
  CONSTRAINT `Invitation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `Application` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`           VARCHAR(255) NOT NULL,
  `organizationId` VARCHAR(36) NOT NULL,
  `architecture`   ENUM('WEB', 'IOS', 'ANDROID') NOT NULL,
  `createdAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `Application_name_organizationId_key` (`name`, `organizationId`),
  CONSTRAINT `Application_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `ApiKey` (
  `id`        VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `key`       VARCHAR(255) NOT NULL,
  `userId`    VARCHAR(36) NOT NULL,
  `enabled`   TINYINT(1) NOT NULL DEFAULT 1,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `ApiKey_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `folder` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`           VARCHAR(255) NOT NULL,
  `description`    TEXT,
  `application_id` VARCHAR(36) NOT NULL,
  `parent_id`      VARCHAR(36),
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `folder_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `Application`(`id`) ON DELETE CASCADE,
  CONSTRAINT `folder_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `folder`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `tag` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`           VARCHAR(255) NOT NULL,
  `color`          VARCHAR(50) NOT NULL,
  `application_id` VARCHAR(36) NOT NULL,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `tag_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `Application`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `TestPlan` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`           VARCHAR(255) NOT NULL,
  `plan`           TEXT NOT NULL,
  `userId`         VARCHAR(36),
  `organizationId` VARCHAR(36) NOT NULL,
  `applicationId`  VARCHAR(36) NOT NULL,
  `createdAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `TestPlan_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL,
  CONSTRAINT `TestPlan_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE,
  CONSTRAINT `TestPlan_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `Application`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `TestGeneration` (
  `id`             VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `testPlanId`     VARCHAR(36) NOT NULL,
  `application_id` VARCHAR(36) NOT NULL,
  `status`         VARCHAR(50) NOT NULL DEFAULT 'pending',
  `conversation`   JSON NOT NULL,
  `reasoning`      TEXT,
  `createdAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `TestGeneration_testPlanId_fkey` FOREIGN KEY (`testPlanId`) REFERENCES `TestPlan`(`id`) ON DELETE CASCADE,
  CONSTRAINT `TestGeneration_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `Application`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `test` (
  `id`                  VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `name`                VARCHAR(255) NOT NULL,
  `description`         TEXT,
  `test_generation_id`  VARCHAR(36) NOT NULL,
  `application_id`      VARCHAR(36) NOT NULL,
  `folder_id`           VARCHAR(36),
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `test_test_generation_id_key` (`test_generation_id`),
  CONSTRAINT `test_test_generation_id_fkey` FOREIGN KEY (`test_generation_id`) REFERENCES `TestGeneration`(`id`) ON DELETE CASCADE,
  CONSTRAINT `test_application_id_fkey` FOREIGN KEY (`application_id`) REFERENCES `Application`(`id`) ON DELETE CASCADE,
  CONSTRAINT `test_folder_id_fkey` FOREIGN KEY (`folder_id`) REFERENCES `folder`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `test_step` (
  `id`          VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `test_id`     VARCHAR(36) NOT NULL,
  `order`       INT NOT NULL,
  `interaction` VARCHAR(255) NOT NULL,
  `params`      JSON NOT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `test_step_test_id_order_key` (`test_id`, `order`),
  CONSTRAINT `test_step_test_id_fkey` FOREIGN KEY (`test_id`) REFERENCES `test`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `test_tag` (
  `id`      VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `test_id` VARCHAR(36) NOT NULL,
  `tag_id`  VARCHAR(36) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `test_tag_test_id_tag_id_key` (`test_id`, `tag_id`),
  CONSTRAINT `test_tag_test_id_fkey` FOREIGN KEY (`test_id`) REFERENCES `test`(`id`) ON DELETE CASCADE,
  CONSTRAINT `test_tag_tag_id_fkey` FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `run` (
  `id`           VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `test_id`      VARCHAR(36) NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `started_at`   DATETIME,
  `completed_at` DATETIME,
  PRIMARY KEY (`id`),
  CONSTRAINT `run_test_id_fkey` FOREIGN KEY (`test_id`) REFERENCES `test`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `run_step` (
  `id`           VARCHAR(36) NOT NULL DEFAULT (UUID()),
  `run_id`       VARCHAR(36) NOT NULL,
  `test_step_id` VARCHAR(36) NOT NULL,
  `order`        INT NOT NULL,
  `status`       ENUM('pending', 'running', 'passed', 'failed', 'skipped') NOT NULL,
  `output`       JSON NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `run_step_run_id_order_key` (`run_id`, `order`),
  UNIQUE KEY `run_step_run_id_test_step_id_key` (`run_id`, `test_step_id`),
  CONSTRAINT `run_step_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON DELETE CASCADE,
  CONSTRAINT `run_step_test_step_id_fkey` FOREIGN KEY (`test_step_id`) REFERENCES `test_step`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
