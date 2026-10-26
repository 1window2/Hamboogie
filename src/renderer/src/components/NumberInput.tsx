import {useEffect, useRef, useState} from "react";
import {parseNonNegativeInt} from "./number-text";
import {normalizeText} from "@shared/text";

interface Props {
    value: number;
    onChange(value: number): void;
    min?: number;
    className?: string;
}

/**
 * 0 이상의 정수 입력칸입니다. 입력 중인 글자는 따로 들고 있어서, 칸을 비우거나 앞자리 0을 지우는 도중에
 * 값이 0으로 되돌아가지 않습니다. 비운 채로 포커스를 잃으면 입력을 시작하기 전 값으로 돌아갑니다.
 */
export function NumberInput({value, onChange, min, className}: Props) {
    const [text, setText] = useState(String(value));
    const valueAtFocus = useRef(value);

    // 되돌리기나 단위 변경처럼 밖에서 값이 바뀌면 입력칸도 맞춥니다.
    useEffect(() => {
        setText((current) => parseNonNegativeInt(current) === value ? current : String(value));
    }, [value]);

    function commit(next: string) {
        const parsed = parseNonNegativeInt(next);
        return parsed !== null && (min === undefined || parsed >= min) ? parsed : null;
    }

    return (
        <input type="text" inputMode="numeric" className={className} value={text}
               onFocus={() => {
                   valueAtFocus.current = value;
               }}
               onChange={(event) => {
                   // 전각 숫자(１０)는 일반 숫자로 바꾸고 공백은 지웁니다. 숫자가 아닌 글자가 섞이면("1.5", "-5", "10초") 받지 않습니다.
                   // 숫자만 골라내면 "1.5"가 15처럼 엉뚱한 값이 되기 때문입니다.
                   const next = normalizeText(event.target.value).replace(/\s+/g, "");
                   if (!/^\d*$/.test(next)) return;
                   setText(next);
                   const parsed = commit(next);
                   if (parsed !== null) onChange(parsed);
               }}
               onBlur={() => {
                   if (commit(text) !== null) {
                       setText(String(value));
                       return;
                   }
                   setText(String(valueAtFocus.current));
                   if (value !== valueAtFocus.current) onChange(valueAtFocus.current);
               }}/>
    );
}
