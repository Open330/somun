import { expect, it } from "vitest";
import { prepareIntroduction } from "./introduction-edit.js";

const options = { channel: "threads", language: "ko", purpose: "introduction", tone: "편안한 대화체, 한국어는 해요체. 과장 없이" };

it("normalizes only known sentence endings, preserving facts, conditions and protected text", () => {
  const body = 'SSH가 켜져 있을 때만 파일을 복사합니다. 전송이 완료됩니다. 실패하면 파일이 없습니다.\n"지원합니다." `있습니다.`\n```text\n완료합니다.\n```\n> 전송합니다.\n연결합니다?\n과거에는 지원했습니다.\nhttps://example.com/지원합니다.';
  expect(prepareIntroduction(body, options)).toBe('SSH가 켜져 있을 때만 파일을 복사해요. 전송이 완료돼요. 실패하면 파일이 없어요.\n"지원합니다." `있습니다.`\n```text\n완료합니다.\n```\n> 전송합니다.\n연결합니다?\n과거에는 지원했습니다.\nhttps://example.com/지원합니다.');
});

it("preserves multiline and unterminated quotes", () => {
  for (const quote of ['"지원합니다.\n계속합니다."', '"지원합니다.\n계속합니다.', "'지원합니다.\n계속합니다.'", "“지원합니다.\n계속합니다.”"]) {
    expect(prepareIntroduction(quote, options)).toBe(quote);
  }
});

it("preserves reader-situation context, sentence order and URLs", () => {
  const first = "Windows와 Mac에서 파일을 관리하려면 Acme를 사용합니다.";
  const next = "파일 창에서 항목을 복사한 뒤 다른 기기의 폴더에 붙여넣습니다.";
  const body = `${first}\n\n  ${next}\nhttps://example.com`;
  const edited = prepareIntroduction(body, { ...options, channel: "x", tone: "평서문" });
  expect(edited).toBe(body);
  expect(prepareIntroduction(edited, { ...options, channel: "x", tone: "평서문" })).toBe(edited);
  expect(prepareIntroduction(`${first} ${next} https://example.com`, { ...options, channel: "x", tone: "평서문" })).toBe(`${first} ${next} https://example.com`);
});

it("preserves conditional reader situations and directly stated operations", () => {
  const first = "Acme를 사용하면 기기의 화면과 파일을 연결할 수 있어요.";
  const next = "파일 창에서 다른 기기의 폴더로 항목을 복사해요.";
  expect(prepareIntroduction(`${first} ${next}`, options)).toBe(`${first} ${next}`);
  expect(prepareIntroduction("SSH로 원격 기기의 파일을 복사해요. 저장된 계정을 재사용해요.", options)).toBe("SSH로 원격 기기의 파일을 복사해요. 저장된 계정을 재사용해요.");
});

it.each([
  "Windows 11에서 파일을 관리하려면 Acme를 사용합니다. 파일 창을 엽니다.",
  "권한이 있을 때 파일을 관리하려면 Acme를 사용합니다. 파일 창을 엽니다.",
  "파일을 관리하려면 Acme를 사용합니다. 이를 통해 파일을 복사합니다.",
  "파일을 관리하려면 Acme를 사용합니다. 이 파일을 복사합니다.",
  "파일을 관리하려면 Acme를 사용합니다. 기능이 다양합니다.",
  "유료 회원에 한해 파일을 관리하려면 Acme를 사용합니다. 파일 창에서 문서를 복사합니다.",
  "회원만 파일을 관리하려면 Acme를 사용합니다. 파일 창에서 문서를 복사합니다.",
  "파일을 관리하려면 Acme를 사용합니다. 그 뒤 파일 창을 엽니다.",
  "파일을 관리하려면 Acme를 사용합니다. 이 기능은 파일을 복사합니다.",
  "파일을 관리하려면 Acme를 사용합니다. 원격 화면의 고성능 모드를 켜서 파일을 확인합니다.",
])("does not reorder conditions, dependent references or an unrecognized follow-up: %s", body => {
  expect(prepareIntroduction(body, { ...options, channel: "x", tone: "평서문" })).toBe(body);
});

it("leaves updates, other languages, custom channels and explicit style requests intact", () => {
  const body = "Acme는 파일 도구입니다. 파일 창을 엽니다. 파일을 복사합니다.";
  for (const patch of [{ purpose: "update" }, { language: "en" }, { channel: "custom_demo" }, { editorInstruction: "합니다체를 유지하세요" }]) {
    expect(prepareIntroduction(body, { ...options, ...patch })).toBe(body);
  }
  expect(prepareIntroduction("파일을 복사합니다.", { ...options, tone: "해요체 대신 합니다체" })).toBe("파일을 복사합니다.");
  const reordered = prepareIntroduction(body, options);
  expect(prepareIntroduction(reordered, options)).toBe(reordered);
});


it.each([
  ["소개합니다", "소\u200b개합니다."],
  ["Ａcme 소개합니다", "Acme 소개합니다."],
  ["game-changer 소개합니다", "game—changer 소개합니다."],
  ["지금 소개합니다", "지금\n소개합니다."],
])("preserves normalized banned phrase %s without hiding its warning", (phrase, body) => {
  expect(prepareIntroduction(body, { ...options, bannedPhrases: [phrase] })).toBe(body);
});


it("preserves product identity before its supporting workflow", () => {
  const body = "Acme는 원격 기기의 화면을 조작하고 파일을 복사하는 소프트웨어입니다. 파일 창에서 다른 기기의 폴더를 엽니다.";
  expect(prepareIntroduction(body, { ...options, channel: "x", tone: "평서문" })).toBe(body);
});
