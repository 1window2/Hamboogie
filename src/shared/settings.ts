import type {AccountConfig, GalleryConfig, LlmProviderId, Settings} from "./types";

export const INTERVAL_MIN_SEC = 10;
export const INTERVAL_MAX_SEC = 60 * 60;
export const INTERVAL_DEFAULT_SEC = 5 * 60;
export const KEYWORD_MAX = 30;
export const DELAY_MAX_SEC = 60 * 60;
export const DEFAULT_COMMENT_TEXT = "줄";

export const DEFAULT_KEYWORDS = ["나눔", "뿌림", "뿌린다", "뿌려", "선착", "줄", "기프티콘", "쏜다", "추첨"];

export const DEFAULT_MODELS: Record<LlmProviderId, string> = {
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
        llm: {provider: "gemini", models: {...DEFAULT_MODELS}},
        discordWebhookUrl: ""
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
        accountIds: [],
        delaySec: 0
    };
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
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
        accountIds: [...new Set(gallery.accountIds)].filter((id) => accountIds.has(id))
    };
}

/** 저장 전에 설정값을 허용 범위로 맞춥니다. */
export function normalizeSettings(settings: Settings): Settings {
    const accounts = settings.accounts.map((account) => ({...account, loginId: account.loginId.trim()}));
    return {
        ...settings,
        accounts,
        galleries: settings.galleries.map((gallery) => normalizeGallery(gallery, accounts)),
        llm: {
            provider: settings.llm.provider,
            models: {...DEFAULT_MODELS, ...settings.llm.models}
        },
        discordWebhookUrl: settings.discordWebhookUrl.trim()
    };
}

/** 감시를 시작하기 전에 갤러리 설정의 문제를 찾습니다. */
export function galleryProblems(gallery: GalleryConfig): string[] {
    const problems: string[] = [];
    if (!/^[A-Za-z0-9_$]+$/.test(gallery.galleryId)) problems.push("갤러리 ID가 올바르지 않습니다.");
    if (gallery.accountIds.length === 0) problems.push("대기 계정을 하나 이상 지정해야 합니다.");
    return problems;
}
