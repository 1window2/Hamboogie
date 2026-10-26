import {describe, expect, it, vi} from "vitest";
import {escapeMarkdown, sendDiscordNotice} from "../src/main/notify/discord";

describe("Discord 알림", () => {
    it("글 내용의 마스킹 링크와 서식이 동작하지 않게 한다", () => {
        expect(escapeMarkdown("[원문 보기](https://evil.example)")).toBe("\\[원문 보기\\]\\(https:\u200b//evil.example\\)");
        expect(escapeMarkdown("**굵게** `코드`")).toBe("\\*\\*굵게\\*\\* \\`코드\\`");
        expect(escapeMarkdown("평범한 글")).toBe("평범한 글");
    });

    it("묶음 알림의 글은 제목만 무력화하고 누를 수 있는 링크로 붙인다", async () => {
        const fetch = vi.fn(async () => new Response(null, {status: 204}));
        vi.stubGlobal("fetch", fetch);
        try {
            await sendDiscordNotice("https://discord.com/api/webhooks/1/abc", {
                title: "판단이 필요한 글 2개",
                description: "글 분석 실패: 응답 시간 초과",
                links: [{title: "[가짜](https://evil.example)", url: "https://m.dcinside.com/board/gf2/2"}]
            });
        } finally {
            vi.unstubAllGlobals();
        }
        const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, {body: string}])[1].body) as {embeds: {description: string}[]};
        expect(body.embeds[0]!.description).toBe("글 분석 실패: 응답 시간 초과\n\n[\\[가짜\\]\\(https:\u200b//evil.example\\)](https://m.dcinside.com/board/gf2/2)");
    });
});
