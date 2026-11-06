import {describe, expect, it, vi} from "vitest";
import {DiscordRateLimitError, escapeMarkdown, sendDiscordNotice} from "../src/main/notify/discord";

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

describe("Discord 전송 한도", () => {
    const WEBHOOK = "https://discord.com/api/webhooks/1/abc";
    const send = async (response: Response) => {
        vi.stubGlobal("fetch", vi.fn(async () => response));
        try {
            return await sendDiscordNotice(WEBHOOK, {title: "알림", description: ""}).then(() => null, (error: unknown) => error);
        } finally {
            vi.unstubAllGlobals();
        }
    };

    it("429를 받으면 헤더의 대기 시간을 담은 오류를 던진다", async () => {
        const error = await send(new Response(null, {status: 429, headers: {"retry-after": "2"}}));
        expect(error).toBeInstanceOf(DiscordRateLimitError);
        expect((error as DiscordRateLimitError).retryAfterMs).toBe(2000);
    });

    it("헤더가 없으면 본문의 retry_after(초)를 쓴다", async () => {
        const error = await send(new Response(JSON.stringify({retry_after: 0.5}), {status: 429, headers: {"content-type": "application/json"}}));
        expect(error).toBeInstanceOf(DiscordRateLimitError);
        expect((error as DiscordRateLimitError).retryAfterMs).toBe(500);
    });
});
