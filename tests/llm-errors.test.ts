import {describe, expect, it} from "vitest";
import {describeLlmError, LlmError} from "../src/main/llm/providers";

describe("describeLlmError", () => {
    it("Gemini의 JSON 오류 메시지에서 핵심 문장만 꺼낸다", () => {
        const error = Object.assign(new Error(JSON.stringify({error: {code: 429, message: "You exceeded your current quota.\n* Quota exceeded for metric: ..."}})), {status: 429});
        expect(describeLlmError("Gemini", error)).toBe("Gemini 요청 한도 초과 (429): You exceeded your current quota.");
    });

    it("시간 초과는 따로 표시한다", () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        expect(describeLlmError("Gemini", error)).toBe("Gemini 응답 시간 초과 (30초)");
    });

    it("상태 코드가 없는 오류와 이미 정리된 오류는 그대로 쓴다", () => {
        expect(describeLlmError("Claude", new Error("network down"))).toBe("Claude 오류: network down");
        expect(describeLlmError("Claude", new LlmError("Claude가 이 글의 분석을 거절했습니다."))).toBe("Claude가 이 글의 분석을 거절했습니다.");
    });
});
