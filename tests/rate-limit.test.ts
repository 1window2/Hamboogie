import {describe, expect, it} from "vitest";
import {RateLimiter} from "../src/main/llm/rate-limit";

describe("RateLimiter", () => {
    it("최근 1분 동안 한도만큼만 바로 보내고, 그다음은 가장 오래된 요청이 1분을 넘길 때까지 기다린다", async () => {
        let now = 0;
        const waits: number[] = [];
        const limiter = new RateLimiter(() => 2, () => now, async (ms) => {
            waits.push(ms);
            now += ms;
        });
        await limiter.acquire();
        now = 10_000;
        await limiter.acquire();
        expect(limiter.available()).toBe(0);
        await limiter.acquire();
        expect(waits).toEqual([50_000]);
        expect(now).toBe(60_000);
    });

    it("한도가 0이면 제한하지 않는다", () => {
        expect(new RateLimiter(() => 0).available()).toBe(Infinity);
    });
});
