import {isDiscordWebhookUrl, truncateChars} from "@shared/text";

export interface DiscordNotice {
    title: string;
    description: string;
    url?: string;
    /** 성공 알림은 초록색, 나머지는 빨간색으로 표시합니다. */
    success?: boolean;
    /** 본문 아래에 누를 수 있는 링크로 붙일 글들입니다. 주소는 앱이 만든 글 주소만 넣습니다. */
    links?: {title: string; url: string}[];
}

/**
 * 글 제목이나 LLM 판단처럼 남이 쓴 내용이 링크나 서식으로 보이지 않게 마크다운 기호를 무력화합니다.
 * 주소는 Discord가 그대로 링크로 만들어서, `://` 사이에 보이지 않는 문자를 넣어 링크가 되지 않게 합니다.
 */
export function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_~|[\]()<>#>-])/g, "\\$1").replace(/:\/\//g, ":\u200b//");
}

const WEBHOOK_TIMEOUT_MS = 10_000;
const DESCRIPTION_MAX = 4000;

/** 본문은 서식을 무력화하고, 링크로 붙일 글은 제목만 무력화해 [제목](주소)로 씁니다. */
function describe(notice: DiscordNotice): string {
    const links = (notice.links ?? []).map((link) => `[${truncateChars(escapeMarkdown(link.title), 100)}](${link.url})`).join("\n");
    if (!links) return truncateChars(escapeMarkdown(notice.description), DESCRIPTION_MAX);
    return `${truncateChars(escapeMarkdown(notice.description), Math.max(100, DESCRIPTION_MAX - links.length - 2))}\n\n${links}`.slice(0, DESCRIPTION_MAX);
}

/** Discord가 보내는 속도를 늦추라고 한 응답(429)입니다. `retryAfterMs` 뒤에 다시 보내면 됩니다. */
export class DiscordRateLimitError extends Error {
    constructor(readonly retryAfterMs: number) {
        super(`Discord 전송 한도 초과 (${Math.ceil(retryAfterMs / 1000)}초 뒤 다시 보낼 수 있음)`);
    }
}

/** 429 응답에서 다시 보내도 되는 때까지의 시간을 읽습니다. 헤더(초)나 본문의 retry_after(초)를 보고, 없으면 1초로 봅니다. */
async function retryAfterMs(response: Response): Promise<number> {
    const header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) return header * 1000;
    const body = await response.json().catch(() => null) as {retry_after?: unknown} | null;
    const seconds = typeof body?.retry_after === "number" ? body.retry_after : 1;
    return Math.max(0, seconds) * 1000;
}

/** Discord 웹훅으로 알림을 보냅니다. 실패하면 예외를 던지고, 전송 한도에 걸리면 `DiscordRateLimitError`를 던집니다. */
export async function sendDiscordNotice(webhookUrl: string, notice: DiscordNotice): Promise<void> {
    if (!isDiscordWebhookUrl(webhookUrl)) throw new Error("Discord 웹훅 주소가 올바르지 않습니다.");
    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        // 알림이 늦어져 감시가 오래 멈추지 않도록 시간 제한을 둡니다.
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        body: JSON.stringify({
            username: "Hamboogie",
            // @everyone 등 멘션은 울리지 않게 합니다.
            allowed_mentions: {parse: []},
            embeds: [{
                title: truncateChars(escapeMarkdown(notice.title), 256),
                description: describe(notice),
                url: notice.url,
                color: notice.success ? 0x3fa45b : 0xe0442e,
                timestamp: new Date().toISOString()
            }]
        })
    });
    if (response.status === 429) throw new DiscordRateLimitError(await retryAfterMs(response));
    // 연결을 바로 돌려주도록 읽지 않는 응답 본문은 버립니다.
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`Discord 응답 오류 (${response.status})`);
}
