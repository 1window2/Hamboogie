import {decodeHtml} from "@green-1052/dcinside.js";

/**
 * 앱 API는 본문 HTML을 이스케이프해서 줍니다. 찾는 태그(`until`, 기본은 아무 태그)가 보일 때까지 최대 두 번 풀어 HTML로 돌려놓습니다.
 */
export function decodeMemo(memo: string, until: RegExp = /<[a-z/][^>]*>/i): string {
    let html = memo;
    for (let i = 0; i < 2 && !until.test(html) && /&lt;/.test(html); i++) html = decodeHtml(html);
    return html;
}

/** 앱 API 본문(HTML이 한 번 더 이스케이프된 상태)을 LLM에 보낼 텍스트로 바꿉니다. 이미지는 버립니다. */
export function htmlToText(memo: string): string {
    const text = decodeMemo(memo)
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h\d)>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    return decodeHtml(text)
        .replace(/[ \t ]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
