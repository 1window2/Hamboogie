/** 한국 시간(UTC+9)과 하루의 길이(ms)입니다. 디시가 주는 시각과 나눔 글의 시각은 한국 시간입니다. */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 이 컴퓨터 시간으로 "HH:MM"을 씁니다. 오늘이 아니면 "내일"을 붙입니다. */
export function clockText(at: number, now = Date.now()): string {
    const date = new Date(at);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return date.toDateString() === new Date(now).toDateString() ? time : `내일 ${time}`;
}

/** 글의 모바일 주소입니다. */
export function postUrl(galleryId: string, postNo: number): string {
    return `https://m.dcinside.com/board/${galleryId}/${postNo}`;
}
