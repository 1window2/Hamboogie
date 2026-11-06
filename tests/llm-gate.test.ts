import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {defaultSettings, FREE_DAILY_LLM_REQUESTS} from "@shared/settings";
import {LlmDailyLimitError, LlmGate} from "../src/main/llm/gate";
import {LlmUsage} from "../src/main/llm/usage";
import {Logger} from "../src/main/logger";

afterEach(() => vi.useRealTimers());

describe("LlmGate 하루 요청 수", () => {
    it("분당 요청 자리를 기다리는 사이 다른 요청이 하루 요청 수를 다 쓰면 보내지 않고 오류를 던진다", async () => {
        vi.useFakeTimers({now: Date.UTC(2026, 10, 6, 3, 0)});
        // 무료 등급(분당 5회)에서 하루 요청 수가 5개 남은 상황입니다.
        const usage = new LlmUsage(() => ({resetAt: Date.now() + 60 * 60 * 1000, count: FREE_DAILY_LLM_REQUESTS - 5}), () => {});
        const logger = new Logger(join(mkdtempSync(join(tmpdir(), "hamboogie-gate-")), "test.log"));
        const gate = new LlmGate({settings: () => defaultSettings(), secrets: {get: () => "dummy-key"}, logger, usage}, async () => {});
        for (let i = 0; i < 4; i++) await gate.request();
        expect(usage.count).toBe(FREE_DAILY_LLM_REQUESTS - 1);

        // 하나는 남은 분당 자리로 바로 보내고, 다른 하나는 자리를 기다리다가 하루 요청 수가 다 찬 것을 봅니다.
        const first = gate.request();
        const second = gate.request().then(() => "sent", (error: unknown) => error);
        await first;
        expect(usage.count).toBe(FREE_DAILY_LLM_REQUESTS);
        await vi.advanceTimersByTimeAsync(61 * 1000);
        expect(await second).toBeInstanceOf(LlmDailyLimitError);
        expect(usage.count).toBe(FREE_DAILY_LLM_REQUESTS);
        expect(logger.recent().some((entry) => entry.message.includes("분당 요청 한도"))).toBe(true);
    });
});
