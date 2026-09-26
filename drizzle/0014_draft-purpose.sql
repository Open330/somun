ALTER TABLE `drafts` ADD `purpose` text;
--> statement-breakpoint
-- Recover only purposes supported by a retained generation result matching the original body.
-- Pruned or ambiguous history stays unknown; do not infer purpose from publication history.
WITH matched AS (
  SELECT d.id,
    MIN(CASE WHEN instr(j.user, char(10) || '## First introduction' || char(10)) > 0 THEN 'introduction' ELSE 'update' END) AS purpose
  FROM drafts d JOIN llm_jobs j ON j.owner_id = d.owner_id AND j.candidate_id = d.candidate_id
    AND j.channel = d.channel AND j.lang = d.lang AND j.kind = 'draft' AND j.status = 'done'
  WHERE json_valid(j.result_json) AND j.user != ''
    AND trim(json_extract(j.result_json, '$.body')) = COALESCE(
      (SELECT e.before FROM draft_edits e WHERE e.draft_id = d.id AND e.owner_id = d.owner_id ORDER BY e.created_at, e.id LIMIT 1), d.body)
  GROUP BY d.id
  HAVING COUNT(DISTINCT CASE WHEN instr(j.user, char(10) || '## First introduction' || char(10)) > 0 THEN 'introduction' ELSE 'update' END) = 1
)
UPDATE drafts SET purpose = (SELECT purpose FROM matched WHERE matched.id = drafts.id)
WHERE id IN (SELECT id FROM matched);
--> statement-breakpoint
-- Reconcile marks affected by a known introduction; unknown legacy posts retain their old behavior.
UPDATE change_ledger SET
  published_at = (SELECT p.published_at FROM publications p LEFT JOIN drafts d ON d.id = p.draft_id AND d.owner_id = p.owner_id
    WHERE p.owner_id = change_ledger.owner_id AND p.candidate_id = change_ledger.candidate_id
      AND COALESCE(d.purpose, 'update') != 'introduction' ORDER BY p.published_at DESC LIMIT 1),
  published_channel = (SELECT p.channel FROM publications p LEFT JOIN drafts d ON d.id = p.draft_id AND d.owner_id = p.owner_id
    WHERE p.owner_id = change_ledger.owner_id AND p.candidate_id = change_ledger.candidate_id
      AND COALESCE(d.purpose, 'update') != 'introduction' ORDER BY p.published_at DESC LIMIT 1)
WHERE first_seen_at != -1 AND EXISTS (
  SELECT 1 FROM publications p JOIN drafts d ON d.id = p.draft_id AND d.owner_id = p.owner_id
  WHERE p.owner_id = change_ledger.owner_id AND p.candidate_id = change_ledger.candidate_id AND d.purpose = 'introduction'
);
