import {useState, type ReactNode} from "react";
import {KEYWORD_MAX} from "@shared/settings";

interface Props {
    label: string;
    keywords: string[];
    onChange(keywords: string[]): void;
    placeholder: string;
    /** 목록 위에 보여줄 안내(경고 등)입니다. */
    notice?: ReactNode;
}

/** 키워드 칩 목록과 입력칸입니다. 쉼표나 줄바꿈으로 여러 개를 한 번에 넣을 수 있고 최대 30개까지입니다. */
export function KeywordEditor({label, keywords, onChange, placeholder, notice}: Props) {
    const [input, setInput] = useState("");
    const full = keywords.length >= KEYWORD_MAX;

    function add() {
        const added = input.split(/[,\n]/).map((keyword) => keyword.trim()).filter(Boolean);
        onChange([...new Set([...keywords, ...added])].slice(0, KEYWORD_MAX));
        setInput("");
    }

    return (
        <div className="field">
            <span>{label} ({keywords.length}/{KEYWORD_MAX})</span>
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
                <input value={input} disabled={full} placeholder={full ? `최대 ${KEYWORD_MAX}개입니다` : placeholder}
                       onChange={(event) => setInput(event.target.value)}
                       onKeyDown={(event) => event.key === "Enter" && add()}/>
                <button className="button small" disabled={full || !input.trim()} onClick={add}>추가</button>
            </div>
        </div>
    );
}
