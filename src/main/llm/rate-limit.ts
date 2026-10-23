const WINDOW_MS = 60_000;

/**
 * 최근 1분 동안 보낸 LLM 요청 수를 셉니다. 한도에 닿으면 가장 오래된 요청이 1분을 넘길 때까지 기다립니다.
 * 무료 API 키(예: Gemini 무료 등급은 분당 5회)의 한도를 감시 간격과 상관없이 넘지 않게 합니다.
 */
export class RateLimiter {
    private readonly sent: number[] = [];

    constructor(
        /** 분당 요청 수입니다. 0이면 제한하지 않습니다. 설정이 바뀔 수 있어 부를 때마다 읽습니다. */
        private readonly limit: () => number,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    ) {}

    private prune(): void {
        const cutoff = this.now() - WINDOW_MS;
        while (this.sent.length > 0 && this.sent[0]! <= cutoff) this.sent.shift();
    }

    /** 지금 바로 보낼 수 있는 요청 수입니다. 제한이 없으면 Infinity입니다. */
    available(): number {
        const limit = this.limit();
        if (limit <= 0) return Infinity;
        this.prune();
        return Math.max(0, limit - this.sent.length);
    }

    /** 요청 하나를 보낼 자리가 날 때까지 기다린 뒤 자리를 차지합니다. */
    async acquire(): Promise<void> {
        while (this.available() === 0) await this.sleep(this.sent[0]! + WINDOW_MS - this.now());
        // 제한이 없으면 기록할 필요가 없습니다(기록만 쌓입니다).
        if (this.limit() > 0) this.sent.push(this.now());
    }
}

/**
 * 판단할 글들을 몇 번의 요청으로 나눌지 정합니다. 한도 이하면 글마다 따로 보내고,
 * 넘으면 한도만큼의 요청으로 고르게 묶습니다. 예: 한도 5에 글 12개면 3, 3, 2, 2, 2개씩.
 */
export function chunkForLimit<T>(items: T[], limit: number): T[][] {
    if (limit <= 0 || items.length <= limit) return items.map((item) => [item]);
    const chunks: T[][] = [];
    let start = 0;
    for (let i = 0; i < limit; i++) {
        const size = Math.ceil((items.length - start) / (limit - i));
        chunks.push(items.slice(start, start + size));
        start += size;
    }
    return chunks;
}
