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
    /** 대기 계정 ID 목록입니다. 앞에 있을수록 우선순위가 높습니다. */
    accountIds: string[];
    /** 나눔 글을 감지한 뒤 줄을 서기까지 기다릴 시간(초)입니다. */
    delaySec: number;
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

export interface AppState {
    settings: Settings;
    accounts: AccountView[];
    secretsSet: Partial<Record<SecretKey, boolean>>;
    running: boolean;
    /** 감시 중인 갤러리 수입니다. */
    watching: number;
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
    start(): Promise<AppState>;
    stop(): Promise<AppState>;
    testWebhook(): Promise<{ok: boolean; message: string}>;
    getLogs(): Promise<LogEntry[]>;
    onLog(listener: (entry: LogEntry) => void): () => void;
    onState(listener: (state: AppState) => void): () => void;
    /** 개발 모드 전용입니다. 배포 빌드에서는 호출하면 실패합니다. */
    devTestRun(input: DevTestInput): Promise<DevTestResult>;
}
