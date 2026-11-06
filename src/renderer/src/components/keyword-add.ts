import {KEYWORD_LENGTH_MAX, KEYWORD_MAX} from "@shared/settings";
import {keywordKey} from "@shared/text";

export interface KeywordAddResult {
    /** 추가한 뒤의 목록입니다. */
    keywords: string[];
    /** 목록이 가득 차서 넣지 못한 키워드입니다. 입력칸에 남겨 둡니다. */
    overflow: string[];
    /** 너무 길어서 넣지 못한 키워드입니다. 고쳐 넣을 수 있게 입력칸에 남겨 둡니다. */
    tooLong: string[];
    /** 이미 있거나 같이 넣은 것과 겹쳐서 뺀 키워드입니다. */
    duplicates: string[];
}

/**
 * 입력한 키워드(`splitKeywords`로 나누고 다듬은 것)를 목록에 넣을 수 있는 만큼 넣습니다. 넣지 못한 것은 이유별로 돌려줘서
 * 조용히 사라지지 않게 합니다. 대소문자·공백·글자 형태만 다른 키워드는 이미 있는 것으로 봅니다.
 */
export function addKeywords(current: string[], added: string[]): KeywordAddResult {
    const seen = new Set(current.map(keywordKey));
    const result: KeywordAddResult = {keywords: [...current], overflow: [], tooLong: [], duplicates: []};
    for (const keyword of added) {
        const key = keywordKey(keyword);
        if (!key) continue;
        if (keyword.length > KEYWORD_LENGTH_MAX) result.tooLong.push(keyword);
        else if (seen.has(key)) result.duplicates.push(keyword);
        else if (result.keywords.length >= KEYWORD_MAX) result.overflow.push(keyword);
        else {
            seen.add(key);
            result.keywords.push(keyword);
        }
    }
    return result;
}

/** 넣지 못한 키워드가 있으면 그 까닭을 한 문장씩 씁니다. 모두 넣었으면 빈 배열입니다. */
export function keywordAddNotices({overflow, tooLong, duplicates}: KeywordAddResult): string[] {
    const notices: string[] = [];
    if (overflow.length > 0) notices.push(`${KEYWORD_MAX}개까지만 넣을 수 있어 ${overflow.length}개는 넣지 못했습니다.`);
    if (tooLong.length > 0) notices.push(`${KEYWORD_LENGTH_MAX}자보다 긴 키워드 ${tooLong.length}개는 넣지 못했습니다.`);
    if (overflow.length + tooLong.length > 0) notices.push("넣지 못한 키워드는 입력칸에 남겨 두었습니다.");
    if (duplicates.length > 0) notices.push(`이미 있는 키워드는 뺐습니다: ${duplicates.join(", ")}`);
    return notices;
}
