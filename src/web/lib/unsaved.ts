/**
 * 저장하지 않은 수정이 있는지. 화면 전체를 다시 그리는 동작(언어 바꾸기) 전에 묻기 위해 쓴다.
 * 초안 편집기가 켜고 끈다.
 */
let dirty = false;
export const setUnsaved = (value: boolean): void => { dirty = value; };
export const hasUnsaved = (): boolean => dirty;
