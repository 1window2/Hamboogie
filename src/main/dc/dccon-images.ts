/**
 * 기본 디시콘을 고르는 화면에 보여줄 디시콘 이미지를 받아 옵니다.
 *
 * 앱 화면은 외부 이미지를 띄우지 않으므로(보안 설정) 여기서 받아 data: 주소로 넘깁니다. 받는 것은 계정이 실제로 가진
 * 디시콘의 이미지 주소뿐이고, 한 번 받은 이미지는 앱을 끌 때까지 다시 받지 않습니다(최근 것 위주로 CACHE_MAX개까지). 디시 이미지 서버는 디시 페이지에서
 * 온 요청만 이미지를 주므로 Referer를 붙입니다.
 */
const IMAGE_HOST = /^dcimg\d*\.dcinside\.(com|co\.kr)$/i;
/** 한 번에 받을 수 있는 이미지 수와 동시에 받는 수입니다. 디시 이미지 서버에 요청을 몰아 보내지 않기 위해서입니다. */
const MAX_PER_CALL = 200;
const CONCURRENCY = 4;
const MAX_BYTES = 2 * 1024 * 1024;
/** 기억해 둘 이미지 수입니다. 넘으면 가장 먼저 받은 것부터 잊습니다. */
const CACHE_MAX = 1000;

/** 디시 이미지 서버의 https 주소인지입니다. 디시콘과 글에 올린 사진이 모두 여기 있습니다. */
export function isDcconImageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && IMAGE_HOST.test(parsed.hostname);
    } catch {
        return false;
    }
}

export class DcconImages {
    private readonly cache = new Map<string, string>();

    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    /** 주소마다 data: 주소를 돌려줍니다. 받지 못한 이미지는 빠집니다. */
    async load(urls: string[]): Promise<Record<string, string>> {
        const wanted = [...new Set(urls)].filter(isDcconImageUrl).slice(0, MAX_PER_CALL);
        const result: Record<string, string> = {};
        const queue = wanted.filter((url) => {
            const cached = this.cache.get(url);
            if (cached) result[url] = cached;
            return !cached;
        });
        const worker = async () => {
            for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
                const data = await this.fetchOne(url);
                if (data) {
                    this.cache.set(url, data);
                    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
                    result[url] = data;
                }
            }
        };
        await Promise.all(Array.from({length: Math.min(CONCURRENCY, queue.length)}, worker));
        return result;
    }

    private async fetchOne(url: string): Promise<string | null> {
        const image = await fetchDcImage(url, MAX_BYTES, this.fetchImpl);
        return image && `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;
    }
}

/**
 * 디시 이미지 서버에서 이미지 하나를 받습니다. 디시 이미지 서버는 디시 페이지에서 온 요청만 이미지를 주므로 Referer를 붙입니다.
 * 이미지가 아니거나, 비었거나, `maxBytes`보다 크거나, 받지 못하면 null입니다.
 */
export async function fetchDcImage(url: string, maxBytes: number, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<{mimeType: string; bytes: Buffer} | null> {
    try {
        const response = await fetchImpl(url, {headers: {Referer: "https://gall.dcinside.com/"}, signal: AbortSignal.timeout(timeoutMs)});
        const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
        // 글 사진은 형식 없이(application/octet-stream) 오기도 해서, 그때는 파일 앞부분으로 형식을 알아냅니다.
        if (!response.ok || !(type.startsWith("image/") || type === "application/octet-stream")) return null;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > maxBytes) return null;
        const mimeType = type.startsWith("image/") ? type : sniffImageType(bytes);
        return mimeType ? {mimeType, bytes} : null;
    } catch {
        return null;
    }
}

/** 파일 앞부분으로 이미지 형식을 알아냅니다. 이미지가 아니면 null입니다. */
function sniffImageType(bytes: Buffer): string | null {
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return null;
}
