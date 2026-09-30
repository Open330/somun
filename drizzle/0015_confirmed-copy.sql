ALTER TABLE `drafts` ADD `copied_at` integer;
--> statement-breakpoint
-- 과거 copied 상태에는 URL만 등록한 초안도 섞여 있다. 복사로 생긴 예시가 있는 행만 복원한다.
UPDATE drafts SET copied_at = (
  SELECT MAX(examples.created_at) FROM examples
  WHERE examples.draft_id = drafts.id AND examples.owner_id = drafts.owner_id
    AND examples.source IN ('approved', 'edited')
);
