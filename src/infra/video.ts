import type { RenderView, VideoBrief } from "../shared/video.js";

/**
 * 영상 서버 클라이언트. 주소는 운영자가 정한 설정값이라(사용자 입력이 아니다) 내부망 주소도 허용한다.
 */
export class VideoClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async call(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/renders${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${this.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    return res;
  }

  async create(owner: string, brief: VideoBrief): Promise<RenderView> {
    const res = await this.call("", { method: "POST", body: JSON.stringify({ owner, brief }) });
    if (!res.ok) throw new Error(`video server → ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    return this.call(`/${encodeURIComponent(renderId)}/video`, { headers: range ? { Range: range } : {} }, 60_000);
  }

  async remove(renderId: string): Promise<void> {
    const res = await this.call(`/${encodeURIComponent(renderId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`video server → ${res.status}`);
  }
}
