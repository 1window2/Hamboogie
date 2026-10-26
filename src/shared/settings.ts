import type {AccountConfig, AutoStop, DcconRef, GalleryConfig, LlmProviderId, Settings} from "./types";

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

/** 새 갤러리의 기본 우선 키워드입니다. 이 키워드가 있는 글은 본문을 먼저 읽습니다(칩의 ×로 지울 수 있음). */
export const DEFAULT_KEYWORDS = ["싸이", "싸단", "싸셋", "버거", "부기", "부거", "북이", "치킨", "피자", "나눔", "뿌림", "뿌린", "선착", "줄", "까지", "추첨"];

/** 고를 수 있는 LLM 서비스입니다. 화면에 이 순서로 보입니다. */
export const PROVIDERS: readonly LlmProviderId[] = ["gemini", "openai", "claude"];

export const DEFAULT_MODELS: Record<LlmProviderId, string> = {
    // 무료 등급 하루 한도가 넉넉해(하루 500회, 3.6 Flash는 20회) 계속 켜 두는 감시에 맞습니다. 판단은 1~3초입니다.
    gemini: "gemini-3.5-flash-lite",
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
        notifyOnSuccess: false,
        autoStop: {mode: "off", afterMinutes: AUTO_STOP_DEFAULT_MINUTES, at: AUTO_STOP_DEFAULT_AT}
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

export function normalizeGallery(saved: GalleryConfig, accounts: AccountConfig[]): GalleryConfig {
    const accountIds = new Set(accounts.map((account) => account.id));
    // 1.1.x에 있던 "골라내기" 설정은 모든 새 글을 묶어 판단하게 되면서 없어졌습니다.
    const {screenUnmatched: _removed, ...gallery} = saved as GalleryConfig & {screenUnmatched?: boolean};
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
        accountIds: [...new Set(gallery.accountIds)].filter((id) => accountIds.has(id))
    };
}

/** 계정 ID는 앱이 만든 UUID입니다. 비밀 정보 키에 쓰이므로 다른 형식은 받지 않습니다. */
/** 계정마다 정할 수 있는 기본 디시콘 수입니다. */
export const DEFAULT_DCCONS_MAX = 20;

/** 이전 버전 설정(기본 디시콘 없음)이나 잘못된 값을 걸러 냅니다. 같은 디시콘은 한 번만 둡니다. */
function normalizeDccons(dccons: DcconRef[] | undefined): DcconRef[] {
    if (!Array.isArray(dccons)) return [];
    const seen = new Set<string>();
    return dccons.filter((dccon) => {
        if (!Number.isInteger(dccon?.packageIdx) || !Number.isInteger(dccon?.detailIdx)) return false;
        const key = `${dccon.packageIdx}:${dccon.detailIdx}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, DEFAULT_DCCONS_MAX).map(({packageIdx, detailIdx, title, packageTitle}) => ({
        packageIdx, detailIdx, title: String(title ?? ""), packageTitle: String(packageTitle ?? "")
    }));
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 저장 전에 설정값을 허용 범위로 맞춥니다. */
export function normalizeSettings(settings: Settings): Settings {
    const accounts = settings.accounts
        .filter((account) => ACCOUNT_ID_PATTERN.test(account.id))
        .map((account) => ({...account, loginId: account.loginId.trim(), defaultDccons: normalizeDccons(account.defaultDccons)}));
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
        notifyOnSuccess: settings.notifyOnSuccess === true,
        autoStop: normalizeAutoStop(settings.autoStop)
    };
}

/**
 * 무료 등급에서 하루에 보낼 LLM 요청 수입니다. Gemini 3.5 Flash Lite 무료 등급의 하루 한도(500회)에서
 * 묶음 판단 뒤 2차 확인 등에 쓸 여유를 조금 남겼습니다. 1분마다 확인하면 하루 약 8시간 감시할 수 있습니다.
 */
export const FREE_DAILY_LLM_REQUESTS = 480;

/**
 * 감시 설정으로 하루에 감시할 수 있는 시간(시간 단위)을 어림합니다. 확인 한 번에 LLM 요청 한 번을 쓴다고 보고,
 * 하루 요청 수를 모든 갤러리의 시간당 확인 횟수로 나눕니다. 감시 간격이 길수록 오래 감시할 수 있습니다(반비례).
 * 새 글이 없는 확인에는 요청을 쓰지 않으므로 실제로는 이보다 길어집니다. 24시간을 넘으면 24입니다.
 */
export function estimatedWatchHours(intervalsSec: number[], dailyRequests = FREE_DAILY_LLM_REQUESTS): number {
    const checksPerHour = intervalsSec.reduce((sum, interval) => sum + 3600 / Math.max(1, interval), 0);
    if (checksPerHour === 0) return 24;
    return Math.min(24, dailyRequests / checksPerHour);
}

/** 실제로 지킬 분당 LLM 요청 수입니다. 0이면 제한하지 않습니다. */
export function effectiveRpm(llm: Settings["llm"]): number {
    return llm.paidPlan ? llm.requestsPerMinute : FREE_LLM_RPM;
}

export const AUTO_STOP_DEFAULT_MINUTES = 120;
export const AUTO_STOP_MAX_MINUTES = 24 * 60;
export const AUTO_STOP_DEFAULT_AT = "02:00";
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 이전 버전 설정(자동 중지 없음)이나 잘못된 값을 쓸 수 있는 값으로 맞춥니다. */
function normalizeAutoStop(autoStop: AutoStop | undefined): AutoStop {
    const mode = autoStop?.mode === "after" || autoStop?.mode === "at" ? autoStop.mode : "off";
    return {
        mode,
        afterMinutes: clamp(autoStop?.afterMinutes as number, 1, AUTO_STOP_MAX_MINUTES, AUTO_STOP_DEFAULT_MINUTES),
        at: typeof autoStop?.at === "string" && CLOCK_PATTERN.test(autoStop.at) ? autoStop.at : AUTO_STOP_DEFAULT_AT
    };
}

/**
 * 감시를 자동으로 멈출 시각(ms)입니다. "after"는 감시를 시작한 시각부터 세고, "at"은 지금 이후 그 시각이 처음 오는 때
 * (오늘 이미 지났으면 내일)입니다. 이 컴퓨터의 시간대를 씁니다. 꺼져 있으면 null입니다.
 */
export function nextAutoStopAt(autoStop: AutoStop, startedAt: number, now: number): number | null {
    if (autoStop.mode === "after") return startedAt + autoStop.afterMinutes * 60 * 1000;
    if (autoStop.mode !== "at" || !CLOCK_PATTERN.test(autoStop.at)) return null;
    const [hours, minutes] = autoStop.at.split(":").map(Number) as [number, number];
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
}

/** 감시를 시작하기 전에 갤러리 설정의 문제를 찾습니다. */
export function galleryProblems(gallery: GalleryConfig): string[] {
    const problems: string[] = [];
    if (!/^[A-Za-z0-9_$]+$/.test(gallery.galleryId)) problems.push("갤러리 ID가 올바르지 않습니다.");
    else if (gallery.checkedId !== gallery.galleryId) problems.push("갤러리 탭에서 갤러리 ID를 확인해야 합니다.");
    if (gallery.accountIds.length === 0) problems.push("대기 계정을 하나 이상 지정해야 합니다.");
    return problems;
}
