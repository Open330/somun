ALTER TABLE `llm_jobs` ADD `meta` text;--> statement-breakpoint
ALTER TABLE `repo_profiles` ADD `generated_at` integer;--> statement-breakpoint
-- 모델이 만든 기존 프로필은 마지막 갱신 시각을 생성 시각으로 본다(사용자 수정만 있는 빈 행은 제외).
UPDATE `repo_profiles` SET `generated_at` = `updated_at` WHERE `model` != 'user';
