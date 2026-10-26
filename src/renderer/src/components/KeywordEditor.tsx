import {useRef, useState, type ReactNode} from "react";
import {KEYWORD_MAX, normalizeKeywords} from "@shared/settings";
import {keywordKey, splitKeywords} from "@shared/text";
import {isCommitEnter} from "./keys";

interface Props {
    label: string;
    keywords: string[];
    onChange(keywords: string[]): void;
    placeholder: string;
    /** 목록 위에 보여줄 안내(경고 등)입니다. */
    notice?: ReactNode;
    /** 있으면 "기본 키워드로 바꾸기" 버튼을 보여줍니다. 예전 버전에서 만든 갤러리는 기본 키워드가 바뀌어도 그대로라, 직접 맞출 수 있게 합니다. */
    defaults?: readonly string[];
}

/**
 * 키워드 칩 목록과 입력칸입니다. 쉼표나 줄바꿈으로 여러 개를 한 번에 넣을 수 있고 최대 30개까지입니다.
 *
 * 입력칸은 값을 화면 상태로 들고 있지 않고(uncontrolled) 입력칸 자체에 둡니다. 감시 중에는 상태가 자주 바뀌어 화면이 계속
 * 다시 그려지는데, 값을 상태로 들고 있으면 한글을 조합하는 도중에 다시 그려질 때 입력칸 값이 조합 전 값으로 되돌려져
 * 조합 중이던 글자가 사라집니다("싸단"을 치면 "싸ㄴ"만 남음). 입력칸 값을 건드리는 것은 추가 후 비울 때뿐입니다.
 */
export function KeywordEditor({label, keywords, onChange, placeholder, notice, defaults}: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    /** 입력칸에 아직 추가하지 않은 새 키워드가 있는지입니다. 공백·쉼표뿐이거나 이미 있는 키워드면 false입니다. */
    const [pending, setPending] = useState(false);
    const full = keywords.length >= KEYWORD_MAX;
    const existing = new Set(keywords.map(keywordKey));
    const hasNew = (text: string) => splitKeywords(text).some((keyword) => !existing.has(keywordKey(keyword)));

    function add() {
        const element = inputRef.current;
        if (!element) return;
        const added = splitKeywords(element.value);
        if (added.length === 0) return;
        // 대소문자·공백·글자 형태만 다른 키워드는 이미 있는 것으로 봅니다.
        onChange(normalizeKeywords([...keywords, ...added]));
        element.value = "";
        setPending(false);
    }

    const isDefault = defaults !== undefined && defaults.length === keywords.length && defaults.every((keyword, index) => keyword === keywords[index]);

    function resetToDefaults() {
        if (!defaults) return;
        if (!confirm(`${label}를 기본 목록 ${defaults.length}개로 바꿀까요? 지금 목록(${keywords.length}개)은 사라집니다.\n\n${defaults.join(", ")}`)) return;
        onChange(normalizeKeywords([...defaults]));
    }

    return (
        <div className="field">
            <span className="row">
                {label} ({keywords.length}/{KEYWORD_MAX})
                {defaults && (
                    <button type="button" className="button small push-right" disabled={isDefault} title={isDefault ? "이미 기본 목록입니다" : undefined} onClick={resetToDefaults}>
                        기본 키워드로 바꾸기
                    </button>
                )}
            </span>
            {notice}
            {keywords.length > 0 && (
                <div className="chips">
                    {keywords.map((keyword) => (
                        <span key={keyword} className="chip">
                            {keyword}
                            <button aria-label={`${keyword} 삭제`} onClick={() => onChange(keywords.filter((item) => item !== keyword))}>×</button>
                        </span>
                    ))}
                </div>
            )}
            <div className="row">
                <input ref={inputRef} aria-label={label} defaultValue="" disabled={full} placeholder={full ? `최대 ${KEYWORD_MAX}개입니다` : placeholder}
                       onInput={(event) => setPending(hasNew(event.currentTarget.value))}
                       onKeyDown={(event) => isCommitEnter(event) && add()}/>
                <button className="button small" disabled={full || !pending} onClick={add}>추가</button>
            </div>
            {pending && <small className="muted">Enter나 "추가"를 눌러야 목록에 들어갑니다. 설정 저장만 누르면 입력칸의 글자는 저장되지 않습니다.</small>}
        </div>
    );
}
