/**
 * 기본 디시콘을 고르는 화면에 보여줄 디시콘 이미지를 받아 옵니다.
 *
 * 앱 화면은 외부 이미지를 띄우지 않으므로(보안 설정) 여기서 받아 data: 주소로 넘깁니다. 받는 것은 계정이 실제로 가진
 * 디시콘의 이미지 주소뿐이고, 한 번 받은 이미지는 앱을 끌 때까지 다시 받지 않습니다. 디시 이미지 서버는 디시 페이지에서
 * 온 요청만 이미지를 주므로 Referer를 붙입니다.
 */
const IMAGE_HOST = /^dcimg\d*\.dcinside\.(com|co\.kr)$/i;
/** 한 번에 받을 수 있는 이미지 수와 동시에 받는 수입니다. 디시 이미지 서버에 요청을 몰아 보내지 않기 위해서입니다. */
const MAX_PER_CALL = 200;
const CONCURRENCY = 4;
const MAX_BYTES = 2 * 1024 * 1024;

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
                    result[url] = data;
                }
            }
        };
        await Promise.all(Array.from({length: Math.min(CONCURRENCY, queue.length)}, worker));
        return result;
    }

    private async fetchOne(url: string): Promise<string | null> {
        try {
            const response = await this.fetchImpl(url, {headers: {Referer: "https://gall.dcinside.com/"}, signal: AbortSignal.timeout(15000)});
            const type = response.headers.get("content-type") ?? "";
            if (!response.ok || !type.startsWith("image/")) return null;
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
            return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
        } catch {
            return null;
        }
    }
}
