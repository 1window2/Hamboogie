import {effectiveRpm, FREE_DAILY_LLM_REQUESTS, PROVIDER_LABELS} from "@shared/settings";
import type {Settings} from "@shared/types";
import type {Logger} from "../logger";
import {createProvider, LlmQuotaExhaustedError, type LlmProvider} from "./providers";
import {RateLimiter} from "./rate-limit";
import {LlmUsage} from "./usage";

export interface LlmGateDeps {
    settings(): Settings;
    secrets: {get(key: `llm:${Settings["llm"]["provider"]}`): string | null | undefined};
    logger: Logger;
    /** 오늘 보낸 LLM 요청 수입니다(무료 등급 하루 한도). 없으면 앱을 켜 둔 동안만 셉니다. */
    usage?: LlmUsage;
}

/**
 * LLM 요청 창구입니다. 지금 설정의 LLM 클라이언트를 만들어 두고, 분당 요청 한도와 무료 등급 하루 요청 수를 지키며,
 * LLM 서비스의 한도(하루 한도, 결제 한도)를 다 썼다는 오류가 오면 초기화될 때까지 요청을 멈춥니다.
 */
export class LlmGate {
    usage: LlmUsage;
    /** 한도를 다 써서 쉬는 중이면 다시 요청해도 되는 시각과 이유입니다. */
    pause: {until: number; message: string} | null = null;
    /** LLM 클라이언트를 만드는 함수입니다. 테스트에서 바꿉니다. */
    create = createProvider;
    /** 갤러리와 상관없이 앱 전체의 LLM 요청 수를 셉니다. */
    private readonly limiter = new RateLimiter(() => effectiveRpm(this.deps.settings().llm));
    /** 같은 서비스/모델/키라면 LLM 클라이언트를 다시 만들지 않습니다. */
    private cached: {key: string; instance: LlmProvider} | null = null;

    /** @param onPause 한도를 다 써서 쉬기 시작할 때 한 번 부릅니다(알림용). */
    constructor(private readonly deps: LlmGateDeps, private readonly onPause: (message: string) => Promise<void>) {
        this.usage = deps.usage ?? new LlmUsage(() => null, () => {});
    }

    /** 한도를 다 써서 쉬는 중인지입니다. */
    get paused(): boolean {
        return this.pause !== null && Date.now() < this.pause.until;
    }

    /** 무료 등급이면 하루 LLM 요청 수 한도, 유료 요금제면 0(제한 없음)입니다. */
    dailyLimit(): number {
        return this.deps.settings().llm.paidPlan ? 0 : FREE_DAILY_LLM_REQUESTS;
    }

    /** 오늘 요청을 더 보낼 수 있는지입니다. */
    canUseToday(): boolean {
        return this.usage.canUse(this.dailyLimit());
    }

    /** 지금 기다리지 않고 바로 보낼 수 있는 요청 자리가 있는지입니다. */
    hasSlotNow(): boolean {
        return this.limiter.available() > 0;
    }

    /** 오늘 쓴 LLM 요청 수와 한도입니다. 화면에 보여줍니다. */
    view(): {count: number; limit: number; resetAt: number} {
        return {count: this.usage.count, limit: this.dailyLimit(), resetAt: this.usage.resetAt};
    }

    /** 지금 설정의 LLM 클라이언트입니다. API 키가 없거나, 한도를 다 써서 쉬는 중이면 오류를 던집니다. */
    provider(): LlmProvider {
        if (this.pause && this.paused) throw new LlmQuotaExhaustedError(this.pause.message, this.pause.until);
        const {llm} = this.deps.settings();
        const apiKey = this.deps.secrets.get(`llm:${llm.provider}`);
        if (!apiKey) throw new Error(`${PROVIDER_LABELS[llm.provider]} API 키가 설정되지 않았습니다.`);
        const model = llm.models[llm.provider];
        const key = `${llm.provider}\n${model}\n${apiKey}`;
        if (this.cached?.key !== key) {
            // 서비스나 키를 바꿨으면 이전 키의 한도와는 상관없으므로 쉬던 것을 풉니다.
            this.pause = null;
            this.cached = {key, instance: this.watchQuota(this.create(llm.provider, apiKey, model))};
        }
        return this.cached.instance;
    }

    /** 분당 요청 한도 안에서 요청 자리를 하나 받고(한도에 닿았으면 기다림), 오늘 쓴 요청 수에 셉니다. */
    async request(galleryId?: string): Promise<void> {
        if (!this.hasSlotNow()) {
            const limit = effectiveRpm(this.deps.settings().llm);
            this.deps.logger.info(`LLM 분당 요청 한도(${limit}회)에 닿아 잠시 기다립니다.`, galleryId ? {galleryId} : undefined);
        }
        await this.limiter.acquire();
        this.usage.add();
    }

    /** LLM 호출에서 한도 소진 오류가 나오면 쉬기 시작하도록 감쌉니다. */
    private watchQuota(provider: LlmProvider): LlmProvider {
        const guard = async <T>(call: () => Promise<T>): Promise<T> => {
            try {
                return await call();
            } catch (error) {
                if (error instanceof LlmQuotaExhaustedError) await this.startPause(error);
                throw error;
            }
        };
        return {
            decide: (post) => guard(() => provider.decide(post)),
            decideMany: (posts) => guard(() => provider.decideMany(posts))
        };
    }

    private async startPause(error: LlmQuotaExhaustedError): Promise<void> {
        const alreadyPaused = this.paused;
        this.pause = {until: error.until, message: error.message};
        if (alreadyPaused) return;
        const message = `${error.message} 그때까지 LLM 판단과 디시 목록 확인을 멈춥니다.`;
        this.deps.logger.warn(message);
        await this.onPause(message);
    }
}
