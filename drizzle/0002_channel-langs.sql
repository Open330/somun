ALTER TABLE `drafts` ADD `lang` text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_jobs` ADD `lang` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `lang` text;--> statement-breakpoint
UPDATE `drafts` SET `lang` = 'en', `channel` = 'x' WHERE `channel` = 'x_en';--> statement-breakpoint
UPDATE `drafts` SET `lang` = 'ko', `channel` = 'x' WHERE `channel` = 'x_ko';--> statement-breakpoint
UPDATE `drafts` SET `lang` = 'ko', `channel` = 'linkedin' WHERE `channel` = 'linkedin_ko';--> statement-breakpoint
UPDATE `drafts` SET `lang` = 'ko' WHERE `channel` IN ('threads', 'show_gn', 'blog_outline');--> statement-breakpoint
UPDATE `drafts` SET `channel` = 'blog' WHERE `channel` = 'blog_outline';--> statement-breakpoint
UPDATE `examples` SET `channel` = 'x' WHERE `channel` IN ('x_en', 'x_ko');--> statement-breakpoint
UPDATE `examples` SET `channel` = 'linkedin' WHERE `channel` = 'linkedin_ko';--> statement-breakpoint
UPDATE `examples` SET `channel` = 'blog' WHERE `channel` = 'blog_outline';--> statement-breakpoint
UPDATE `publications` SET `lang` = CASE WHEN `channel` IN ('x_en','show_hn') THEN 'en' ELSE 'ko' END, `channel` = CASE `channel` WHEN 'x_en' THEN 'x' WHEN 'x_ko' THEN 'x' WHEN 'linkedin_ko' THEN 'linkedin' WHEN 'blog_outline' THEN 'blog' ELSE `channel` END;--> statement-breakpoint
UPDATE `draft_edits` SET `channel` = CASE `channel` WHEN 'x_en' THEN 'x' WHEN 'x_ko' THEN 'x' WHEN 'linkedin_ko' THEN 'linkedin' WHEN 'blog_outline' THEN 'blog' ELSE `channel` END;--> statement-breakpoint
UPDATE `llm_jobs` SET `lang` = CASE WHEN `channel` IN ('x_en','show_hn') THEN 'en' ELSE 'ko' END, `channel` = CASE `channel` WHEN 'x_en' THEN 'x' WHEN 'x_ko' THEN 'x' WHEN 'linkedin_ko' THEN 'linkedin' WHEN 'blog_outline' THEN 'blog' ELSE `channel` END WHERE `channel` IS NOT NULL;
