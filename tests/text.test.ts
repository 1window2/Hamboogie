import {describe, expect, it} from "vitest";
import {normalizeKeywords} from "@shared/settings";
import {galleryIdFromInput, hasHiddenCharacter, isDiscordWebhookUrl, keywordKey, normalizeForMatch, splitKeywords} from "@shared/text";
import {findKeyword} from "../src/main/pipeline/keyword-filter";
import {errorMessage} from "@shared/errors";

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
        expect(isDiscordWebhookUrl("https://evil.example/api/webhooks/1/abc")).toBe(false);
        expect(isDiscordWebhookUrl("abc")).toBe(false);
    });
});

describe("보이지 않는 글자", () => {
    const HIDDEN = ["\u3164", "\u115F", "\u1160", "\uFFA0", "\u200B", "\u200D", "\u2060", "\u00AD"];

    it("한글 채움 문자와 제로폭·서식 문자를 지우고 비교한다", () => {
        for (const hidden of HIDDEN) {
            const code = hidden.codePointAt(0)!.toString(16);
            expect(normalizeForMatch(`인${hidden}증`), code).toBe("인증");
            expect(hasHiddenCharacter(`인${hidden}증`), code).toBe(true);
        }
        expect(hasHiddenCharacter("인 증")).toBe(false);
        expect(hasHiddenCharacter("인증")).toBe(false);
    });

    it("자모 사이에 끼운 글자나 결합 부호를 지운 뒤 자모를 다시 한 글자로 합친다", () => {
        expect(normalizeForMatch("\u1106\u200B\u1162크로")).toBe("매크로");
        expect(normalizeForMatch("\u1106\u302E\u1162크로")).toBe("매크로");
        expect(normalizeForMatch("매\u0301크로")).toBe("매크로");
    });

    it("채움 문자를 끼워 넣은 키워드도 같은 키워드로 본다", () => {
        expect(keywordKey("인ㅤ증")).toBe(keywordKey("인증"));
        expect(keywordKey("인\u200B증")).toBe(keywordKey("인증"));
    });

    it("제로폭 문자를 끼워 넣은 글도 키워드에 걸린다", () => {
        expect(findKeyword("인\u200B증 이벤트", ["인증"])).toBe("인증");
        expect(findKeyword("인\u3164증 이벤트", ["인증"])).toBe("인증");
        expect(findKeyword("치\u00AD킨 나눔", ["치킨"])).toBe("치킨");
    });
});

describe("오류 문구", () => {
    it("화면에서 받은 IPC 오류의 앞부분을 떼고 보여준다", () => {
        expect(errorMessage(new Error("Error invoking remote method 'checkGallery': Error: 없는 갤러리입니다."))).toBe("없는 갤러리입니다.");
        expect(errorMessage(new Error("Error invoking remote method 'save': TypeError: 잘못된 값"))).toBe("잘못된 값");
        expect(errorMessage("그냥 문자열")).toBe("그냥 문자열");
    });
});
