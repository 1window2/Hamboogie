import {describe, expect, it} from "vitest";
import {clockText, dateTimeText, kstClockText, kstDayStart, timeText} from "../src/shared/time";

/** 한국 시간 2026-10-25 hh:mm:ss */
const kst = (hours: number, minutes = 0, seconds = 0, day = 25) => Date.UTC(2026, 9, day, hours - 9, minutes, seconds);

describe("시각 표시", () => {
    it("한국 날짜의 0시를 구한다(한국 시간으로 자정 직후와 자정 직전 모두)", () => {
        expect(kstDayStart(kst(0, 30))).toBe(kst(0));
        expect(kstDayStart(kst(23, 59, 59))).toBe(kst(0));
        expect(kstDayStart(kst(0, 0, 0, 26))).toBe(kst(0, 0, 0, 26));
    });

    it("이 컴퓨터 시간으로 시각과 날짜를 두 자리씩 쓰고, 오늘이 아니면 \"내일\"을 붙인다", () => {
        const at = new Date(2026, 9, 30, 9, 5, 7).getTime();
        expect(timeText(at)).toBe("09:05");
        expect(timeText(at, true)).toBe("09:05:07");
        expect(dateTimeText(at)).toBe("10/30 09:05");
        expect(dateTimeText(at, true)).toBe("10/30 09:05:07");
        expect(clockText(at, at)).toBe("09:05");
        expect(clockText(at, new Date(2026, 9, 29, 23, 0).getTime())).toBe("내일 09:05");
    });

    it("한국 시간으로 오전/오후를 붙여 쓴다", () => {
        expect(kstClockText(kst(16))).toBe("오후 4:00");
        expect(kstClockText(kst(9, 5))).toBe("오전 9:05");
    });
});
