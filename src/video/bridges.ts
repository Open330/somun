import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameSecret } from "../server/auth.js";

/**
 * bridge 토큰 등록부. 두 곳에서 온다.
 *  - 운영자 설정(VIDEO_BRIDGE_TOKENS): "token" 또는 "owner=token". 원문을 안다.
 *  - somun이 사용자별로 발급한 토큰: somun이 해시만 보낸다(PUT /v1/bridge-tokens). 원문은 사용자에게만 한 번 보인다.
 * 마지막으로 연결한 시각을 기억해 somun 화면이 "bridge 연결됨"을 보여 줄 수 있게 한다.
 */
export type IssuedToken = { id: string; owner: string; tokenHash: string };
export type BridgeIdentity = { owner: string; id: string };

export const hashBridgeToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** 이 시간 안에 롱 폴링을 했으면 연결된 것으로 본다(bridge는 25초마다 다시 묻는다). */
const CONNECTED_MS = 90_000;

export class BridgeRegistry {
  private issued = new Map<string, IssuedToken>(); // tokenHash → token
  private readonly lastSeen = new Map<string, number>(); // id → 시각
  private readonly file: string;

  constructor(dataDir: string, private readonly configured: { owner: string; token: string }[], private readonly now: () => number = Date.now) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "bridge-tokens.json");
    if (existsSync(this.file)) {
      // 망가진 파일로 서버가 뜨지 못하면 안 된다. 빈 목록으로 시작하고 somun의 다음 동기화(5분 안)가 채운다.
      try { this.load(JSON.parse(readFileSync(this.file, "utf8")) as IssuedToken[]); } catch { this.issued = new Map(); }
    }
  }

  private persist() {
    const tokens = [...this.issued.values()];
    writeFileSync(`${this.file}.tmp`, JSON.stringify(tokens));
    renameSync(`${this.file}.tmp`, this.file);
  }

  private load(tokens: IssuedToken[]) {
    this.issued = new Map(tokens.map((t) => [t.tokenHash, t]));
  }

  /** somun이 가진 유효 토큰 전체로 바꾼다. 폐기된 토큰은 목록에서 빠지면서 바로 막힌다. */
  replace(tokens: IssuedToken[]): void {
    this.load(tokens);
    this.persist();
  }

  /** 발급 하나. 같은 id가 있으면 바꾼다. */
  add(token: IssuedToken): void {
    for (const [h, t] of this.issued) if (t.id === token.id) this.issued.delete(h);
    this.issued.set(token.tokenHash, token);
    this.persist();
  }

  /** 폐기 하나. 없어도 성공(이미 빠졌다). */
  remove(id: string): void {
    for (const [h, t] of this.issued) if (t.id === id) this.issued.delete(h);
    this.persist();
  }

  authenticate(token: string): BridgeIdentity | null {
    if (!token) return null;
    const fixed = this.configured.findIndex((b) => sameSecret(token, b.token));
    const who = fixed >= 0 ? { owner: this.configured[fixed].owner, id: `env:${fixed}` } : (() => { const t = this.issued.get(hashBridgeToken(token)); return t ? { owner: t.owner, id: t.id } : null; })();
    if (who) this.lastSeen.set(who.id, this.now());
    return who;
  }

  /** 토큰별 마지막 연결 시각. owner를 주면 그 소유자의 것만. */
  status(owner?: string): { id: string; owner: string; lastSeenAt?: number; connected: boolean }[] {
    const rows = [...this.issued.values()].filter((t) => !owner || t.owner === owner).map((t) => ({ id: t.id, owner: t.owner }));
    // 운영자 토큰 중 모든 소유자용("*")은 누구의 영상이든 가져가므로 함께 보여 준다.
    this.configured.forEach((b, i) => { if (!owner || b.owner === owner || b.owner === "*") rows.push({ id: `env:${i}`, owner: b.owner }); });
    return rows.map((r) => { const at = this.lastSeen.get(r.id); return { ...r, lastSeenAt: at, connected: at !== undefined && this.now() - at < CONNECTED_MS }; });
  }
}
