/**
 * 디시 앱 인증(app_id) 발급 거절에 대한 대기 규칙입니다.
 *
 * 같은 IP에서 짧은 시간에 app_id를 여러 번 발급받으면 서버가 기기 정보와 상관없이 한동안
 * `service id mismatched`로 거절합니다. 거절될 때마다 다시 시도하거나 기기 정보를 새로 받으면
 * 발급 시도만 늘어 제한이 길어지므로, 거절되면 쉬고(거절이 이어질수록 길게) 기기 정보는 그대로 씁니다.
 * 오래(기본 30분) 거절이 이어질 때만 마지막 수단으로 기기 정보를 새로 받되, 새 기기 등록이 쌓이지 않도록
 * 하루에 한 번까지만 받습니다.
 */
export class AppIdBackoff {
    private firstFailureAt: number | null = null;
    private pausedUntil = 0;
    private consecutive = 0;
    private lastFreshDeviceAt: number | null = null;
    /** 마지막 거절 뒤 쉬기로 한 시간(ms)입니다. 로그에 씁니다. */
    lastPauseMs = 0;

    constructor(
        private readonly now: () => number = Date.now,
        readonly pauseMs = 5 * 60 * 1000,
        private readonly freshDeviceAfterMs = 30 * 60 * 1000,
        private readonly maxPauseMs = 60 * 60 * 1000,
        private readonly freshDeviceGapMs = 24 * 60 * 60 * 1000
    ) {}

    /** 지금 app_id가 필요한 요청을 보내도 되는지 알려줍니다. */
    canTry(): boolean {
        return this.now() >= this.pausedUntil;
    }

    get failing(): boolean {
        return this.firstFailureAt !== null;
    }

    /**
     * 거절을 기록하고 쉽니다. 거절이 이어질 때마다 쉬는 시간을 두 배로 늘립니다(최대 1시간).
     * 기기 정보를 새로 받아야 할 만큼 오래 거절이 이어졌고, 최근 하루 안에 새로 받은 적이 없으면 true를 돌려줍니다.
     * @param pauseMs 정해진 시간만큼 쉬어야 할 때 넘깁니다(예: 앱 버전이 낮아 거절된 경우).
     */
    fail(pauseMs?: number): boolean {
        const now = this.now();
        this.firstFailureAt ??= now;
        this.consecutive++;
        this.lastPauseMs = pauseMs ?? Math.min(this.pauseMs * 2 ** (this.consecutive - 1), this.maxPauseMs);
        this.pausedUntil = now + this.lastPauseMs;
        if (now - this.firstFailureAt < this.freshDeviceAfterMs) return false;
        if (this.lastFreshDeviceAt !== null && now - this.lastFreshDeviceAt < this.freshDeviceGapMs) return false;
        this.firstFailureAt = now;
        this.lastFreshDeviceAt = now;
        return true;
    }

    succeed(): void {
        this.firstFailureAt = null;
        this.pausedUntil = 0;
        this.consecutive = 0;
    }
}
