import {describe, expect, it} from "vitest";
import {KEYWORD_MAX, newGallery, normalizeGallery, normalizeKeywords} from "@shared/settings";
import {matchesKeywords} from "../src/main/pipeline/keyword-filter";
import {htmlToText} from "../src/main/dc/text";

describe("matchesKeywords", () => {
    it("공백과 대소문자를 무시하고 제목에 키워드가 있으면 통과한다", () => {
        expect(matchesKeywords("햄버거 나 눔 합니다", ["나눔"])).toBe(true);
        expect(matchesKeywords("오늘 날씨", ["나눔", "뿌림"])).toBe(false);
        expect(matchesKeywords("아무 제목", [])).toBe(true);
    });
});

describe("settings normalize", () => {
    it("키워드는 다듬고 중복을 없애며 최대 30개까지만 남긴다", () => {
        const many = Array.from({length: 40}, (_, index) => `k${index}`);
        expect(normalizeKeywords([" 나눔 ", "나눔", "", ...many])).toHaveLength(KEYWORD_MAX);
        expect(normalizeKeywords([" 나눔 ", "나눔"])).toEqual(["나눔"]);
    });

    it("감시 간격은 10초~1시간으로 맞추고, 없는 계정은 대기 목록에서 뺀다", () => {
        const gallery = {...newGallery("g"), intervalSec: 3, accountIds: ["a", "ghost"]};
        const result = normalizeGallery(gallery, [{id: "a", loginId: "x", memberTypeOverride: "auto"}]);
        expect(result.intervalSec).toBe(10);
        expect(result.accountIds).toEqual(["a"]);
        expect(normalizeGallery({...gallery, intervalSec: 99999}, []).intervalSec).toBe(3600);
    });
});

describe("htmlToText", () => {
    it("이스케이프된 본문 HTML에서 이미지를 버리고 텍스트만 남긴다", () => {
        const memo = "&lt;p&gt;햄버거 5개 뿌림&lt;br /&gt;3시까지 &amp;quot;줄&amp;quot; 댓글&lt;/p&gt;&lt;div&gt;&lt;img src=&quot;https://dcimg5.dcinside.com/a.jpg&quot;&gt;&lt;/div&gt;";
        expect(htmlToText(memo)).toBe("햄버거 5개 뿌림\n3시까지 \"줄\" 댓글");
    });
});
