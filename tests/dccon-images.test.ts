import {describe, expect, it} from "vitest";
import {DcconImages, isDcconImageUrl} from "../src/main/dc/dccon-images";

const IMG = "https://dcimg5.dcinside.com/dccon.php?no=abc";

describe("디시콘 이미지 받기", () => {
    it("디시 이미지 서버의 https 주소만 받는다", () => {
        expect(isDcconImageUrl(IMG)).toBe(true);
        expect(isDcconImageUrl("http://dcimg5.dcinside.com/dccon.php?no=abc")).toBe(false);
        expect(isDcconImageUrl("https://evil.example.com/dccon.php")).toBe(false);
        expect(isDcconImageUrl("https://dcimg5.dcinside.com.evil.com/a")).toBe(false);
    });

    it("Referer를 붙여 받고, 한 번 받은 이미지는 다시 받지 않는다", async () => {
        const requests: {url: string; referer: string | null}[] = [];
        const fake = (async (url: string, init?: RequestInit) => {
            requests.push({url, referer: new Headers(init?.headers).get("referer")});
            return new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "image/gif"}});
        }) as typeof fetch;
        const images = new DcconImages(fake);
        expect(await images.load([IMG, IMG])).toEqual({[IMG]: "data:image/gif;base64,AQID"});
        await images.load([IMG]);
        expect(requests).toEqual([{url: IMG, referer: "https://gall.dcinside.com/"}]);
    });

    it("이미지가 아닌 응답이나 실패한 요청은 빼고 돌려준다", async () => {
        const fake = (async (url: string) => (url.endsWith("html")
            ? new Response("<html>", {headers: {"content-type": "text/html"}})
            : Promise.reject(new Error("timeout")))) as typeof fetch;
        expect(await new DcconImages(fake).load([`${IMG}html`, `${IMG}x`])).toEqual({});
    });
});
