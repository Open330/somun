import type { BridgeStatus, RenderView, VideoBrief } from "../shared/video.js";

/**
 * 영상 서버 클라이언트. 주소는 운영자가 정한 설정값이라(사용자 입력이 아니다) 내부망 주소도 허용한다.
 */
/** 영상 서버가 응답은 했지만 거절했다(4xx) 또는 실패했다(5xx). 연결 자체가 안 되면 fetch 오류가 난다. */
export class VideoServerError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class VideoClient {
  /** publicUrl: 사용자의 bridge가 접속할 주소(somun이 쓰는 내부 주소와 다를 수 있다). */
  constructor(private readonly baseUrl: string, private readonly token: string, readonly publicUrl: string = baseUrl) {}

  /** 시간 제한은 응답 머리까지만. 본문(영상)은 브라우저로 흘려보내는 동안 끊지 않는다. */
  private async call(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`video server did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
    try {
      return await fetch(`${this.baseUrl.replace(/\/$/, "")}${path.startsWith("/v1/") ? path : `/v1/renders${path}`}`, { ...init, signal: ctrl.signal, headers: { Authorization: `Bearer ${this.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    } finally {
      clearTimeout(timer);
    }
  }

  async create(owner: string, brief: VideoBrief): Promise<RenderView> {
    const res = await this.call("", { method: "POST", body: JSON.stringify({ owner, brief }) });
    if (!res.ok) throw new VideoServerError(res.status, `video server → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as RenderView;
  }

  async get(renderId: string): Promise<RenderView | null> {
    const res = await this.call(`/${encodeURIComponent(renderId)}`, {}, 5_000);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`video server → ${res.status}`);
    return (await res.json()) as RenderView;
  }

  /** 영상 파일 응답을 그대로 넘긴다. Range는 그대로 전달한다. */
  video(renderId: string, range?: string): Promise<Response> {
    return this.call(`/${encodeURIComponent(renderId)}/video`, { headers: range ? { Range: range } : {} }, 20_000);
  }

  async remove(renderId: string): Promise<void> {
    const res = await this.call(`/${encodeURIComponent(renderId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`video server → ${res.status}`);
  }

  /** 유효한 bridge 토큰 해시 전체로 영상 서버의 목록을 바꾼다. */
  async putBridgeTokens(tokens: { id: string; owner: string; tokenHash: string }[]): Promise<void> {
    const res = await this.call("/v1/bridge-tokens", { method: "PUT", body: JSON.stringify({ tokens }) });
    if (!res.ok) throw new VideoServerError(res.status, `video server → ${res.status}`);
  }

  async bridgeStatus(owner: string): Promise<BridgeStatus[]> {
    const res = await this.call(`/v1/bridge-tokens?owner=${encodeURIComponent(owner)}`, {}, 5_000);
    if (!res.ok) throw new VideoServerError(res.status, `video server → ${res.status}`);
    return (await res.json()) as BridgeStatus[];
  }
}
