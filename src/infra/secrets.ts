import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * DB에 저장하는 비밀값(BYOK API 키, Discord 웹훅 URL, GitHub App 개인키) 암호화. AES-256-GCM.
 * 키는 SOMUN_SECRET_KEY(아무 길이의 문자열, SHA-256으로 32바이트 키를 만든다).
 * 키가 없으면 평문 그대로 둔다(로컬 개발·기존 배포와 호환). 평문으로 저장된 값은 열 때 그대로 돌려준다.
 */
const PREFIX = "enc:v1:";

export class SecretBox {
  private readonly key?: Buffer;
  constructor(secret?: string) {
    if (secret) this.key = createHash("sha256").update(secret).digest();
  }
  get enabled(): boolean { return Boolean(this.key); }

  static isSealed(value: string): boolean { return value.startsWith(PREFIX); }

  seal(plain: string): string {
    if (!this.key || SecretBox.isSealed(plain)) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  }

  /** 봉인된 값을 연다. 평문이면 그대로. 키가 없거나 맞지 않으면 예외(조용히 틀린 값을 쓰지 않게). */
  open(value: string): string {
    if (!SecretBox.isSealed(value)) return value;
    if (!this.key) throw new Error("encrypted secret found but SOMUN_SECRET_KEY is not set");
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** 키가 없는 기본 상자(테스트·로컬). */
export const PLAIN_BOX = new SecretBox();
