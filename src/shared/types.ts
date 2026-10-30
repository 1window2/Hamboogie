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

/** 디시콘 하나입니다. 디시콘 이름은 대부분 "1", "2" 같은 번호라서 패키지 번호와 디시콘 번호로 가리킵니다. */
export interface DcconRef {
    packageIdx: number;
    detailIdx: number;
    /** 화면에 보여줄 디시콘 이름과 패키지 이름입니다. */
    title: string;
    packageTitle: string;
}

/** 계정이 가진 디시콘 패키지 하나입니다. */
export interface DcconPackage {
    packageIdx: number;
    title: string;
    items: {detailIdx: number; title: string; img: string}[];
}

export interface AccountConfig {
    id: string;
    /** 디시 로그인 아이디입니다. 비밀번호는 별도의 암호화 저장소에 둡니다. */
    loginId: string;
    /** `auto`이면 로그인 응답으로 판별합니다. */
    memberTypeOverride: "auto" | MemberType;
    /**
     * 정해진 문구나 디시콘을 요구하지 않는 줄에 "줄" 대신 달 디시콘입니다. 여러 개면 무작위로 하나를 씁니다.
     * 비어 있거나, 글이 디시콘 댓글을 인정하지 않으면 "줄"을 씁니다.
     */
    defaultDccons: DcconRef[];
}

export interface LlmConfig {
    provider: LlmProviderId;
    models: Record<LlmProviderId, string>;
    /** 유료 요금제를 쓰면 분당 요청 수를 직접 정합니다. 끄면 무료 등급 한도(분당 5회)를 따릅니다. */
    paidPlan: boolean;
    /** 유료 요금제일 때 최근 1분 동안 보낼 수 있는 LLM 요청 수입니다. 0이면 제한하지 않습니다. */
    requestsPerMinute: number;
}

/**
 * 감시 자동 중지입니다. "after"는 감시를 시작하고 `afterMinutes`분 뒤, "at"은 이 컴퓨터 시간으로 `at`(HH:MM)이
 * 다음에 올 때 멈춥니다. "off"면 멈추지 않습니다.
 */
export interface AutoStop {
    mode: "off" | "after" | "at";
    afterMinutes: number;
    at: string;
}

export interface Settings {
    galleries: GalleryConfig[];
    accounts: AccountConfig[];
    llm: LlmConfig;
    discordWebhookUrl: string;
    /** 줄 서기에 성공했을 때도 Discord로 알립니다. 기본은 꺼짐(실패와 판단 불가만 알림)입니다. */
    notifyOnSuccess: boolean;
    /** 감시를 자동으로 멈추는 설정입니다. 잘 시간처럼 직접 확인할 수 없을 때 끄기 위해 씁니다. */
    autoStop: AutoStop;
}

/** 비밀 정보 종류입니다. 값은 renderer로 절대 보내지 않습니다. */
export type SecretKey = `llm:${LlmProviderId}` | `account:${string}`;

export type AccountStatus =
    | {state: "logged_out"}
    | {state: "logging_in"}
    | {state: "otp_required"; message: string}
    | {state: "logged_in"; nickname: string; memberType: MemberType | null; dcconCount: number; dcconError?: string}
    /**
     * `retryAt`이 있으면 일시적인 오류(네트워크, 서버 오류, app_id 거절)라 그 시각에 자동으로 다시 로그인합니다.
     * `failingSince`는 그렇게 실패하기 시작한 시각입니다.
     */
    | {state: "error"; message: string; retryAt?: number; failingSince?: number};

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

/** 오늘 쓴 LLM 요청 수입니다. `limit`이 0이면 제한이 없습니다(유료 요금제). */
export interface LlmUsageView {
    count: number;
    limit: number;
    resetAt: number;
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
    /** 오늘 쓴 LLM 요청 수입니다. */
    llmUsage: LlmUsageView;
    /** 감시가 자동으로 멈출 시각(ms)입니다. 감시 중이 아니거나 자동 중지가 꺼져 있으면 null입니다. */
    autoStopAt: number | null;
}

/** 줄 서기 기록 한 건입니다. */
export interface HistoryEntry {
    time: number;
    galleryId: string;
    postNo: number;
    title: string;
    outcome: "success" | "failure";
    /** 성공이면 "테스트닉 계정으로 \"줄\"" 같은 내용, 실패면 계정별 실패 사유입니다. */
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

/** main → renderer로 보내는 알림 채널과 그 값입니다. */
export interface PushEvents {
    state: AppState;
    log: LogEntry;
    history: HistoryEntry;
}

/** renderer → main 요청 채널입니다. `HamboogieApi`에서 알림을 구독하는 함수(`on...`)를 뺀 것입니다. */
export type InvokeChannel = {[K in keyof HamboogieApi]: K extends `on${string}` ? never : K}[keyof HamboogieApi];

/** renderer → main 호출 목록입니다. */
export interface HamboogieApi {
    getState(): Promise<AppState>;
    saveSettings(settings: Settings): Promise<AppState>;
    setSecret(key: SecretKey, value: string): Promise<AppState>;
    /** `otp`는 OTP 6자리입니다. 상태가 `otp_required`일 때만 넘깁니다. */
    login(accountId: string, otp?: string): Promise<AppState>;
    /** 로그인된 계정이 가진 디시콘을 패키지별로 돌려줍니다. 디시에 요청하지 않습니다. */
    getDccons(accountId: string): Promise<DcconPackage[]>;
    /** 그 계정이 가진 디시콘의 이미지를 data: 주소로 받아 옵니다(디시 이미지 서버 요청). 받지 못한 것은 빠집니다. */
    getDcconImages(accountId: string, urls: string[]): Promise<Record<string, string>>;
    /**
     * 갤러리가 실제로 있는지 확인하고 이름과 마이너 여부를 돌려줍니다. 없으면 실패합니다.
     * 그 갤러리의 대기 계정(`accountIds`) 중 로그인된 계정으로만 요청합니다.
     */
    checkGallery(galleryId: string, accountIds: string[]): Promise<GalleryCheckResult>;
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
    /** 개발 모드 전용입니다. 테스트 갤러리 1번 글에서 실제 디시 API를 차례로 점검하고, 단 댓글은 지웁니다. */
    devApiCheck(): Promise<DevApiCheckStep[]>;
}

/** 실제 디시 API 점검의 한 단계 결과입니다. */
export interface DevApiCheckStep {
    name: string;
    ok: boolean;
    detail: string;
    elapsedMs: number;
}
