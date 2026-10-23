/**
 * 디시 앱 인증(app_id) 발급 거절에 대한 대기 규칙입니다.
 *
 * 같은 IP에서 짧은 시간에 app_id를 여러 번 발급받으면 서버가 기기 정보와 상관없이 한동안
 * `service id mismatched`로 거절합니다. 거절될 때마다 다시 시도하거나 기기 정보를 새로 받으면
 * 발급 시도만 늘어 제한이 길어지므로, 거절되면 잠시 쉬고 기기 정보는 그대로 씁니다.
 * 오래(기본 30분) 거절이 이어질 때만 마지막 수단으로 기기 정보를 새로 받습니다.
 */
export class AppIdBackoff {
    private firstFailureAt: number | null = null;
    private pausedUntil = 0;

    constructor(
        private readonly now: () => number = Date.now,
        readonly pauseMs = 5 * 60 * 1000,
        private readonly freshDeviceAfterMs = 30 * 60 * 1000
    ) {}

    /** 지금 app_id가 필요한 요청을 보내도 되는지 알려줍니다. */
    canTry(): boolean {
        return this.now() >= this.pausedUntil;
    }

    get failing(): boolean {
        return this.firstFailureAt !== null;
    }

    /**
     * 거절을 기록하고 잠시 쉽니다. 기기 정보를 새로 받아야 할 만큼 오래 거절이 이어졌으면 true를 돌려줍니다.
     * @param pauseMs 기본보다 오래 쉬어야 할 때 넘깁니다(예: 앱 버전이 낮아 거절된 경우).
     */
    fail(pauseMs = this.pauseMs): boolean {
        const now = this.now();
        this.firstFailureAt ??= now;
        this.pausedUntil = now + pauseMs;
        if (now - this.firstFailureAt < this.freshDeviceAfterMs) return false;
        this.firstFailureAt = now;
        return true;
    }

    succeed(): void {
        this.firstFailureAt = null;
        this.pausedUntil = 0;
    }
}
