CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`repo` text NOT NULL,
	`key` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`latest_judgment_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_owner_key` ON `candidates` (`owner_id`,`key`);--> statement-breakpoint
CREATE INDEX `candidates_owner_status` ON `candidates` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `candidates_owner_updated` ON `candidates` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `draft_edits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`draft_id` integer NOT NULL,
	`channel` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`promoted_example_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `draft_edits_draft` ON `draft_edits` (`draft_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`candidate_id` integer NOT NULL,
	`channel` text NOT NULL,
	`version` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`media_hint` text,
	`lint` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drafts_candidate` ON `drafts` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `drafts_owner_status` ON `drafts` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `examples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`channel` text NOT NULL,
	`lang` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `examples_owner_channel_active` ON `examples` (`owner_id`,`channel`,`active`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_owner_time` ON `feedback` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`candidate_id` integer NOT NULL,
	`scores` text NOT NULL,
	`total` integer NOT NULL,
	`reasoning` text NOT NULL,
	`decision` text NOT NULL,
	`suggested_channels` text NOT NULL,
	`model` text NOT NULL,
	`overridden_decision` text,
	`override_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `judgments_candidate` ON `judgments` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `llm_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`candidate_id` integer NOT NULL,
	`channel` text,
	`system` text NOT NULL,
	`user` text NOT NULL,
	`schema_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`runner` text,
	`result_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_owner_status` ON `llm_jobs` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_candidate` ON `llm_jobs` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `llm_key_state` (
	`label` text PRIMARY KEY NOT NULL,
	`last_used_at` integer NOT NULL,
	`cooldown_until` integer,
	`cooldown_reason` text,
	`day_key` text NOT NULL,
	`day_count` integer DEFAULT 0 NOT NULL,
	`last_quota_id` text,
	`last_retry_delay` text,
	`last_error_at` integer
);
--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`repo` text NOT NULL,
	`at` integer NOT NULL,
	`stars` integer NOT NULL,
	`forks` integer NOT NULL,
	`views_uniques_14d` integer,
	`referrers` text,
	`npm_downloads_month` integer
);
--> statement-breakpoint
CREATE INDEX `metrics_owner_repo_time` ON `metric_snapshots` (`owner_id`,`repo`,`at`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`candidate_id` integer NOT NULL,
	`draft_id` integer,
	`channel` text NOT NULL,
	`url` text NOT NULL,
	`published_at` integer NOT NULL,
	`manual_stats` text
);
--> statement-breakpoint
CREATE INDEX `publications_candidate` ON `publications` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `publications_owner_time` ON `publications` (`owner_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`source_id` integer NOT NULL,
	`kind` text NOT NULL,
	`repo` text NOT NULL,
	`ref` text NOT NULL,
	`title` text NOT NULL,
	`payload` text,
	`occurred_at` integer NOT NULL,
	`candidate_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signals_owner_ref` ON `signals` (`owner_id`,`ref`);--> statement-breakpoint
CREATE INDEX `signals_owner_repo_time` ON `signals` (`owner_id`,`repo`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `signals_candidate` ON `signals` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`targets` text NOT NULL,
	`options` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_polled_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `sources_owner` ON `sources` (`owner_id`);