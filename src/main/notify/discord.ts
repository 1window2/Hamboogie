import {isDiscordWebhookUrl} from "@shared/text";

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

/** 글자(서로게이트 쌍 포함) 단위로 자릅니다. */
function truncate(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const WEBHOOK_TIMEOUT_MS = 10_000;
const DESCRIPTION_MAX = 4000;

/** 본문은 서식을 무력화하고, 링크로 붙일 글은 제목만 무력화해 [제목](주소)로 씁니다. */
function describe(notice: DiscordNotice): string {
    const links = (notice.links ?? []).map((link) => `[${truncate(escapeMarkdown(link.title), 100)}](${link.url})`).join("\n");
    if (!links) return truncate(escapeMarkdown(notice.description), DESCRIPTION_MAX);
    return `${truncate(escapeMarkdown(notice.description), Math.max(100, DESCRIPTION_MAX - links.length - 2))}\n\n${links}`.slice(0, DESCRIPTION_MAX);
}

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
                description: describe(notice),
                url: notice.url,
                color: notice.success ? 0x3fa45b : 0xe0442e,
                timestamp: new Date().toISOString()
            }]
        })
    });
    if (!response.ok) throw new Error(`Discord 응답 오류 (${response.status})`);
}
