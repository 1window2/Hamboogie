/** 입력칸의 글자를 0 이상의 정수로 읽습니다. 비었거나 숫자가 아니면 null입니다. */
export function parseNonNegativeInt(text: string): number | null {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
}
