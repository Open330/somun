CREATE TABLE `usage_outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_outbox_next` ON `usage_outbox` (`next_at`);