/**
 * 입력 글자를 한 가지 형태로 맞춥니다(NFKC). macOS에서 복사한 한글은 자모가 분리된 형태(NFD)일 수 있고, 전각 문자(ＰＩＺＺＡ, １０)도
 * 섞여 들어옵니다. 화면에는 같아 보여도 다른 글자로 취급되어 키워드가 글과 맞지 않게 되므로, 저장하거나 비교하기 전에 맞춥니다.
 */
export function normalizeText(text: string): string {
    return text.normalize("NFKC");
}

/** 키워드가 같은지 볼 때 쓰는 값입니다. 글과 맞춰 볼 때처럼 공백과 대소문자를 무시합니다. */
export function keywordKey(keyword: string): string {
    return normalizeText(keyword).replace(/\s+/g, "").toLowerCase();
}

/** 쉼표나 줄바꿈으로 나눈 키워드입니다. 앞뒤 공백을 지우고 빈 것은 뺍니다. */
export function splitKeywords(text: string): string[] {
    return text.split(/[,\n]/).map((keyword) => normalizeText(keyword).trim()).filter(Boolean);
}

/**
 * 갤러리 ID 입력칸에 넣은 글자에서 갤러리 ID를 꺼냅니다. 갤러리 주소를 통째로 붙여넣으면
 * (`...lists/?id=gf2`, `m.dcinside.com/board/gf2/123`, `m.dcinside.com/mini/...`) ID만 남기고, 공백은 지웁니다.
 */
export function galleryIdFromInput(text: string): string {
    const value = normalizeText(text).trim();
    const query = /[?&]id=([A-Za-z0-9_$]+)/.exec(value);
    if (query) return query[1]!;
    const mobile = /m\.dcinside\.com\/(?:board|mini)\/([A-Za-z0-9_$]+)/.exec(value);
    if (mobile) return mobile[1]!;
    return value.replace(/\s+/g, "");
}

const WEBHOOK_PATTERN = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\//;

/** Discord 웹훅 주소인지입니다. 다른 주소로 알림 내용이 가지 않게 합니다. */
export function isDiscordWebhookUrl(url: string): boolean {
    return WEBHOOK_PATTERN.test(url);
}
