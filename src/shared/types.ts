// main, preload, renderer가 함께 쓰는 타입입니다.

export type LlmProviderId = "gemini" | "openai" | "claude";

/** 나눔 종류 필터입니다. */
export type GiveawayCategory = "food" | "all";

/** 로그인한 계정의 종류입니다. 로그인하면 유동이 아니므로 고닉/반고닉 둘 중 하나입니다. */
export type MemberType = "gonick" | "semi";

export interface GalleryConfig {
    id: string;
    /** URL상의 갤러리 ID입니다. 예: `gf2` */
    galleryId: string;
    /** 마이너 갤러리 여부입니다. 앱 API는 ID만으로 구분하지만 화면 표시와 링크에 씁니다. */
    isMinor: boolean;
    enabled: boolean;
    /** 감시 간격(초)입니다. */
    intervalSec: number;
    category: GiveawayCategory;
    /** 제목 키워드입니다. 비어 있으면 모든 새 글을 LLM으로 보냅니다. */
    keywords: string[];
    /** 제외 키워드입니다. 제목이나 본문에 하나라도 있으면 LLM 판단 없이 넘깁니다. */
    excludeKeywords: string[];
    /**
     * 새 글마다 본문을 읽어 제목과 본문을 합쳐 키워드를 확인합니다. 제목에 티를 안 내는 나눔 글도 잡지만,
     * 새 글마다 디시 요청이 하나씩 늘어납니다. 끄면 제목에 키워드가 있는 글만 엽니다.
     */
    scanBody: boolean;
    /**
     * 한 번 확인할 때 본문을 열어 볼 글 수의 상한입니다. 제목에 키워드가 없는 글에만 적용하며, 넘는 글은 제목으로만 판단합니다.
     * 0이면 제한하지 않습니다.
     */
    bodyReadLimit: number;
    /** 키워드에 걸리지 않은 새 글을 한 번에 묶어 LLM에 보내, 나눔 글로 보이는 것을 골라냅니다. */
    screenUnmatched: boolean;
    /** 대기 계정 ID 목록입니다. 앞에 있을수록 우선순위가 높습니다. */
    accountIds: string[];
    /** 나눔 글을 감지한 뒤 줄을 서기까지 기다릴 시간(초)입니다. */
    delaySec: number;
    /** 실제로 있는 갤러리인지 확인한 ID입니다. `galleryId`와 다르면 다시 확인해야 감시할 수 있습니다. */
    checkedId?: string;
    /** 확인할 때 받은 갤러리 이름입니다. */
    title?: string;
}

export interface GalleryCheckResult {
    title: string;
    isMinor: boolean;
}

export interface AccountConfig {
    id: string;
    /** 디시 로그인 아이디입니다. 비밀번호는 별도의 암호화 저장소에 둡니다. */
    loginId: string;
    /** `auto`이면 로그인 응답으로 판별합니다. */
    memberTypeOverride: "auto" | MemberType;
}

export interface LlmConfig {
    provider: LlmProviderId;
    models: Record<LlmProviderId, string>;
    /** 최근 1분 동안 보낼 수 있는 LLM 요청 수입니다. 넘으면 묶어 보내거나 기다립니다. 0이면 제한하지 않습니다. */
    requestsPerMinute: number;
}

export interface Settings {
    galleries: GalleryConfig[];
    accounts: AccountConfig[];
    llm: LlmConfig;
    discordWebhookUrl: string;
    /** 줄 서기에 성공했을 때도 Discord로 알립니다. 기본은 꺼짐(실패와 판단 불가만 알림)입니다. */
    notifyOnSuccess: boolean;
}

/** 비밀 정보 종류입니다. 값은 renderer로 절대 보내지 않습니다. */
export type SecretKey = `llm:${LlmProviderId}` | `account:${string}`;

export type AccountStatus =
    | {state: "logged_out"}
    | {state: "logging_in"}
    | {state: "otp_required"; message: string}
    | {state: "logged_in"; nickname: string; memberType: MemberType | null; dcconCount: number; dcconError?: string}
    | {state: "error"; message: string};

