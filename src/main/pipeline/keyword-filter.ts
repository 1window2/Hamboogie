function compact(text: string): string {
    return text.replace(/\s+/g, "").toLowerCase();
}

/** 제목에 키워드가 하나라도 들어 있으면 통과합니다. 키워드가 없으면 모든 글이 통과합니다. */
export function matchesKeywords(title: string, keywords: string[]): boolean {
    if (keywords.length === 0) return true;
    const target = compact(title);
    return keywords.some((keyword) => {
        const needle = compact(keyword);
        return needle.length > 0 && target.includes(needle);
    });
}
