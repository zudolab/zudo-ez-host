CREATE TABLE `desktop_authorization_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`code_challenge_method` text NOT NULL,
	`scope` text NOT NULL,
	`machine_name` text NOT NULL,
	`machine_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "desktop_authorization_codes_method_s256" CHECK("desktop_authorization_codes"."code_challenge_method" = 'S256'),
	CONSTRAINT "desktop_authorization_codes_scope_publish" CHECK("desktop_authorization_codes"."scope" = 'publish'),
	CONSTRAINT "desktop_authorization_codes_expiry" CHECK("desktop_authorization_codes"."expires_at" > "desktop_authorization_codes"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `desktop_authorization_codes_machine_id_unique` ON `desktop_authorization_codes` (`machine_id`);--> statement-breakpoint
CREATE INDEX `desktop_authorization_codes_user_id_idx` ON `desktop_authorization_codes` (`user_id`);