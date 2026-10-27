import {describe, expect, it} from "vitest";
import {loadPostImages, postImageUrls} from "../src/main/dc/post-images";
import {buildUserMessage} from "../src/main/llm/decision";

const PHOTO = (n: number) => `https://dcimg7.dcinside.co.kr/viewimage.php?id=abc&no=${n}`;

describe("글 사진", () => {
    it("본문에서 디시 이미지 서버의 사진 주소만 순서대로 꺼낸다(지연 로딩 주소 우선, 디시콘·외부 주소 제외, 최대 3장)", () => {
        const memo = [
            `<img src=https://nstatic.dcinside.com/loading.gif class="lazy" data-original="${PHOTO(1).replace("&", "&amp;")}">`,
            `<img src="https://dcimg5.dcinside.com/dccon.php?no=x">`,
            `<img src='https://evil.example.com/a.png'>`,
            `<img src="${PHOTO(2)}"><img src="${PHOTO(2)}">`,
            `<img data-src="//dcimg7.dcinside.co.kr/viewimage.php?id=abc&no=3"><img src="${PHOTO(4)}">`
        ].join("");
        expect(postImageUrls(memo)).toEqual([PHOTO(1), PHOTO(2), PHOTO(3)]);
    });

    it("앱 API처럼 이스케이프된 본문에서도 꺼낸다", () => {
        expect(postImageUrls(`&lt;p&gt;&lt;img src=&quot;${PHOTO(1)}&quot;&gt;&lt;/p&gt;`)).toEqual([PHOTO(1)]);
        expect(postImageUrls("사진 없는 글")).toEqual([]);
    });

    it("받은 사진을 줄여 돌려주고, 받지 못했거나 줄이지 못한 사진은 뺀다", async () => {
        const fake = (async (url: string) => (url.endsWith("=2")
            ? new Response("<html>", {headers: {"content-type": "text/html"}})
            : new Response(new Uint8Array([1, 2, 3]), {headers: {"content-type": "image/png"}}))) as typeof fetch;
        const shrink = (bytes: Buffer, mimeType: string) => (mimeType === "image/png" && bytes.length === 3 ? {mimeType: "image/jpeg", data: "eA=="} : null);
        expect(await loadPostImages([PHOTO(1), PHOTO(2)], shrink, fake)).toEqual([{mimeType: "image/jpeg", data: "eA=="}]);
    });

    it("형식 없이(application/octet-stream) 온 사진은 파일 앞부분으로 형식을 알아내고, 이미지가 아니면 뺀다", async () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
        const fake = (async (url: string) => new Response(url.endsWith("=1") ? jpeg : new Uint8Array([1, 2, 3]), {headers: {"content-type": "application/octet-stream"}})) as typeof fetch;
        const seen: string[] = [];
        const shrink = (_bytes: Buffer, mimeType: string) => (seen.push(mimeType), {mimeType: "image/jpeg", data: "eA=="});
        expect(await loadPostImages([PHOTO(1), PHOTO(2)], shrink, fake)).toHaveLength(1);
        expect(seen).toEqual(["image/jpeg"]);
    });

    it("이미지 서버가 느리면 정해진 시간 안에 받은 사진까지만 쓴다", async () => {
        const fake = (async (url: string, init?: RequestInit) => {
            if (url.endsWith("=1")) return new Response(new Uint8Array([1]), {headers: {"content-type": "image/png"}});
            // 응답하지 않다가 시간이 다 되면 끊기는 서버입니다.
            return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
        }) as typeof fetch;
        const started = Date.now();
        const images = await loadPostImages([PHOTO(1), PHOTO(2), PHOTO(3)], () => ({mimeType: "image/jpeg", data: "eA=="}), fake, 100);
        expect(images).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it("사진을 함께 보내면 메시지에 사진 수를 적는다", () => {
        expect(buildUserMessage("23분까지", "축하합니다", undefined, 2)).toBe("<post>\n<title>23분까지</title>\n<body>축하합니다</body>\n<images>2</images>\n</post>");
        expect(buildUserMessage("23분까지", "")).not.toContain("<images>");
    });
});
