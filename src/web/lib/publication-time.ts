/** datetime-local은 브라우저의 현지 시각으로 입력·해석한다. */
export function localDateTime(at = Date.now()): string {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
