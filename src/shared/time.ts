/** 한국 시간(UTC+9)과 하루의 길이(ms)입니다. 디시가 주는 시각과 나눔 글의 시각은 한국 시간입니다. */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 이 시각이 속한 한국 날짜의 0시(ms)입니다. */
export function kstDayStart(at: number): number {
    const kst = new Date(at + KST_OFFSET_MS);
    return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_OFFSET_MS;
}

/** LLM에 넘길 한국 시간 "YYYY-MM-DD HH:MM:SS"입니다. */
export function formatKst(time: number): string {
    return new Date(time + KST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** 다음 태평양 시간 자정(ms)입니다. Gemini 무료 등급의 하루 한도가 이때 초기화됩니다. */
export function nextPacificMidnight(now = Date.now()): number {
    const parts = new Intl.DateTimeFormat("en-US", {timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"})
        .formatToParts(new Date(now));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    // 자정을 "24시"로 주는 환경이 있어 시만 24로 나눈 나머지를 씁니다.
    const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 + now % 1000;
    return now - elapsed + 24 * 60 * 60 * 1000;
}


const pad = (value: number) => String(value).padStart(2, "0");

/** 이 컴퓨터 시간으로 "14:03"(`seconds`면 "14:03:05")처럼 씁니다. */
export function timeText(at: number, seconds = false): string {
    const date = new Date(at);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return seconds ? `${time}:${pad(date.getSeconds())}` : time;
}

/** 이 컴퓨터 시간으로 "10/30 14:03"(`seconds`면 "10/30 14:03:05")처럼 날짜와 함께 씁니다. */
export function dateTimeText(at: number, seconds = false): string {
    const date = new Date(at);
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${timeText(at, seconds)}`;
}

/** 이 컴퓨터 시간으로 "HH:MM"을 씁니다. 오늘이 아니면 "내일"을 붙입니다. */
export function clockText(at: number, now = Date.now()): string {
    const time = timeText(at);
    return new Date(at).toDateString() === new Date(now).toDateString() ? time : `내일 ${time}`;
}

/** 한국 시간으로 "오후 4:00"처럼 씁니다. LLM 하루 한도가 초기화되는 시각처럼 한국 시간으로 알릴 때 씁니다. */
export function kstClockText(at: number): string {
    return new Date(at).toLocaleTimeString("ko-KR", {hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Seoul"});
}

/** 글의 모바일 주소입니다. */
export function postUrl(galleryId: string, postNo: number): string {
    return `https://m.dcinside.com/board/${galleryId}/${postNo}`;
}
