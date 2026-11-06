/** 정한 시각이 됐는지 다시 확인하는 최대 간격입니다. */
const CHECK_MS = 60 * 1000;

/**
 * 정한 시각(ms)에 한 번 `onDue`를 부르는 타이머입니다. 컴퓨터가 잠들었다 깨어나거나 시계가 바뀌어도 늦지 않게,
 * 길게 한 번 기다리지 않고 최대 1분마다 시계를 다시 봅니다(macOS의 타이머는 잠든 동안 흐르지 않아, 한 번에 기다리면
 * 잠든 시간만큼 늦어집니다). 깨어난 직후처럼 바로 확인해야 하면 `check()`를 부릅니다.
 */
export class WallTimer {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly at: number, private readonly now: () => number, private readonly onDue: () => void) {
        this.arm();
    }

    get pending(): boolean {
        return this.timer !== null;
    }

    /** 시각이 지났으면 바로 부르고, 아니면 다시 기다립니다. */
    check(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = null;
        this.arm();
    }

    cancel(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private arm(): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.now() < this.at) this.arm();
            else this.onDue();
        }, Math.min(Math.max(this.at - this.now(), 0), CHECK_MS));
    }
}
