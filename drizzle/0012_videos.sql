CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`candidate_id` integer NOT NULL,
	`draft_id` integer,
	`render_id` text NOT NULL,
	`lang` text NOT NULL,
	`duration_sec` integer NOT NULL,
	`aspect` text NOT NULL,
	`status` text NOT NULL,
	`phase` text DEFAULT '' NOT NULL,
	`note` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `videos_owner_candidate` ON `videos` (`owner_id`,`candidate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `videos_render` ON `videos` (`render_id`);