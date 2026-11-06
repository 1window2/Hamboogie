import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {defaultSettings} from "@shared/settings";
import type {Settings} from "@shared/types";
import {Logger} from "../src/main/logger";
import {Notifier} from "../src/main/pipeline/notifier";

const WEBHOOK = "https://discord.com/api/webhooks/1/abc";

/** 가짜 웹훅입니다. `respond`가 돌려준 응답을 쓰고, 보낸 알림의 제목과 본문을 남깁니다. */
function setup(respond: (index: number) => Response = () => new Response(null, {status: 204}), webhook = WEBHOOK) {
    const sent: {title: string; description: string}[] = [];
    const fetch = vi.fn(async (_url: string, init: {body: string}) => {
        const {embeds} = JSON.parse(init.body) as {embeds: {title: string; description: string}[]};
        sent.push({title: embeds[0]!.title, description: embeds[0]!.description});
        return respond(sent.length - 1);
    });
    vi.stubGlobal("fetch", fetch);
    const waits: number[] = [];
    const desktop: string[] = [];
    const settings: Settings = {...defaultSettings(), discordWebhookUrl: webhook};
    const logger = new Logger(join(mkdtempSync(join(tmpdir(), "hamboogie-notifier-")), "test.log"));
    const notifier = new Notifier({
        settings: () => settings,
        logger,
        desktopNotice: (title) => desktop.push(title),
        sleep: async (ms) => void waits.push(ms)
    });
    return {notifier, sent, waits, desktop, logger, fetch};
}

afterEach(() => vi.unstubAllGlobals());

describe("Notifier 전송 한도", () => {
    it("429를 받으면 알려준 시간만큼 기다렸다가 다시 보낸다", async () => {
        const {notifier, sent, waits} = setup((index) => (index === 0 ? new Response(null, {status: 429, headers: {"retry-after": "1"}}) : new Response(null, {status: 204})));
        expect(await notifier.send({title: "알림", description: "내용"})).toBe("sent");
        expect(sent).toHaveLength(2);
        expect(waits[0]).toBe(1000);
    });

    it("중요한 알림은 이미 밀려 있는 일반 알림보다 먼저 보낸다", async () => {
        const {notifier, sent} = setup();
        const results = [
            notifier.send({title: "일반1", description: ""}),
            notifier.send({title: "일반2", description: ""}),
            notifier.send({title: "일반3", description: ""}),
            notifier.send({title: "중요", description: "", critical: true})
        ];
        expect(await Promise.all(results)).toEqual(["sent", "sent", "sent", "sent"]);
        // 첫 알림은 이미 보내는 중이었습니다.
        expect(sent.map((notice) => notice.title)).toEqual(["일반1", "중요", "일반2", "일반3"]);
    });

    it("밀린 일반 알림이 20개를 넘으면 넘친 것은 글 링크를 붙인 알림 하나로 묶는다", async () => {
        const {notifier, sent} = setup();
        const results = Array.from({length: 24}, (_, index) => notifier.send({title: `글${index + 1}`, description: "", post: {galleryId: "gf2", postNo: index + 1}}));
        expect(new Set(await Promise.all(results))).toEqual(new Set(["sent"]));
        expect(sent).toHaveLength(22);
        const summary = sent[21]!;
        expect(summary.title).toBe("알림 3개를 묶어 보냅니다");
        for (const no of [22, 23, 24]) expect(summary.description).toContain(`(https://m.dcinside.com/board/gf2/${no})`);
        expect(summary.description).not.toContain("board/gf2/21)");
    });
});

describe("Notifier 실패", () => {
    it("중요한 알림을 끝내 보내지 못하면 컴퓨터 알림으로 띄우고, 일반 알림은 띄우지 않는다", async () => {
        const {notifier, desktop} = setup(() => new Response(null, {status: 500}));
        expect(await notifier.send({title: "로그인 풀림", description: "다시 로그인하세요", critical: true})).toBe("failed");
        expect(await notifier.send({title: "판단이 필요한 글", description: ""})).toBe("failed");
        expect(desktop).toEqual(["Hamboogie: 로그인 풀림"]);
    });

    it("웹훅이 없으면 보내지 않고 로그만 남긴다", async () => {
        const {notifier, logger, fetch} = setup(undefined, "");
        expect(await notifier.send({title: "알림", description: "", critical: true})).toBe("no_webhook");
        expect(fetch).not.toHaveBeenCalled();
        expect(logger.recent().some((entry) => entry.message.includes("Discord 웹훅이 설정되지 않아"))).toBe(true);
    });
});
