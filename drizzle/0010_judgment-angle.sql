ALTER TABLE `judgments` ADD `angle` text;--> statement-breakpoint
-- 예전 판단은 이유 끝에 "\n\n각도: …"를 붙여 저장했다. 각도를 컬럼으로 옮기고 이유에서 뗀다(UPDATE의 식은 모두 바꾸기 전 값을 본다).
UPDATE `judgments` SET
  `angle` = NULLIF(trim(substr(`reasoning`, instr(`reasoning`, char(10) || char(10) || '각도:') + 5)), ''),
  `reasoning` = substr(`reasoning`, 1, instr(`reasoning`, char(10) || char(10) || '각도:') - 1)
WHERE `angle` IS NULL AND instr(`reasoning`, char(10) || char(10) || '각도:') > 0;