export interface AccountView extends AccountConfig {
    hasPassword: boolean;
    status: AccountStatus;
}

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
    time: number;
    level: LogLevel;
    message: string;
    galleryId?: string;
    postNo?: number;
}

/** 새 버전 상태입니다. Windows는 받아서 설치하고, macOS는 다운로드 페이지만 알려줍니다. */
export type UpdateState =
    | {state: "idle"}
    | {state: "downloading"; version: string; percent: number}
    | {state: "ready"; version: string}
    | {state: "available"; version: string; url: string}
    | {state: "error"; message: string};

/** 갤러리별 감시 상태입니다. */
export interface GalleryStatus {
    lastCheckedAt: number;
    /** 마지막 확인에서 찾은 새 글 수입니다. */
    newPosts: number;
    /** 마지막 확인에서 키워드에 걸린 글 수입니다. */
    matched: number;
}

export interface AppState {
    settings: Settings;
    accounts: AccountView[];
    secretsSet: Partial<Record<SecretKey, boolean>>;
    running: boolean;
    /** 감시 중인 갤러리 수입니다. */
    watching: number;
    /** 갤러리 설정 항목 id별 감시 상태입니다. */
    galleryStatus: Record<string, GalleryStatus>;
    version: string;
    update: UpdateState;
    /** 개발 모드 오프라인(가짜 디시)으로 실행 중인지입니다. */
    offline: boolean;
}

/** 줄 서기 기록 한 건입니다. */
export interface HistoryEntry {
    time: number;
    galleryId: string;
    postNo: number;
    title: string;
    outcome: "success" | "failure";
    /** 성공이면 "너구리국밥 계정으로 \"줄\"" 같은 내용, 실패면 계정별 실패 사유입니다. */
    detail: string;
    /** 개발 모드 가짜 글 테스트로 남은 기록입니다. */
    test?: boolean;
}

/** 개발 모드 전용 테스트 실행 입력입니다. */
export interface DevTestInput {
    title: string;
    body: string;
    /** false면 판단만 하고 댓글이나 알림은 보내지 않습니다. */
    act: boolean;
}

export interface DevTestResult {
    /** LLM 판단에 걸린 시간(ms)입니다. */
    elapsedMs: number;
    /** LLM 판단 원문입니다. 분석이 실패하면 null입니다. */
    decision: Record<string, unknown> | null;
    plan:
        | {kind: "skip" | "notify"; reason: string}
        | {kind: "comment"; waitSec: number; attempts: {account: string; content: string}[]};
}

/** renderer → main 호출 목록입니다. */
export interface HamboogieApi {
    getState(): Promise<AppState>;
    saveSettings(settings: Settings): Promise<AppState>;
    setSecret(key: SecretKey, value: string): Promise<AppState>;
    /** `otp`는 OTP 6자리입니다. 상태가 `otp_required`일 때만 넘깁니다. */
    login(accountId: string, otp?: string): Promise<AppState>;
    /** 갤러리가 실제로 있는지 확인하고 이름과 마이너 여부를 돌려줍니다. 없으면 실패합니다. */
    checkGallery(galleryId: string): Promise<GalleryCheckResult>;
    start(): Promise<AppState>;
    stop(): Promise<AppState>;
    testWebhook(): Promise<{ok: boolean; message: string}>;
    getLogs(): Promise<LogEntry[]>;
    getHistory(): Promise<HistoryEntry[]>;
    /** 받아 둔 업데이트를 설치하고 다시 켭니다(Windows). */
    installUpdate(): Promise<void>;
    onHistory(listener: (entry: HistoryEntry) => void): () => void;
    onLog(listener: (entry: LogEntry) => void): () => void;
    onState(listener: (state: AppState) => void): () => void;
    /** 개발 모드 전용입니다. 배포 빌드에서는 호출하면 실패합니다. */
    devTestRun(input: DevTestInput): Promise<DevTestResult>;
    /** 개발 모드 전용입니다. 목록을 한 번 읽어 앞쪽 글들의 원본 필드를 돌려줍니다. */
    devListSample(gallery: string, thumbnail: boolean): Promise<Record<string, unknown>[]>;
}
