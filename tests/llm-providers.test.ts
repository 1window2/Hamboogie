import {afterEach, describe, expect, it, vi} from "vitest";

const {parse} = vi.hoisted(() => ({parse: vi.fn()}));

// 네트워크에 나가지 않도록 OpenAI SDK를 가짜로 바꿉니다.
vi.mock("openai", () => ({
    default: class {
        responses = {parse};
    }
}));
vi.mock("openai/helpers/zod", () => ({zodTextFormat: () => ({type: "json_schema"})}));

const {createProvider, LlmError} = await import("../src/main/llm/providers");

const DECISION = {
    is_giveaway: true, item: null, is_food: true, food_unknown: false, line_method: "text", line_text: null, dccon_keyword: null,
    member_requirement: "any", participant_limit: null, manager_ok: true, submanager_ok: true, regular_ok: true, starts_at: null, ends_at: null, text_only: false, needs_extra_action: false, image_text: null, reason: "나눔"
};
const httpError = (status: number, message: string) => Object.assign(new Error(message), {status});

afterEach(() => {
    parse.mockReset();
    vi.useRealTimers();
});

describe("LLM 일시적 오류 다시 보내기", () => {
    it("서버 과부하(503)면 한 번 더 보내고, 다시 보내기 전에 요청 수를 센다", async () => {
        vi.useFakeTimers();
        parse.mockRejectedValueOnce(httpError(503, "Service Unavailable")).mockResolvedValueOnce({output_parsed: DECISION, usage: {input_tokens: 1, output_tokens: 1}});
        const beforeRetry = vi.fn(async () => {});
        const provider = createProvider("openai", "dummy-key", "gpt-test", {beforeRetry});
        const decided = provider.decide({title: "치킨 나눔", body: ""});
        await vi.advanceTimersByTimeAsync(2000);
        expect(await decided).toEqual(DECISION);
        expect(parse).toHaveBeenCalledTimes(2);
        expect(beforeRetry).toHaveBeenCalledTimes(1);
    });

    it("다시 보내도 풀리지 않는 오류(401)는 다시 보내지 않는다", async () => {
        parse.mockRejectedValueOnce(httpError(401, "Incorrect API key"));
        const beforeRetry = vi.fn(async () => {});
        const provider = createProvider("openai", "dummy-key", "gpt-test", {beforeRetry});
        await expect(provider.decide({title: "치킨 나눔", body: ""})).rejects.toBeInstanceOf(LlmError);
        expect(parse).toHaveBeenCalledTimes(1);
        expect(beforeRetry).not.toHaveBeenCalled();
    });
});
