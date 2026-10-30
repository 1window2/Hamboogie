import {describe, expect, it} from "vitest";
import {DcconImages, fetchDcImage, isDcconImageUrl} from "../src/main/dc/dccon-images";

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

    it("다른 주소로 넘겨주면 디시 주소일 때만 따라가고, 디시 이미지 서버 주소가 아니거나 너무 크면 받지 않는다", async () => {
        const requests: string[] = [];
        const redirect = (location: string) => new Response(null, {status: 302, headers: {location}});
        const fake = (async (url: string) => {
            requests.push(url);
            if (url === IMG) return redirect("https://dcimg6.dcinside.co.kr/dccon.php?no=abc");
            if (url.endsWith("evil")) return redirect("http://127.0.0.1:8080/secret");
            if (url.endsWith("big")) return new Response(new Uint8Array([1]), {headers: {"content-type": "image/png", "content-length": "999"}});
            return new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "image/gif"}});
        }) as typeof fetch;
        expect(await fetchDcImage(IMG, 100, fake)).toEqual({mimeType: "image/gif", bytes: Buffer.from([1, 2, 3])});
        expect(await fetchDcImage(`${IMG}evil`, 100, fake)).toBeNull();
        expect(await fetchDcImage(`${IMG}big`, 100, fake)).toBeNull();
        expect(await fetchDcImage("https://evil.example.com/a.png", 100, fake)).toBeNull();
        expect(requests).toEqual([IMG, "https://dcimg6.dcinside.co.kr/dccon.php?no=abc", `${IMG}evil`, `${IMG}big`]);
    });
});
