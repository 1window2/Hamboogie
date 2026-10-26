import {keywordKey} from "@shared/text";

/** 글과 키워드를 같은 형태로 맞춥니다(자모 분리 한글·전각 문자 통일, 공백 제거, 소문자). */
function compact(text: string): string {
    return keywordKey(text);
}

/** 글에 들어 있는 첫 번째 키워드를 돌려줍니다. 공백과 대소문자는 무시합니다. 없으면 null입니다. */
export function findKeyword(text: string, keywords: string[]): string | null {
    const target = compact(text);
    return keywords.find((keyword) => {
        const needle = compact(keyword);
        return needle.length > 0 && target.includes(needle);
    }) ?? null;
}

/** 제목에 키워드가 하나라도 들어 있으면 통과합니다. 키워드가 없으면 모든 글이 통과합니다. */
export function matchesKeywords(title: string, keywords: string[]): boolean {
    return keywords.length === 0 || findKeyword(title, keywords) !== null;
}
