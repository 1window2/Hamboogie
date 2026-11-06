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

    it("같은 이미지를 동시에 받아도 캐시 크기를 두 번 세지 않는다", async () => {
        const fake = (async () => new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "image/gif"}})) as typeof fetch;
        const images = new DcconImages(fake);
        await Promise.all([images.load([IMG]), images.load([IMG])]);
        expect((images as unknown as {cacheChars: number}).cacheChars).toBe("data:image/gif;base64,AQID".length);
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

describe("디시 이미지 크기 제한과 주소", () => {
    /** 크기를 알려 주지 않고 조각으로 흘려보내는 응답입니다. */
    const streamed = (chunks: number, size: number, pulled: {count: number}) => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulled.count >= chunks) return controller.close();
            pulled.count++;
            controller.enqueue(new Uint8Array(size).fill(1));
        }
    }), {headers: {"content-type": "image/png"}});

    it("크기를 알려 주지 않은 응답도 받는 동안 세다가 한도를 넘으면 끊고 받지 않는다", async () => {
        const pulled = {count: 0};
        const fake = (async () => streamed(100, 40, pulled)) as unknown as typeof fetch;
        expect(await fetchDcImage(IMG, 100, fake)).toBeNull();
        expect(pulled.count).toBeLessThan(10);

        const small = {count: 0};
        const ok = (async () => streamed(2, 40, small)) as unknown as typeof fetch;
        expect((await fetchDcImage(IMG, 100, ok))?.bytes.length).toBe(80);
    });

    it("포트를 적은 주소는 디시 이미지 서버여도 받지 않고, 그런 주소로 넘겨줘도 따라가지 않는다", async () => {
        const requests: string[] = [];
        const fake = (async (url: string) => {
            requests.push(url);
            return new Response(null, {status: 302, headers: {location: "https://dcimg6.dcinside.co.kr:8443/dccon.php?no=abc"}});
        }) as typeof fetch;
        expect(isDcconImageUrl("https://dcimg1.dcinside.com:8443/x")).toBe(false);
        expect(await fetchDcImage("https://dcimg1.dcinside.com:8443/x", 100, fake)).toBeNull();
        expect(requests).toEqual([]);
        expect(await fetchDcImage(IMG, 100, fake)).toBeNull();
        expect(requests).toEqual([IMG]);
    });

    it("압축하지 않은 그대로 달라고 요청한다", async () => {
        const encodings: (string | null)[] = [];
        const fake = (async (_url: string, init?: RequestInit) => {
            encodings.push(new Headers(init?.headers).get("accept-encoding"));
            return new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "image/gif"}});
        }) as typeof fetch;
        await fetchDcImage(IMG, 100, fake);
        expect(encodings).toEqual(["identity"]);
    });
});
