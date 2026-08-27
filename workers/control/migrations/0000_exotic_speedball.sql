CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_accountId_uidx` ON `account` (`issuer`,`account_id`);--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `hostname_allocations` (
	`label` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`user_id`) REFERENCES `projects`(`id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hostname_allocations_label_length" CHECK(length("hostname_allocations"."label") between 6 and 63)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hostname_allocations_project_id_unique` ON `hostname_allocations` (`project_id`);--> statement-breakpoint
CREATE INDEX `hostname_allocations_user_id_idx` ON `hostname_allocations` (`user_id`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`credential_hash_sha256` text NOT NULL,
	`credential_prefix` text NOT NULL,
	`credential_version` integer NOT NULL,
	`revoked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "machines_name_not_empty" CHECK(length("machines"."name") between 1 and 100),
	CONSTRAINT "machines_credential_version_positive" CHECK("machines"."credential_version" > 0),
	CONSTRAINT "machines_lifetime" CHECK("machines"."expires_at" > "machines"."created_at"),
	CONSTRAINT "machines_one_year_max_lifetime" CHECK("machines"."expires_at" <= "machines"."created_at" + 31536000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_credential_hash_sha256_unique` ON `machines` (`credential_hash_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `machines_id_user_id_unique` ON `machines` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `machines_user_id_idx` ON `machines` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_heads` (
	`project_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`publication_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publication_id`,`project_id`) REFERENCES `publications`(`id`,`project_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_heads_generation_non_negative" CHECK("project_heads"."generation" >= 0),
	CONSTRAINT "project_heads_publication_generation_pair" CHECK(("project_heads"."generation" = 0 and "project_heads"."publication_id" is null) or ("project_heads"."generation" > 0 and "project_heads"."publication_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_heads_publication_id_unique` ON `project_heads` (`publication_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "projects_slug_length" CHECK(length("projects"."slug") between 1 and 41),
	CONSTRAINT "projects_display_name_not_empty" CHECK(length("projects"."display_name") between 1 and 100),
	CONSTRAINT "projects_status_valid" CHECK("projects"."status" in ('active', 'taken_down'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_user_slug_unique` ON `projects` (`user_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_id_user_id_unique` ON `projects` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `projects_user_id_idx` ON `projects` (`user_id`);--> statement-breakpoint
CREATE TABLE `publication_attempt_objects` (
	`attempt_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`requires_upload` integer NOT NULL,
	`verified` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `content_hash`),
	FOREIGN KEY (`attempt_id`) REFERENCES `publication_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_attempt_objects_size_bytes_non_negative" CHECK("publication_attempt_objects"."size_bytes" >= 0),
	CONSTRAINT "publication_attempt_objects_reuse_verified" CHECK("publication_attempt_objects"."requires_upload" = 1 or "publication_attempt_objects"."verified" = 1)
);
--> statement-breakpoint
CREATE TABLE `publication_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`base_generation` integer NOT NULL,
	`base_logical_bytes` integer NOT NULL,
	`staged_manifest_r2_key` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`logical_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`reserved_active_delta_bytes` integer NOT NULL,
	`reserved_physical_upload_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`user_id`) REFERENCES `projects`(`id`,`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`,`user_id`) REFERENCES `machines`(`id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_attempts_state_valid" CHECK("publication_attempts"."state" in ('open', 'expired', 'committed', 'abandoned')),
	CONSTRAINT "publication_attempts_base_generation_non_negative" CHECK("publication_attempts"."base_generation" >= 0),
	CONSTRAINT "publication_attempts_base_logical_bytes_non_negative" CHECK("publication_attempts"."base_logical_bytes" >= 0),
	CONSTRAINT "publication_attempts_logical_bytes_non_negative" CHECK("publication_attempts"."logical_bytes" >= 0),
	CONSTRAINT "publication_attempts_file_count_non_negative" CHECK("publication_attempts"."file_count" >= 0),
	CONSTRAINT "publication_attempts_reserved_active_delta_non_negative" CHECK("publication_attempts"."reserved_active_delta_bytes" >= 0),
	CONSTRAINT "publication_attempts_reserved_physical_upload_non_negative" CHECK("publication_attempts"."reserved_physical_upload_bytes" >= 0),
	CONSTRAINT "publication_attempts_expiry" CHECK("publication_attempts"."expires_at" > "publication_attempts"."created_at"),
	CONSTRAINT "publication_attempts_settlement" CHECK(("publication_attempts"."state" = 'open' and "publication_attempts"."settled_at" is null) or ("publication_attempts"."state" <> 'open' and "publication_attempts"."settled_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `publication_attempts_project_state_idx` ON `publication_attempts` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `publication_attempts_user_state_idx` ON `publication_attempts` (`user_id`,`state`);--> statement-breakpoint
CREATE INDEX `publication_attempts_machine_id_idx` ON `publication_attempts` (`machine_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_attempts_identity_unique` ON `publication_attempts` (`id`,`project_id`,`machine_id`);--> statement-breakpoint
CREATE TABLE `publication_objects` (
	`publication_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`size_bytes` integer NOT NULL,
	PRIMARY KEY(`publication_id`, `content_hash`),
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_objects_size_bytes_non_negative" CHECK("publication_objects"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`generation` integer NOT NULL,
	`artifact_hash` text NOT NULL,
	`machine_id` text NOT NULL,
	`machine_name_snapshot` text NOT NULL,
	`logical_bytes` integer NOT NULL,
	`physical_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`object_count` integer NOT NULL,
	`published_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `publication_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`,`project_id`,`machine_id`) REFERENCES `publication_attempts`(`id`,`project_id`,`machine_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publications_generation_positive" CHECK("publications"."generation" > 0),
	CONSTRAINT "publications_logical_bytes_non_negative" CHECK("publications"."logical_bytes" >= 0),
	CONSTRAINT "publications_physical_bytes_non_negative" CHECK("publications"."physical_bytes" >= 0),
	CONSTRAINT "publications_file_count_non_negative" CHECK("publications"."file_count" >= 0),
	CONSTRAINT "publications_object_count_non_negative" CHECK("publications"."object_count" >= 0),
	CONSTRAINT "publications_machine_name_snapshot_not_empty" CHECK(length("publications"."machine_name_snapshot") between 1 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publications_attempt_id_unique` ON `publications` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publications_id_project_id_unique` ON `publications` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publications_project_generation_unique` ON `publications` (`project_id`,`generation`);--> statement-breakpoint
CREATE INDEX `publications_project_published_at_idx` ON `publications` (`project_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_handle` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`active_logical_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_active_delta_bytes` integer DEFAULT 0 NOT NULL,
	`retained_staged_physical_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_physical_upload_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "user_canonical_handle_length" CHECK("user"."canonical_handle" is null or length("user"."canonical_handle") between 3 and 20),
	CONSTRAINT "user_active_logical_bytes_non_negative" CHECK("user"."active_logical_bytes" >= 0),
	CONSTRAINT "user_reserved_active_delta_bytes_non_negative" CHECK("user"."reserved_active_delta_bytes" >= 0),
	CONSTRAINT "user_retained_staged_physical_bytes_non_negative" CHECK("user"."retained_staged_physical_bytes" >= 0),
	CONSTRAINT "user_reserved_physical_upload_bytes_non_negative" CHECK("user"."reserved_physical_upload_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_canonical_handle_unique` ON `user` (`canonical_handle`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `verified_objects` (
	`project_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`verified_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `content_hash`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "verified_objects_size_bytes_non_negative" CHECK("verified_objects"."size_bytes" >= 0)
);
