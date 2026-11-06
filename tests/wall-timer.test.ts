import {afterEach, describe, expect, it, vi} from "vitest";
import {WallTimer} from "../src/main/pipeline/wall-timer";

const START = new Date(2026, 10, 6, 12, 0).getTime();
const MINUTE = 60 * 1000;

afterEach(() => vi.useRealTimers());

describe("WallTimer", () => {
    it("정한 시각이 되면 한 번 부른다", async () => {
        vi.useFakeTimers({now: START});
        const due = vi.fn();
        const timer = new WallTimer(START + 2500, Date.now, due);
        await vi.advanceTimersByTimeAsync(2499);
        expect(due).not.toHaveBeenCalled();
        expect(timer.pending).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(due).toHaveBeenCalledTimes(1);
        expect(timer.pending).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(due).toHaveBeenCalledTimes(1);
    });

    it("멀리 있는 시각도 한 번에 기다리지 않고 최대 1분마다 시계를 다시 본다", async () => {
        vi.useFakeTimers({now: START});
        const now = vi.fn(() => Date.now());
        const due = vi.fn();
        new WallTimer(START + 10 * MINUTE, now, due);
        expect(vi.getTimerCount()).toBe(1);
        const before = now.mock.calls.length;
        await vi.advanceTimersByTimeAsync(MINUTE);
        // 1분 뒤 시계를 다시 보고 또 기다립니다.
        expect(now.mock.calls.length).toBeGreaterThan(before);
        expect(due).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(9 * MINUTE);
        expect(due).toHaveBeenCalledTimes(1);
    });

    it("잠든 사이 시계가 시각을 지나 버렸으면 다음 확인(최대 1분) 안에 부르고, check()를 부르면 바로 부른다", async () => {
        vi.useFakeTimers({now: START});
        const late = vi.fn();
        new WallTimer(START + 30 * MINUTE, Date.now, late);
        // 타이머는 돌지 않고 시계만 지난 상황(잠자기)입니다.
        vi.setSystemTime(START + 45 * MINUTE);
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(late).toHaveBeenCalledTimes(1);

        vi.setSystemTime(START);
        const woke = vi.fn();
        const timer = new WallTimer(START + 30 * MINUTE, Date.now, woke);
        vi.setSystemTime(START + 45 * MINUTE);
        timer.check();
        await vi.advanceTimersByTimeAsync(0);
        expect(woke).toHaveBeenCalledTimes(1);
    });

    it("취소하면 부르지 않고, 취소한 뒤 check()를 불러도 부르지 않는다", async () => {
        vi.useFakeTimers({now: START});
        const due = vi.fn();
        const timer = new WallTimer(START + 1000, Date.now, due);
        timer.cancel();
        expect(timer.pending).toBe(false);
        timer.check();
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(due).not.toHaveBeenCalled();
    });
});
