import {decodeHtml} from "@green-1052/dcinside.js";

/**
 * 앱 API는 본문 HTML을 이스케이프해서 줍니다. 찾는 태그(`until`, 기본은 아무 태그)가 보일 때까지 최대 두 번 풀어 HTML로 돌려놓습니다.
 * 태그 모양은 `[^<>]`로 찾습니다. `[^>]`로 찾으면 `>` 없이 `<`만 잔뜩 든 글에서 검사가 글 길이의 제곱만큼 느려집니다.
 */
export function decodeMemo(memo: string, until: RegExp = /<[a-z/][^<>]*>/i): string {
    let html = memo;
    for (let i = 0; i < 2 && !until.test(html) && /&lt;/.test(html); i++) html = decodeHtml(html);
    return html;
}

/**
 * `<script>`, `<style>` 블록을 내용째 지웁니다. 정규식으로 여는 태그마다 닫는 태그를 찾으면 닫히지 않은 태그가 많은 글에서
 * 글 길이의 제곱만큼 느려지므로, 앞에서부터 한 번만 훑습니다. 닫히지 않은 블록은 끝까지 지웁니다.
 */
function stripBlocks(html: string): string {
    const lower = html.toLowerCase();
    let result = "";
    let at = 0;
    // 각 여는 태그의 다음 위치는 지나쳤을 때만 다시 찾습니다. 한쪽 태그만 많은 글에서도 매번 끝까지 찾지 않게 합니다.
    let script = -2;
    let style = -2;
    for (;;) {
        if (script !== -1 && script < at) script = lower.indexOf("<script", at);
        if (style !== -1 && style < at) style = lower.indexOf("<style", at);
        const start = script === -1 ? style : style === -1 ? script : Math.min(script, style);
        if (start === -1) return result + html.slice(at);
        result += `${html.slice(at, start)} `;
        const close = lower.indexOf(start === script ? "</script" : "</style", start);
        if (close === -1) return result;
        const end = lower.indexOf(">", close);
        if (end === -1) return result;
        at = end + 1;
    }
}

/** 앱 API 본문(HTML이 한 번 더 이스케이프된 상태)을 LLM에 보낼 텍스트로 바꿉니다. 이미지는 버립니다. */
export function htmlToText(memo: string): string {
    const text = stripBlocks(decodeMemo(memo))
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h\d)>/gi, "\n")
        .replace(/<[^<>]+>/g, " ");
    // 줄바꿈이 아닌 공백(전각 공백 등 포함)은 하나로 합칩니다.
    return decodeHtml(text)
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
