ALTER TABLE `drafts` ADD `style_key` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `edit_ratio` real;--> statement-breakpoint
ALTER TABLE `examples` ADD `draft_id` integer;--> statement-breakpoint
ALTER TABLE `llm_jobs` ADD `draft_id` integer;--> statement-breakpoint
CREATE INDEX `jobs_executor_status` ON `llm_jobs` (`executor`,`status`,`id`);