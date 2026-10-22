/** 금지어 비교용. 전각·호환 문자, 보이지 않는 문자, 여러 칸 띄우기와 줄바꿈, 하이픈 변형으로 피해 가지 못하게 한다. */
export const normalizeForMatch = (value: string) =>
  value.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ").toLowerCase();
