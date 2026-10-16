import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdleTimer } from "./idle";

function Probe({ seconds, onIdle, enabled }: { seconds: number; onIdle: () => void; enabled?: boolean }) {
  useIdleTimer({ seconds, onIdle, ...(enabled === undefined ? {} : { enabled }) });
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useIdleTimer", () => {
  it("fires once, after the idle time, and never again", () => {
    const onIdle = vi.fn();
    render(<Probe seconds={10} onIdle={onIdle} />);
    wait(9_999);
    expect(onIdle).not.toHaveBeenCalled();
    wait(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    wait(120_000);
    fireEvent.pointerDown(window);
    wait(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("every kind of activity starts the count again", () => {
    for (const make of [() => fireEvent.pointerDown(document.body), () => fireEvent.pointerMove(document.body), () => fireEvent.keyDown(document.body, { key: "a" }), () => fireEvent.touchStart(document.body), () => fireEvent.wheel(document.body), () => fireEvent.scroll(document.body)]) {
      const onIdle = vi.fn();
      const { unmount } = render(<Probe seconds={10} onIdle={onIdle} />);
      wait(8_000);
      make();
      wait(8_000);
      expect(onIdle).not.toHaveBeenCalled();
      wait(2_000);
      expect(onIdle).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("is off when disabled or when the time is zero or negative", () => {
    for (const props of [{ seconds: 10, enabled: false }, { seconds: 0 }, { seconds: -5 }, { seconds: Number.NaN }]) {
      const onIdle = vi.fn();
      const { unmount } = render(<Probe onIdle={onIdle} {...props} />);
      wait(10 * 60_000);
      expect(onIdle).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("starts counting when it is switched on", () => {
    const onIdle = vi.fn();
    const { rerender } = render(<Probe seconds={5} onIdle={onIdle} enabled={false} />);
    wait(60_000);
    rerender(<Probe seconds={5} onIdle={onIdle} enabled />);
    wait(4_999);
    expect(onIdle).not.toHaveBeenCalled();
    wait(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("uses the latest handler, and stops when it is removed from the page", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<Probe seconds={5} onIdle={first} />);
    rerender(<Probe seconds={5} onIdle={second} />);
    wait(5_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    const gone = vi.fn();
    const mounted = render(<Probe seconds={5} onIdle={gone} />);
    mounted.unmount();
    fireEvent.pointerDown(window);
    wait(60_000);
    expect(gone).not.toHaveBeenCalled();
    unmount();
  });

  it("a page that was asleep locks at once when it comes back (timers stop in background tabs)", () => {
    const onIdle = vi.fn();
    render(<Probe seconds={60} onIdle={onIdle} />);
    // the clock moves on while the tab is hidden and no timer runs
    vi.setSystemTime(Date.now() + 61_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).not.toHaveBeenCalled(); // still hidden: nothing to lock yet
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).toHaveBeenCalledTimes(1);
    wait(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("waking the page again after it has already locked does not lock it a second time", () => {
    const onIdle = vi.fn();
    render(<Probe seconds={10} onIdle={onIdle} />);
    wait(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 600_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("coming back before the time is up does not lock", () => {
    const onIdle = vi.fn();
    render(<Probe seconds={60} onIdle={onIdle} />);
    vi.setSystemTime(Date.now() + 30_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onIdle).not.toHaveBeenCalled();
  });
});
