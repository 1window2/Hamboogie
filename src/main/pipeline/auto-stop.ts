import {WallTimer} from "./wall-timer";

/**
 * 정한 시각에 한 번 `onDue`를 부르는 타이머입니다. 컴퓨터가 잠들었다 깨거나 시계가 바뀌어도 늦지 않게,
 * 길게 한 번 기다리지 않고 최대 1분마다 시각을 다시 확인합니다(`WallTimer`).
 */
export class AutoStopTimer {
    private pending: WallTimer | null = null;

    constructor(private readonly now: () => number, private readonly onDue: () => void) {}

    /** 멈출 시각(ms)입니다. 잡혀 있지 않으면 null입니다. */
    get at(): number | null {
        return this.pending?.at ?? null;
    }

    /** 멈출 시각을 바꿉니다. null이면 끕니다. */
    set(at: number | null): void {
        this.clear();
        if (at === null) return;
        const timer: WallTimer = new WallTimer(at, this.now, () => {
            if (this.pending !== timer) return;
            this.pending = null;
            this.onDue();
        });
        this.pending = timer;
    }

    clear(): void {
        this.pending?.cancel();
        this.pending = null;
    }
}
