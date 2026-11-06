/**
 * 입력 글자를 한 가지 형태로 맞춥니다(NFKC). macOS에서 복사한 한글은 자모가 분리된 형태(NFD)일 수 있고, 전각 문자(ＰＩＺＺＡ, １０)도
 * 섞여 들어옵니다. 화면에는 같아 보여도 다른 글자로 취급되어 키워드가 글과 맞지 않게 되므로, 저장하거나 비교하기 전에 맞춥니다.
 */
export function normalizeText(text: string): string {
    return text.normalize("NFKC");
}

/**
 * 화면에 보이지 않거나 공백처럼 보이는 글자입니다: 공백, 서식 문자(제로폭 문자, 방향 전환 문자 등), 그리고 한글 채움 문자(ㅤ, U+3164)처럼
 * 글자로 분류되지만 아무것도 그리지 않는 기본 무시 문자. 낱말 사이에 끼워 넣어 키워드나 금지어 검사를 피하는 데 쓰입니다.
 */
const HIDDEN_OR_SPACE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\s]/gu;

/** 보이지 않는 글자(위의 `HIDDEN_OR_SPACE`에서 공백을 뺀 것)가 들어 있는지입니다. */
export function hasHiddenCharacter(text: string): boolean {
    return /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(text.normalize("NFKC"));
}

/** 글자 위·아래에 붙는 결합 부호입니다(한글 방점 〮, 악센트 등). 거의 보이지 않아 "매〮크로"처럼 낱말 검사를 피하는 데 쓰입니다. */
const COMBINING_MARK = /\p{M}/gu;

/**
 * 글과 낱말을 맞춰 볼 때 쓰는 값입니다: 글자 형태 통일(NFKC), 보이지 않는 글자·결합 부호·공백 제거, 소문자.
 * NFKC가 완성형 글자(가, é)로 합친 뒤에 지우므로 보통 글자는 그대로 남습니다.
 * 키워드, 제외 키워드, 봇 색출·인젝션·개인정보 낱말 검사가 모두 이 값으로 비교해, 한쪽만 피해 가는 글자가 없게 합니다.
 */
export function normalizeForMatch(text: string): string {
    // 지운 글자 사이에 끼어 있던 자모("ᄆ​ᅢ")가 다시 한 글자로 합쳐지도록 지운 뒤에 한 번 더 합칩니다.
    return normalizeText(text).replace(HIDDEN_OR_SPACE, "").replace(COMBINING_MARK, "").normalize("NFC").toLowerCase();
}

/** 글자(서로게이트 쌍 포함) 단위로 `max`자까지 자르고, 잘랐으면 끝에 …을 붙입니다. */
export function truncateChars(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** 키워드가 같은지 볼 때 쓰는 값입니다. 글과 맞춰 볼 때처럼 보이지 않는 글자, 공백, 대소문자를 무시합니다. */
export function keywordKey(keyword: string): string {
    return normalizeForMatch(keyword);
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
    const query = /[?&]id=([A-Za-z0-9_]+)/.exec(value);
    if (query) return query[1]!;
    const mobile = /m\.dcinside\.com\/(?:board|mini)\/([A-Za-z0-9_]+)/.exec(value);
    if (mobile) return mobile[1]!;
    return value.replace(/\s+/g, "");
}

const WEBHOOK_PATTERN = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\//;

/** Discord 웹훅 주소인지입니다. 다른 주소로 알림 내용이 가지 않게 합니다. */
export function isDiscordWebhookUrl(url: string): boolean {
    return WEBHOOK_PATTERN.test(url);
}
