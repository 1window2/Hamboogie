const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 디시가 준 작성 시각 문자열(한국 시간)을 읽습니다. "2026.10.25 16:19:33", "2026-10-25 16:19", "16:19"처럼
 * 날짜나 초가 빠진 형식도 읽고, 초가 없으면 그 분의 마지막 초(59초)로 봅니다. 날짜가 없으면 `detectedAt`과 같은 날(그보다
 * 늦으면 전날)로 봅니다. 읽을 수 없으면 null입니다.
 */
function latestPossible(raw: string, detectedAt: number): number | null {
    const full = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    const timeOnly = full ? null : /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(raw);
    if (!full && !timeOnly) return null;
    const [hours, minutes, seconds] = (full ? [full[4], full[5], full[6]] : [timeOnly![1], timeOnly![2], timeOnly![3]]);
    const h = Number(hours);
    const m = Number(minutes);
    const s = seconds === undefined ? 59 : Number(seconds);
    if (h > 23 || m > 59 || s > 59) return null;
    let dayStart: number;
    if (full) {
        dayStart = Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3]));
    } else {
        const kst = new Date(detectedAt + KST_OFFSET_MS);
        dayStart = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
    }
    let at = dayStart + ((h * 60 + m) * 60 + s) * 1000 - KST_OFFSET_MS;
    // 날짜 없이 시각만 있는데 감지한 시각보다 1분 넘게 늦으면 어제 글입니다.
    if (!full && at > detectedAt + 60 * 1000) at -= DAY_MS;
    return at;
}

/**
 * 글을 올린 시각을 추정합니다. LLM이 "30분까지", "10분 뒤부터" 같은 상대 시각을 실제 시각으로 바꾸는 기준입니다.
 * 확실하지 않을 때는 늦은 쪽으로 잡습니다. 그래야 "N분 뒤부터" 줄에 시작 전에 서는 일이 없습니다. 그래서 디시가 준 시각을
 * 읽을 수 있어도 글을 감지한 시각보다 늦게 잡지 않고, 읽을 수 없거나 하루 넘게 차이 나면 감지한 시각을 씁니다.
 */
export function estimatePostedAt(raw: (string | undefined)[], detectedAt: number): number {
    for (const text of raw) {
        if (!text) continue;
        const at = latestPossible(text, detectedAt);
        if (at !== null && at >= detectedAt - DAY_MS) return Math.min(at, detectedAt);
    }
    return detectedAt;
}

/** LLM에 넘길 한국 시간 "YYYY-MM-DD HH:MM:SS"입니다. */
export function formatKst(time: number): string {
    return new Date(time + KST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}
