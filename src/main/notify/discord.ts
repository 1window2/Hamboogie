export interface DiscordNotice {
    title: string;
    description: string;
    url?: string;
    /** 성공 알림은 초록색, 나머지는 빨간색으로 표시합니다. */
    success?: boolean;
}

const WEBHOOK_PATTERN = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\//;

export function isDiscordWebhookUrl(url: string): boolean {
    return WEBHOOK_PATTERN.test(url);
}

/**
 * 글 제목이나 LLM 판단처럼 남이 쓴 내용이 링크나 서식으로 보이지 않게 마크다운 기호를 무력화합니다.
 * 주소는 Discord가 그대로 링크로 만들어서, `://` 사이에 보이지 않는 문자를 넣어 링크가 되지 않게 합니다.
 */
export function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_~|[\]()<>#>-])/g, "\\$1").replace(/:\/\//g, ":\u200b//");
}

/** 글자(서로게이트 쌍 포함) 단위로 자릅니다. */
function truncate(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/** Discord 웹훅으로 알림을 보냅니다. 실패하면 예외를 던집니다. */
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
                title: truncate(escapeMarkdown(notice.title), 256),
                description: truncate(escapeMarkdown(notice.description), 4000),
                url: notice.url,
                color: notice.success ? 0x3fa45b : 0xe0442e,
                timestamp: new Date().toISOString()
            }]
        })
    });
    if (!response.ok) throw new Error(`Discord 응답 오류 (${response.status})`);
}
