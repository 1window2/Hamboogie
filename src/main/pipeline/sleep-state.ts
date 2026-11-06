/** 이보다 오래 잠들었으면 그사이 글은 버리고 기준 글을 새로 잡습니다. */
export const LONG_SLEEP_MS = 5 * 60 * 1000;

/**
 * 컴퓨터의 잠자기 상태입니다. 감시, 판단, 줄 서기가 함께 봅니다.
 *
 * `current`는 잠들어 있거나 깨어나서 네트워크를 기다리는 중일 때 있습니다. 이동안에는 확인을 멈추고 디시·LLM에 요청하지 않습니다.
 * `since`는 잠든 시각, `awake`는 확인을 이어가도 될 때(또는 감시를 멈췄을 때) 풀리는 약속입니다. `wakes`는 깨어남·다시 잠듦마다
 * 늘어나 이전의 기다림을 그만두게 하고, `resuming`은 지금 깨어나는 중인지입니다.
 */
export class SleepState {
    current: {since: number; awake: Promise<void>; release: () => void; wakes: number; resuming: boolean} | null = null;
    /** 마지막으로 잠들었던 구간입니다. 그 구간에 걸친 LLM 판단이 실패하면 알리지 않습니다. */
    last: {from: number; to: number} | null = null;
    /** 깨어나 네트워크가 붙었을 때 부를 함수입니다. 잠든 사이 시각이 된 줄 서기를 바로 확인하게 합니다. */
    private readonly wakeListeners = new Set<() => void>();

    get asleep(): boolean {
        return this.current !== null;
    }

    /** 잠들기 시작합니다. 이미 잠들어 있었으면(깨어나 네트워크를 기다리던 중) 기다리던 것을 그만두게 하고 이어서 셉니다. */
    begin(at: number): boolean {
        if (this.current) {
            this.current.wakes++;
            this.current.resuming = false;
            return false;
        }
        let release = () => {};
        const awake = new Promise<void>((resolve) => (release = resolve));
        this.current = {since: at, awake, release, wakes: 0, resuming: false};
        return true;
    }

    /** 잠자기를 끝냅니다(깨어나 네트워크가 붙었거나 감시를 멈춤). 기다리던 일이 이어갑니다. */
    end(): void {
        const sleeping = this.current;
        this.current = null;
        sleeping?.release();
        if (sleeping) for (const listener of this.wakeListeners) listener();
    }

    /** 깨어나 있으면 바로, 잠들어 있으면 깨어날 때까지 기다립니다. */
    async waitAwake(): Promise<void> {
        await this.current?.awake;
    }

    onWake(listener: () => void): void {
        this.wakeListeners.add(listener);
    }

    /** 이 시각이 5분 넘게 잠들어 있던 사이였는지입니다. */
    inLongSleep(at: number): boolean {
        const sleep = this.last;
        return sleep !== null && sleep.to - sleep.from > LONG_SLEEP_MS && at >= sleep.from && at <= sleep.to;
    }

    /** 이 시각에 시작한 일이 잠자기 구간에 걸쳐 있었는지입니다. */
    sleptSince(startedAt: number): boolean {
        return this.current !== null || (this.last !== null && startedAt <= this.last.to);
    }
}
