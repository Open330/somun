// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEvents, subscribeEvents } from "./events";

const { fetchApiToken } = vi.hoisted(() => ({ fetchApiToken: vi.fn() }));
vi.mock("./auth/manager", () => ({ getAuthManager: () => ({ fetchApiToken }) }));
class FakeSource extends EventTarget {
  static instances: FakeSource[] = [];
  close = vi.fn();
  constructor(readonly url: string) { super(); FakeSource.instances.push(this); }
}
let unsubscribe: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); FakeSource.instances = []; fetchApiToken.mockReset().mockResolvedValue("first"); vi.stubGlobal("EventSource", FakeSource); });
afterEach(() => { for (const off of unsubscribe) off(); unsubscribe = []; resetEvents(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("shared event stream", () => {
  it("shares a connection and closes it when the last subscriber leaves", async () => {
    const a = subscribeEvents(vi.fn()), b = subscribeEvents(vi.fn()); unsubscribe.push(a, b);
    await settle();
    expect(FakeSource.instances).toHaveLength(1);
    a(); expect(FakeSource.instances[0].close).not.toHaveBeenCalled();
    b(); expect(FakeSource.instances[0].close).toHaveBeenCalledOnce();
  });
  it("does not connect after an async token resolves following unsubscription", async () => {
    let resolve!: (token: string) => void;
    fetchApiToken.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const off = subscribeEvents(vi.fn()); off();
    resolve("late"); await settle();
    expect(FakeSource.instances).toHaveLength(0);
  });
  it("fetches a fresh token on reconnect and stops retrying without subscribers", async () => {
    const off = subscribeEvents(vi.fn()); unsubscribe.push(off); await settle();
    const first = FakeSource.instances[0];
    fetchApiToken.mockResolvedValue("second");
    first.dispatchEvent(new Event("error"));
    expect(first.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSource.instances[1].url).toContain("token=second");
    FakeSource.instances[1].dispatchEvent(new Event("error"));
    off(); await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSource.instances).toHaveLength(2);
  });
  it("replaces the connection when authentication changes and ignores old events", async () => {
    const listener = vi.fn(); unsubscribe.push(subscribeEvents(listener)); await settle();
    const old = FakeSource.instances[0];
    fetchApiToken.mockResolvedValue("new-user"); resetEvents(); await settle();
    expect(old.close).toHaveBeenCalledOnce();
    old.dispatchEvent(new MessageEvent("change", { data: '{"resource":"sources"}' }));
    expect(listener).not.toHaveBeenCalled();
    expect(FakeSource.instances[1].url).toContain("new-user");
  });
});
