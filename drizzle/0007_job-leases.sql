ALTER TABLE `llm_jobs` ADD `claim_token` text;
--> statement-breakpoint
ALTER TABLE `llm_jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `llm_jobs` SET `status` = 'pending', `runner` = NULL, `claimed_at` = NULL WHERE `status` = 'claimed';
