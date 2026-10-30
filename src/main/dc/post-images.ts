import {decodeHtml} from "@green-1052/dcinside.js";
import {POST_IMAGES_MAX} from "@shared/settings";
import type {LlmImage} from "../llm/providers";
import {fetchDcImage, isDcconImageUrl} from "./dccon-images";
import {decodeMemo} from "./text";

/** 줄이기 전 원본 사진의 최대 크기입니다. 더 큰 사진은 받지 않습니다. */
const ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
/** 사진을 모두 받는 데 쓸 최대 시간입니다. 이미지 서버가 느려도 줄 서기가 오래 밀리지 않게, 넘으면 받은 사진까지만 씁니다. */
const LOAD_BUDGET_MS = 10_000;

/** 받은 사진을 LLM에 보낼 크기로 줄입니다. 줄일 수 없는 형식이면 null입니다. Electron에서는 nativeImage로 줄입니다. */
export type ShrinkImage = (bytes: Buffer, mimeType: string) => LlmImage | null;

/**
 * 본문 HTML에서 글에 올린 사진의 주소를 순서대로 꺼냅니다. 디시콘(dccon.php)은 뺍니다. 지연 로딩 속성(data-original 등)이 있으면
 * 그 주소를 씁니다. 디시 이미지 서버의 https 주소만 남깁니다.
 */
export function postImageUrls(memo: string, max = POST_IMAGES_MAX): string[] {
    const urls: string[] = [];
    for (const [tag] of decodeMemo(memo, /<img/i).matchAll(/<img\b[^>]*>/gi)) {
        // 따옴표 없이 쓴 속성(src=https://...)도 있습니다.
        const attribute = (name: string) => {
            const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
            return match ? match[1] ?? match[2] ?? match[3] : undefined;
        };
        const raw = attribute("data-original") ?? attribute("data-src") ?? attribute("src");
        if (!raw) continue;
        const url = decodeHtml(raw).trim().replace(/^\/\//, "https://").replace(/^http:\/\//, "https://");
        if (!isDcconImageUrl(url) || /dccon\.php/i.test(url) || urls.includes(url)) continue;
        urls.push(url);
        if (urls.length >= max) break;
    }
    return urls;
}

/**
 * 사진을 받아 줄입니다. 받지 못하거나 줄이지 못한 사진은 빠집니다. 디시 이미지 서버에 몰아 보내지 않도록 하나씩 받고,
 * 모두 합쳐 `budgetMs` 안에 받은 사진만 씁니다.
 */
export async function loadPostImages(urls: string[], shrink: ShrinkImage, fetchImpl: typeof fetch = fetch, budgetMs = LOAD_BUDGET_MS): Promise<LlmImage[]> {
    const images: LlmImage[] = [];
    const deadline = Date.now() + budgetMs;
    for (const url of urls.slice(0, POST_IMAGES_MAX)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const original = await fetchDcImage(url, ORIGINAL_MAX_BYTES, fetchImpl, left);
        const image = original && shrink(original.bytes, original.mimeType);
        if (image) images.push(image);
    }
    return images;
}
