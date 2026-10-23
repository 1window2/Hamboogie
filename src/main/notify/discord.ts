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

/** Discord 웹훅으로 알림을 보냅니다. 실패하면 예외를 던집니다. */
export async function sendDiscordNotice(webhookUrl: string, notice: DiscordNotice): Promise<void> {
    if (!isDiscordWebhookUrl(webhookUrl)) throw new Error("Discord 웹훅 주소가 올바르지 않습니다.");
    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            username: "Hamboogie",
            embeds: [{
                title: notice.title.slice(0, 256),
                description: notice.description.slice(0, 4000),
                url: notice.url,
                color: notice.success ? 0x3fa45b : 0xe0442e,
                timestamp: new Date().toISOString()
            }]
        })
    });
    if (!response.ok) throw new Error(`Discord 응답 오류 (${response.status})`);
}
