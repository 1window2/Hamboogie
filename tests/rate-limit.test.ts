import {describe, expect, it} from "vitest";
import {chunkForLimit, RateLimiter} from "../src/main/llm/rate-limit";

describe("chunkForLimit", () => {
    it("한도 이하면 하나씩, 넘으면 한도만큼으로 고르게 나눈다", () => {
        expect(chunkForLimit([1, 2, 3], 5)).toEqual([[1], [2], [3]]);
        expect(chunkForLimit([1, 2, 3, 4, 5, 6], 5).map((chunk) => chunk.length)).toEqual([2, 1, 1, 1, 1]);
        expect(chunkForLimit(Array.from({length: 12}, (_, i) => i), 5).map((chunk) => chunk.length)).toEqual([3, 3, 2, 2, 2]);
        expect(chunkForLimit([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
        expect(chunkForLimit([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    });
});

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
