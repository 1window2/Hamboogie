import {describe, expect, it} from "vitest";
import {isQuotaExhausted, nextPacificMidnight} from "../src/main/llm/providers";

function apiError(status: number, message: string) {
    return Object.assign(new Error(message), {status});
}

describe("LLM 요청 한도 소진 판별", () => {
    it("하루 한도(PerDay)나 기다릴 시간이 없는 quota 초과만 소진으로 본다", () => {
        expect(isQuotaExhausted(apiError(429, '{"error":{"message":"You exceeded your current quota","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"retryDelay":"38s"}]}}'))).toBe(true);
        expect(isQuotaExhausted(apiError(429, "You exceeded your current quota, please check your plan and billing details."))).toBe(true);
        expect(isQuotaExhausted(apiError(429, "insufficient_quota"))).toBe(true);
        // 분당 한도는 잠깐 기다리면 풀립니다.
        expect(isQuotaExhausted(apiError(429, "You exceeded your current quota. Please retry in 12.3s."))).toBe(false);
        expect(isQuotaExhausted(apiError(503, "You exceeded your current quota"))).toBe(false);
    });

    it("다음 태평양 시간 자정을 계산한다", () => {
        // 2026-10-25 03:00 UTC = 10-24 20:00 PDT → 다음 자정은 10-25 07:00 UTC
        expect(new Date(nextPacificMidnight(Date.UTC(2026, 9, 25, 3, 0, 0))).toISOString()).toBe("2026-10-25T07:00:00.000Z");
        // 분과 초가 있는 시각에서도 정확히 자정이어야 합니다.
        expect(new Date(nextPacificMidnight(Date.UTC(2026, 9, 25, 4, 32, 59, 123))).toISOString()).toBe("2026-10-25T07:00:00.000Z");
        // 서머타임이 끝난 뒤(PST, UTC-8)에는 08:00 UTC입니다.
        expect(new Date(nextPacificMidnight(Date.UTC(2026, 10, 10, 20, 45, 30))).toISOString()).toBe("2026-11-11T08:00:00.000Z");
    });
});
