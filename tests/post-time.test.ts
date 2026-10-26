import {describe, expect, it} from "vitest";
import {buildBatchMessage, buildUserMessage} from "../src/main/llm/decision";
import {formatKst, postedAtRange} from "../src/main/pipeline/post-time";

/** 한국 시간 2026-10-25 hh:mm:ss */
const kst = (hours: number, minutes = 0, seconds = 0, day = 25) => Date.UTC(2026, 9, day, hours - 9, minutes, seconds);
const estimatePostedAt = (raw: (string | undefined)[], detectedAt: number) => postedAtRange(raw, detectedAt).latest;

describe("글을 올린 시각 추정", () => {
    it("초까지 있는 날짜 시각은 그대로 쓴다", () => {
        expect(estimatePostedAt(["2026.10.25 16:19:33"], kst(16, 20))).toBe(kst(16, 19, 33));
        expect(estimatePostedAt(["2026-10-25 16:19:33"], kst(16, 20))).toBe(kst(16, 19, 33));
    });

    it("디시가 실제로 주는 형식: 글 읽기는 초 없는 날짜 시각, 지난 글 목록은 날짜만", () => {
        expect(estimatePostedAt(["2026.10.25 16:19", "16:19"], kst(16, 20, 5))).toBe(kst(16, 19, 59));
        expect(estimatePostedAt(["2025.04.23"], kst(16, 20))).toBe(kst(16, 20));
    });

    it("초가 없으면 그 분의 마지막 초로 보되, 감지한 시각보다 늦게 잡지 않는다", () => {
        expect(estimatePostedAt(["2026.10.25 16:19"], kst(16, 21))).toBe(kst(16, 19, 59));
        expect(estimatePostedAt(["16:19"], kst(16, 19, 20))).toBe(kst(16, 19, 20));
    });

    it("날짜 없는 시각이 감지한 시각보다 늦으면 전날 글로 본다", () => {
        expect(estimatePostedAt(["23:59:10"], kst(0, 0, 30))).toBe(kst(23, 59, 10, 24));
    });

    it("앞의 값을 읽을 수 없으면 다음 값을, 모두 없거나 하루 넘게 차이 나면 감지한 시각을 쓴다", () => {
        expect(estimatePostedAt([undefined, "10.25", "16:10:05"], kst(16, 20))).toBe(kst(16, 10, 5));
        expect(estimatePostedAt(["10.25"], kst(16, 20))).toBe(kst(16, 20));
        expect(estimatePostedAt(["2026.10.20 16:19:33"], kst(16, 20))).toBe(kst(16, 20));
        expect(estimatePostedAt(["2026.10.25 25:61"], kst(16, 20))).toBe(kst(16, 20));
    });

    it("작성 시각이 있을 수 있는 범위: 초가 있으면 한 점, 없으면 그 분 안, 모르면 감지 1분 전까지", () => {
        expect(postedAtRange(["2026.10.25 16:19:33"], kst(16, 20))).toEqual({earliest: kst(16, 19, 33), latest: kst(16, 19, 33)});
        expect(postedAtRange(["2026.10.25 16:19"], kst(16, 20))).toEqual({earliest: kst(16, 19), latest: kst(16, 19, 59)});
        expect(postedAtRange(["16:19"], kst(16, 19, 20))).toEqual({earliest: kst(16, 19), latest: kst(16, 19, 20)});
        expect(postedAtRange(["2025.04.23"], kst(16, 20))).toEqual({earliest: kst(16, 19), latest: kst(16, 20)});
    });

    it("LLM에 한국 시간으로 넘긴다", () => {
        expect(formatKst(kst(16, 19, 33))).toBe("2026-10-25 16:19:33");
        expect(buildUserMessage("버거 나눔", "30분까지 줄", kst(16, 19, 33))).toContain("<posted_at>2026-10-25 16:19:33</posted_at>");
        expect(buildBatchMessage([{title: "a", body: "", no: 1, postedAt: kst(9, 5)}, {title: "b", body: ""}]))
            .toMatch(/<post index="1" no="1">\n<posted_at>2026-10-25 09:05:00<\/posted_at>[\s\S]*<post index="2">\n<title>b/);
        expect(buildUserMessage("a", "")).not.toContain("posted_at");
    });
});
