import type {AccountConfig, GalleryConfig, LlmProviderId, Settings} from "./types";

export const INTERVAL_MIN_SEC = 10;
export const INTERVAL_MAX_SEC = 60 * 60;
export const INTERVAL_DEFAULT_SEC = 5 * 60;
export const KEYWORD_MAX = 30;
export const DELAY_MAX_SEC = 60 * 60;
export const DEFAULT_COMMENT_TEXT = "줄";
export const BODY_READ_LIMIT_DEFAULT = 20;
/** 이보다 많이 두거나 제한을 없애면 IP 차단 경고를 빨갛게 보여줍니다. 디시가 기준을 공개하지 않아 기본값을 기준으로 삼습니다. */
export const BODY_READ_LIMIT_SAFE = 20;
export const BODY_READ_LIMIT_MAX = 1000;
/** 무료 등급(예: Gemini 무료 키)의 분당 요청 한도입니다. 유료 요금제를 쓰지 않으면 이 값을 따릅니다. */
export const FREE_LLM_RPM = 5;
export const LLM_RPM_MAX = 1000;

export const DEFAULT_KEYWORDS = ["나눔", "뿌림", "뿌린다", "뿌려", "선착", "줄", "기프티콘", "쏜다", "추첨", "드림", "드립니다", "드려요", "쏩니다", "까지"];

/** 고를 수 있는 LLM 서비스입니다. 화면에 이 순서로 보입니다. */
export const PROVIDERS: readonly LlmProviderId[] = ["gemini", "openai", "claude"];

export const DEFAULT_MODELS: Record<LlmProviderId, string> = {
    gemini: "gemini-3.6-flash",
    openai: "gpt-6-luna",
    claude: "claude-haiku-5-5"
};

export const PROVIDER_LABELS: Record<LlmProviderId, string> = {
    gemini: "Gemini",
    openai: "ChatGPT",
    claude: "Claude"
};

export function defaultSettings(): Settings {
    return {
        galleries: [],
        accounts: [],
        llm: {provider: "gemini", models: {...DEFAULT_MODELS}, paidPlan: false, requestsPerMinute: FREE_LLM_RPM},
        discordWebhookUrl: "",
        notifyOnSuccess: false
    };
}

export function newGallery(id: string): GalleryConfig {
    return {
        id,
        galleryId: "",
        isMinor: false,
        enabled: true,
        intervalSec: INTERVAL_DEFAULT_SEC,
        category: "food",
        keywords: [...DEFAULT_KEYWORDS],
        excludeKeywords: [],
        scanBody: true,
        bodyReadLimit: BODY_READ_LIMIT_DEFAULT,
        screenUnmatched: true,
        accountIds: [],
        delaySec: 0
    };
}

/** 범위 안으로 맞춥니다. 숫자가 아니면 `fallback`(없으면 최솟값)을 씁니다. 0이 "제한 없음"인 값은 꼭 기본값을 넘겨야 합니다. */
function clamp(value: number, min: number, max: number, fallback = min): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/** 키워드를 다듬고 중복을 없앤 뒤 최대 개수로 자릅니다. */
export function normalizeKeywords(keywords: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of keywords) {
        const keyword = raw.trim();
        if (!keyword || seen.has(keyword)) continue;
        seen.add(keyword);
        result.push(keyword);
        if (result.length === KEYWORD_MAX) break;
    }
    return result;
}

export function normalizeGallery(gallery: GalleryConfig, accounts: AccountConfig[]): GalleryConfig {
    const accountIds = new Set(accounts.map((account) => account.id));
    return {
        ...gallery,
        galleryId: gallery.galleryId.trim(),
        intervalSec: clamp(gallery.intervalSec, INTERVAL_MIN_SEC, INTERVAL_MAX_SEC),
        delaySec: clamp(gallery.delaySec, 0, DELAY_MAX_SEC),
        category: gallery.category === "all" ? "all" : "food",
        keywords: normalizeKeywords(gallery.keywords),
        // 이전 버전에서 저장한 설정에는 제외 키워드가 없습니다.
        excludeKeywords: normalizeKeywords(gallery.excludeKeywords ?? []),
        // 이전 버전에서 저장한 설정에는 없으므로 기본(켜짐)으로 봅니다.
        scanBody: gallery.scanBody ?? true,
        bodyReadLimit: clamp(gallery.bodyReadLimit, 0, BODY_READ_LIMIT_MAX, BODY_READ_LIMIT_DEFAULT),
        screenUnmatched: gallery.screenUnmatched ?? true,
        accountIds: [...new Set(gallery.accountIds)].filter((id) => accountIds.has(id))
    };
}

/** 계정 ID는 앱이 만든 UUID입니다. 비밀 정보 키에 쓰이므로 다른 형식은 받지 않습니다. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 저장 전에 설정값을 허용 범위로 맞춥니다. */
export function normalizeSettings(settings: Settings): Settings {
    const accounts = settings.accounts
        .filter((account) => ACCOUNT_ID_PATTERN.test(account.id))
        .map((account) => ({...account, loginId: account.loginId.trim()}));
    return {
        ...settings,
        accounts,
        galleries: settings.galleries.map((gallery) => normalizeGallery(gallery, accounts)),
        llm: {
            provider: PROVIDERS.includes(settings.llm.provider) ? settings.llm.provider : "gemini",
            // 모델 이름을 비우면 기본 모델을 씁니다. 화면에도 기본 모델이 안내 문구로 보입니다.
            models: Object.fromEntries(PROVIDERS.map((id) => [id, settings.llm.models?.[id]?.trim() || DEFAULT_MODELS[id]])) as Record<LlmProviderId, string>,
            paidPlan: settings.llm.paidPlan === true,
            requestsPerMinute: clamp(settings.llm.requestsPerMinute, 0, LLM_RPM_MAX, FREE_LLM_RPM)
        },
        discordWebhookUrl: settings.discordWebhookUrl.trim(),
        notifyOnSuccess: settings.notifyOnSuccess === true
    };
}

/** 실제로 지킬 분당 LLM 요청 수입니다. 0이면 제한하지 않습니다. */
export function effectiveRpm(llm: Settings["llm"]): number {
    return llm.paidPlan ? llm.requestsPerMinute : FREE_LLM_RPM;
}

/** 감시를 시작하기 전에 갤러리 설정의 문제를 찾습니다. */
export function galleryProblems(gallery: GalleryConfig): string[] {
    const problems: string[] = [];
    if (!/^[A-Za-z0-9_$]+$/.test(gallery.galleryId)) problems.push("갤러리 ID가 올바르지 않습니다.");
    else if (gallery.checkedId !== gallery.galleryId) problems.push("갤러리 탭에서 갤러리 ID를 확인해야 합니다.");
    if (gallery.accountIds.length === 0) problems.push("대기 계정을 하나 이상 지정해야 합니다.");
    return problems;
}
