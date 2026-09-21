CREATE TABLE `repo_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`repo` text NOT NULL,
	`readme_hash` text NOT NULL,
	`profile` text NOT NULL,
	`edits` text,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_profiles_owner_repo` ON `repo_profiles` (`owner_id`,`repo`);--> statement-breakpoint
CREATE TABLE `change_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`repo` text NOT NULL,
	`text` text NOT NULL,
	`normalized` text NOT NULL,
	`source` text,
	`candidate_id` integer,
	`first_seen_at` integer NOT NULL,
	`published_at` integer,
	`published_channel` text
);
--> statement-breakpoint
CREATE INDEX `ledger_owner_repo_time` ON `change_ledger` (`owner_id`,`repo`,`first_seen_at`);--> statement-breakpoint
CREATE INDEX `ledger_candidate` ON `change_ledger` (`candidate_id`);
