CREATE TABLE `bridge_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `bridge_tokens_owner` ON `bridge_tokens` (`owner_id`);