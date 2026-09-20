CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_installations` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account` text NOT NULL,
	`account_type` text NOT NULL,
	`repos` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gh_inst_owner` ON `github_installations` (`owner_id`);