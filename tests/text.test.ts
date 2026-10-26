import {describe, expect, it} from "vitest";
import {normalizeKeywords} from "@shared/settings";
import {galleryIdFromInput, isDiscordWebhookUrl, keywordKey, splitKeywords} from "@shared/text";
import {findKeyword} from "../src/main/pipeline/keyword-filter";

describe("입력 글자 정리", () => {
    it("자모가 분리된 한글(macOS에서 복사)과 전각 문자도 같은 키워드로 본다", () => {
        expect(keywordKey("피자".normalize("NFD"))).toBe(keywordKey("피자"));
        expect(keywordKey("ＰＩＺＺＡ")).toBe(keywordKey("pizza"));
        expect(keywordKey("피 자")).toBe(keywordKey("피자"));
    });

    it("자모가 분리된 형태로 넣은 키워드도 글과 맞는다", () => {
        expect(findKeyword("오늘 피자 나눔", ["피자".normalize("NFD")])).not.toBeNull();
        expect(findKeyword("ＰＩＺＺＡ 쏜다", ["pizza"])).not.toBeNull();
    });

    it("대소문자·공백·글자 형태만 다른 키워드는 처음 것만 남긴다", () => {
        expect(normalizeKeywords(["Pizza", "pizza", " PIZZA ", "피자", "피 자", "피자".normalize("NFD"), "ＰＩＺＺＡ", "버거"])).toEqual(["Pizza", "피자", "버거"]);
    });

    it("쉼표·줄바꿈으로 나누고 빈 것은 뺀다", () => {
        expect(splitKeywords("  ,  ,")).toEqual([]);
        expect(splitKeywords("피자, 버거\n치킨 ,")).toEqual(["피자", "버거", "치킨"]);
    });

    it("갤러리 주소를 붙여넣으면 ID만 꺼낸다", () => {
        expect(galleryIdFromInput("https://gall.dcinside.com/mgallery/board/lists/?id=gf2")).toBe("gf2");
        expect(galleryIdFromInput("https://gall.dcinside.com/board/view/?id=programming&no=1")).toBe("programming");
        expect(galleryIdFromInput("https://m.dcinside.com/board/gf2/1263905")).toBe("gf2");
        expect(galleryIdFromInput(" gf 2 ")).toBe("gf2");
        expect(galleryIdFromInput("갤러리")).toBe("갤러리");
    });

    it("Discord 웹훅 주소만 받는다", () => {
        expect(isDiscordWebhookUrl("https://discord.com/api/webhooks/1/abc")).toBe(true);
        expect(isDiscordWebhookUrl("http://discord.com/api/webhooks/1/abc")).toBe(false);
        expect(isDiscordWebhookUrl("abc")).toBe(false);
    });
});
