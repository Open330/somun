import { Fragment, type ReactNode } from "react";
import { t } from "./index";

/**
 * 문장 안에 요소(링크, 코드, 입력칸)가 끼는 번역. 문장을 조각으로 나누면 언어마다 어순이 달라 번역할 수 없다.
 * 문장 전체를 키로 두고 {이름} 자리에 요소를 끼운다: tr("나중에 {link}에서 바꿀 수 있습니다.", { link: <a …/> }).
 */
export function tr(ko: string, slots: Record<string, ReactNode>): ReactNode {
  return t(ko).split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name && name in slots ? <Fragment key={i}>{slots[name]}</Fragment> : part;
  });
}
