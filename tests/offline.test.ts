import {afterEach, describe, expect, it} from "vitest";
import {blockDcinsideRequests, createFakeClientFactory} from "../src/main/dev/offline";

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("오프라인 모드", () => {
    it("디시 주소로 가는 요청은 막고, 다른 주소는 그대로 보낸다", async () => {
        const sent: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            sent.push(String(input));
            return new Response("ok");
        }) as typeof fetch;
        const blocked: string[] = [];
        blockDcinsideRequests((host) => blocked.push(host));

        for (const url of ["https://app.dcinside.com/api/x", "https://msign.dcinside.com/api/login", "https://dcimg5.dcinside.co.kr/a.jpg"]) {
            await expect(fetch(url)).rejects.toThrow("오프라인 모드");
        }
        await fetch("https://generativelanguage.googleapis.com/v1beta/models");
        expect(blocked).toEqual(["app.dcinside.com", "msign.dcinside.com", "dcimg5.dcinside.co.kr"]);
        expect(sent).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
    });

    it("가짜 클라이언트는 목록을 볼 때마다 새 글이 하나씩 생기고, 그 글을 읽을 수 있다", async () => {
        const client = createFakeClientFactory(() => {})();
        const first = await client.articles.list({gallery: "asgeir"});
        const second = await client.articles.list({gallery: "asgeir"});
        const newest = second.gall_list![0]!;
        expect(newest.no).toBe(first.gall_list![0]!.no! + 1);
        const article = await client.articles.read("asgeir", newest.no!);
        expect(article.view_info?.subject).toBe(newest.subject);
        await expect(client.articles.read("asgeir", 99999)).rejects.toThrow("삭제했거나");
    });
});
