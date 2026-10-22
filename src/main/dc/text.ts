import {decodeHtml} from "@green-1052/dcinside.js";

/** 앱 API 본문(HTML이 한 번 더 이스케이프된 상태)을 LLM에 보낼 텍스트로 바꿉니다. 이미지는 버립니다. */
export function htmlToText(memo: string): string {
    let html = memo;
    // 앱 API는 본문 HTML을 이스케이프해서 줍니다. 태그가 보일 때까지 최대 두 번 풉니다.
    for (let i = 0; i < 2 && !/<[a-z/][^>]*>/i.test(html) && /&lt;/.test(html); i++) html = decodeHtml(html);
    const text = html
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
