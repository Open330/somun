ALTER TABLE `change_ledger` ADD `disputed_at` integer;--> statement-breakpoint
ALTER TABLE `drafts` ADD `voice` text;--> statement-breakpoint
CREATE TABLE `guide_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`rule` text NOT NULL,
	`normalized` text NOT NULL,
	`category` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`sources` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guide_sugg_owner_status` ON `guide_suggestions` (`owner_id`,`status`);
