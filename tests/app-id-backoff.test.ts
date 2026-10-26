import {describe, expect, it} from "vitest";
import {AppIdBackoff} from "../src/main/dc/app-id-backoff";

describe("AppIdBackoff", () => {
    const MINUTE = 60 * 1000;

    it("거절되면 5분 동안 쉬고, 성공하면 바로 풀린다", () => {
        let now = 0;
        const backoff = new AppIdBackoff(() => now);
        expect(backoff.canTry()).toBe(true);
        expect(backoff.fail()).toBe(false);
        expect(backoff.canTry()).toBe(false);
        now += 5 * MINUTE;
        expect(backoff.canTry()).toBe(true);
        backoff.fail();
        backoff.succeed();
        expect(backoff.canTry()).toBe(true);
        expect(backoff.failing).toBe(false);
    });

    it("거절이 이어질수록 쉬는 시간을 두 배로 늘린다(최대 1시간)", () => {
        let now = 0;
        const backoff = new AppIdBackoff(() => now);
        const pauses: number[] = [];
        for (let i = 0; i < 6; i++) {
            backoff.fail();
            pauses.push(backoff.lastPauseMs / MINUTE);
            now += backoff.lastPauseMs;
        }
        expect(pauses).toEqual([5, 10, 20, 40, 60, 60]);
    });

    it("거절이 30분 넘게 이어지면 기기 정보를 새로 받으라고 하되, 하루에 한 번까지만", () => {
        let now = 0;
        const backoff = new AppIdBackoff(() => now);
        const fresh: number[] = [];
        // 거절이 30시간 동안 이어지는 상황입니다.
        while (now < 30 * 60 * MINUTE) {
            if (backoff.fail()) fresh.push(now / MINUTE);
            now += backoff.lastPauseMs;
        }
        // 0, 5, 15분은 쉬기만 하고 35분째에 처음으로, 그 뒤에는 하루가 지난 뒤에야 다시 새 기기를 받으라고 합니다.
        expect(fresh[0]).toBe(35);
        expect(fresh).toHaveLength(2);
        expect(fresh[1]! - fresh[0]!).toBeGreaterThanOrEqual(24 * 60);
    });

    it("앱 버전 때문에 정한 시간만큼 쉬어야 하면 그 시간을 쓴다", () => {
        const backoff = new AppIdBackoff(() => 0);
        backoff.fail(6 * 60 * MINUTE);
        expect(backoff.lastPauseMs).toBe(6 * 60 * MINUTE);
    });
});
