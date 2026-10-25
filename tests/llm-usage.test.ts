import {describe, expect, it} from "vitest";
import {estimatedWatchHours, FREE_DAILY_LLM_REQUESTS} from "@shared/settings";
import {LlmUsage, type UsageRecord} from "../src/main/llm/usage";

describe("하루 LLM 요청 수", () => {
    it("한도까지 세고, 초기화 시각(태평양 시간 자정)이 지나면 다시 0부터 센다", () => {
        let now = Date.UTC(2026, 9, 25, 3, 0, 0);
        let saved: UsageRecord | null = null;
        const usage = new LlmUsage(() => null, (record) => (saved = record), () => now);
        usage.add(FREE_DAILY_LLM_REQUESTS);
        expect(usage.canUse(FREE_DAILY_LLM_REQUESTS)).toBe(false);
        expect(usage.canUse(0)).toBe(true);
        expect(saved).toMatchObject({count: FREE_DAILY_LLM_REQUESTS, resetAt: Date.UTC(2026, 9, 25, 7, 0, 0)});
        now = Date.UTC(2026, 9, 25, 7, 0, 1);
        expect(usage.count).toBe(0);
        expect(usage.canUse(FREE_DAILY_LLM_REQUESTS)).toBe(true);
    });

    it("앱을 다시 켜도 저장된 수에서 이어서 센다", () => {
        const now = Date.UTC(2026, 9, 25, 3, 0, 0);
        const usage = new LlmUsage(() => ({resetAt: now + 1000, count: 100}), () => {}, () => now);
        expect(usage.count).toBe(100);
    });
});

describe("하루 감시 가능 시간", () => {
    it("감시 간격에 비례하고, 갤러리 수에 반비례하며, 24시간을 넘지 않는다", () => {
        expect(estimatedWatchHours([60])).toBe(8);
        expect(estimatedWatchHours([120])).toBe(16);
        expect(estimatedWatchHours([180])).toBe(24);
        expect(estimatedWatchHours([600])).toBe(24);
        expect(estimatedWatchHours([60, 60])).toBe(4);
        expect(estimatedWatchHours([])).toBe(24);
    });
});
