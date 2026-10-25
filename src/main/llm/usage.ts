import {nextPacificMidnight} from "./providers";

export interface UsageRecord {
    /** 이 시각(ms)이 지나면 다시 0부터 셉니다. 무료 한도가 초기화되는 태평양 시간 자정입니다. */
    resetAt: number;
    count: number;
}

/** 오늘 보낸 LLM 요청 수를 셉니다. 앱을 다시 켜도 이어서 세도록 저장합니다. */
export class LlmUsage {
    private record: UsageRecord;

    constructor(
        load: () => UsageRecord | null,
        private readonly save: (record: UsageRecord) => void,
        private readonly now: () => number = Date.now
    ) {
        this.record = load() ?? {resetAt: 0, count: 0};
    }

    /** 초기화 시각이 지났으면 0부터 다시 셉니다. */
    private current(): UsageRecord {
        if (this.now() >= this.record.resetAt) this.record = {resetAt: nextPacificMidnight(this.now()), count: 0};
        return this.record;
    }

    get count(): number {
        return this.current().count;
    }

    get resetAt(): number {
        return this.current().resetAt;
    }

    /** `limit`(0 이하면 제한 없음) 안에서 요청을 더 보낼 수 있는지입니다. */
    canUse(limit: number): boolean {
        return limit <= 0 || this.current().count < limit;
    }

    add(requests = 1): void {
        const record = this.current();
        record.count += requests;
        this.save({...record});
    }
}
