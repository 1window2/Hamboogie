import {useRef, useState, type ReactNode} from "react";
import {KEYWORD_LENGTH_MAX, KEYWORD_MAX, normalizeKeywords} from "@shared/settings";
import {keywordKey, splitKeywords} from "@shared/text";
import {isCommitEnter} from "./keys";
import {addKeywords, keywordAddNotices} from "./keyword-add";
import {useConfirm} from "./ConfirmDialog";

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
 * 키워드 칩 목록과 입력칸입니다. 쉼표나 줄바꿈으로 여러 개를 한 번에 넣을 수 있고 최대 30개, 한 키워드에 30자까지입니다.
 * 넣지 못한 키워드(개수 초과, 너무 김)는 입력칸에 남기고, 겹쳐서 뺀 것과 함께 아래에 알려 줍니다.
 *
 * 입력칸은 값을 화면 상태로 들고 있지 않고(uncontrolled) 입력칸 자체에 둡니다. 감시 중에는 상태가 자주 바뀌어 화면이 계속
 * 다시 그려지는데, 값을 상태로 들고 있으면 한글을 조합하는 도중에 다시 그려질 때 입력칸 값이 조합 전 값으로 되돌려져
 * 조합 중이던 글자가 사라집니다("싸단"을 치면 "싸ㄴ"만 남음). 입력칸 값을 건드리는 것은 추가한 뒤 넣지 못한 키워드만 남길 때뿐입니다.
 */
export function KeywordEditor({label, keywords, onChange, placeholder, notice, defaults}: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    /** 입력칸 글자의 사본입니다. 입력칸 값으로 되돌려 쓰지 않고, 아직 추가하지 않은 키워드가 있는지 볼 때만 씁니다. */
    const [text, setText] = useState("");
    /** 마지막으로 추가할 때 넣지 못했거나 뺀 키워드 안내입니다. 넣지 못한 것이 있으면 `error`입니다. 입력칸을 고치면 지웁니다. */
    const [addNotice, setAddNotice] = useState<{text: string; error: boolean} | null>(null);
    const [confirm, confirmDialog] = useConfirm();
    const full = keywords.length >= KEYWORD_MAX;
    const existing = new Set(keywords.map(keywordKey));
    const typed = splitKeywords(text);
    /** 입력칸에 아직 추가하지 않은 새 키워드가 있는지입니다. 목록이 바뀌면(칩 삭제, 기본값으로 바꾸기) 다시 계산됩니다. */
    const pending = typed.some((keyword) => !existing.has(keywordKey(keyword)));
    const tooLong = typed.some((keyword) => keyword.length > KEYWORD_LENGTH_MAX);

    function add() {
        const element = inputRef.current;
        if (!element) return;
        const added = splitKeywords(element.value);
        if (added.length === 0) return;
        const result = addKeywords(keywords, added);
        if (result.keywords.length !== keywords.length) onChange(result.keywords);
        // 넣지 못한 키워드는 지우지 않고 입력칸에 남겨, 목록을 정리한 뒤 다시 넣거나 고쳐 넣을 수 있게 합니다.
        const rest = [...result.overflow, ...result.tooLong].join(", ");
        element.value = rest;
        setText(rest);
        const notices = keywordAddNotices(result);
        setAddNotice(notices.length > 0 ? {text: notices.join(" "), error: rest !== ""} : null);
    }

    const isDefault = defaults !== undefined && defaults.length === keywords.length && defaults.every((keyword, index) => keyword === keywords[index]);

    async function resetToDefaults() {
        if (!defaults) return;
        const confirmed = await confirm({
            title: `${label}를 기본 목록으로 바꿀까요?`,
            message: (
                <>
                    <p>지금 목록({keywords.length}개)은 사라지고 기본 목록 {defaults.length}개로 바뀝니다.</p>
                    <p className="muted">{defaults.join(", ")}</p>
                </>
            ),
            confirmLabel: "기본 목록으로 바꾸기"
        });
        if (confirmed) onChange(normalizeKeywords([...defaults]));
    }

    return (
        <div className="field">
            <span className="row">
                {label} ({keywords.length}/{KEYWORD_MAX})
                {defaults && (
                    <button type="button" className="button small push-right" disabled={isDefault} title={isDefault ? "이미 기본 목록입니다" : undefined} onClick={() => void resetToDefaults()}>
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
                {/* 목록이 가득 차도 입력칸은 막지 않습니다. 넣지 못하고 남은 키워드를 고치거나 지울 수 있어야 하기 때문입니다. */}
                <input ref={inputRef} aria-label={label} defaultValue="" placeholder={full ? `최대 ${KEYWORD_MAX}개입니다` : placeholder}
                       onInput={(event) => {
                           setText(event.currentTarget.value);
                           setAddNotice(null);
                       }}
                       onKeyDown={(event) => isCommitEnter(event) && add()}/>
                <button className="button small" disabled={!pending} onClick={add}>추가</button>
            </div>
            {addNotice
                ? <small className={addNotice.error ? "error-text" : "muted"} role="status">{addNotice.text}</small>
                : tooLong ? <small className="error-text">키워드 하나는 {KEYWORD_LENGTH_MAX}자까지입니다.</small>
                    : full && pending ? <small className="error-text">목록이 가득 찼습니다(최대 {KEYWORD_MAX}개). 칩의 ×로 지운 뒤 추가하세요.</small>
                        : pending ? <small className="muted">Enter나 "추가"를 눌러야 목록에 들어갑니다. 설정 저장만 누르면 입력칸의 글자는 저장되지 않습니다.</small>
                            : typed.length > 0 && <small className="muted">입력한 키워드는 이미 목록에 있습니다.</small>}
            {confirmDialog}
        </div>
    );
}
