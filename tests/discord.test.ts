import {describe, expect, it} from "vitest";
import {escapeMarkdown, isDiscordWebhookUrl} from "../src/main/notify/discord";

describe("Discord 알림", () => {
    it("글 내용의 마스킹 링크와 서식이 동작하지 않게 한다", () => {
        expect(escapeMarkdown("[원문 보기](https://evil.example)")).toBe("\\[원문 보기\\]\\(https:\u200b//evil.example\\)");
        expect(escapeMarkdown("**굵게** `코드`")).toBe("\\*\\*굵게\\*\\* \\`코드\\`");
        expect(escapeMarkdown("평범한 글")).toBe("평범한 글");
    });

    it("디스코드 웹훅 주소만 받는다", () => {
        expect(isDiscordWebhookUrl("https://discord.com/api/webhooks/1/abc")).toBe(true);
        expect(isDiscordWebhookUrl("https://evil.example/api/webhooks/1/abc")).toBe(false);
    });
});
