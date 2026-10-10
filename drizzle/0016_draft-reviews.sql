CREATE TABLE `draft_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`draft_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`active_seconds` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `draft_reviews_owner_draft` ON `draft_reviews` (`owner_id`,`draft_id`);