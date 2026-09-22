ALTER TABLE `llm_jobs` ADD `executor` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_jobs` ADD `continuation` text;