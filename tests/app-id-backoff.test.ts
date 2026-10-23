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

    it("거절이 30분 넘게 이어질 때만 기기 정보를 새로 받으라고 알린다", () => {
        let now = 0;
        const backoff = new AppIdBackoff(() => now);
        const results: boolean[] = [];
        for (let i = 0; i < 8; i++) {
            results.push(backoff.fail());
            now += 5 * MINUTE;
        }
        // 0, 5, 10, 15, 20, 25분은 쉬기만 하고, 30분째에 처음으로 새 기기를 받으라고 합니다.
        expect(results).toEqual([false, false, false, false, false, false, true, false]);
    });
});
