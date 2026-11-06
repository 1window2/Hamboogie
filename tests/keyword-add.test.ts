import {describe, expect, it} from "vitest";
import {KEYWORD_LENGTH_MAX, KEYWORD_MAX} from "@shared/settings";
import {addKeywords, keywordAddNotices} from "../src/renderer/src/components/keyword-add";

const many = (count: number, prefix = "키워드") => Array.from({length: count}, (_, index) => `${prefix}${index}`);

describe("addKeywords", () => {
    it("넣을 수 있는 만큼만 넣고, 넘친 키워드는 버리지 않고 돌려준다", () => {
        const result = addKeywords(many(KEYWORD_MAX - 1), ["새1", "새2", "새3"]);
        expect(result.keywords).toHaveLength(KEYWORD_MAX);
        expect(result.keywords.at(-1)).toBe("새1");
        expect(result.overflow).toEqual(["새2", "새3"]);
        expect(keywordAddNotices(result)[0]).toBe(`${KEYWORD_MAX}개까지만 넣을 수 있어 2개는 넣지 못했습니다.`);
    });

    it("너무 긴 키워드는 넣지 않고 알린다", () => {
        const long = "가".repeat(KEYWORD_LENGTH_MAX + 1);
        const result = addKeywords([], [long, "가".repeat(KEYWORD_LENGTH_MAX)]);
        expect(result.keywords).toEqual(["가".repeat(KEYWORD_LENGTH_MAX)]);
        expect(result.tooLong).toEqual([long]);
        expect(keywordAddNotices(result).join(" ")).toContain(`${KEYWORD_LENGTH_MAX}자보다 긴 키워드 1개`);
    });

    it("이미 있거나 같이 넣은 것과 겹치는 키워드(대소문자·공백만 다른 것 포함)는 빼고 알린다", () => {
        const result = addKeywords(["Pizza"], ["pizza", "치 킨", "치킨"]);
        expect(result.keywords).toEqual(["Pizza", "치 킨"]);
        expect(result.duplicates).toEqual(["pizza", "치킨"]);
        expect(keywordAddNotices(result)).toEqual(["이미 있는 키워드는 뺐습니다: pizza, 치킨"]);
    });

    it("모두 넣었으면 안내가 없다", () => {
        const result = addKeywords([], ["버거", "피자"]);
        expect(result.keywords).toEqual(["버거", "피자"]);
        expect(keywordAddNotices(result)).toEqual([]);
    });
});
