import type {DCInside, PostItem} from "@green-1052/dcinside.js";
import {errorMessage} from "@shared/errors";
import {FREE_DAILY_LLM_REQUESTS, galleryProblems, nextAutoStopAt} from "@shared/settings";
import type {GalleryConfig, GalleryStatus, HistoryEntry, Settings} from "@shared/types";
import {isAppIdFailure, isCaptchaFailure, isDefiniteCommentFailure, isLoginExpired, type AccountManager} from "../dc/accounts";
import type {AppIdBackoff} from "../dc/app-id-backoff";
import {isOutdatedAppError, OUTDATED_APP_MESSAGE, OUTDATED_PAUSE_MS} from "../dc/app-version";
import {htmlToText} from "../dc/text";
import {buildBatchMessage, buildUserMessage, type Decision} from "../llm/decision";
import {LlmGate} from "../llm/gate";
import type {LlmProvider, PostInput} from "../llm/providers";
import type {LlmUsage} from "../llm/usage";
import type {Logger} from "../logger";
import {sendDiscordNotice} from "../notify/discord";
import type {Ledger, SecretStore} from "../store";
import {AutoStopTimer, clockText} from "./auto-stop";
import {findKeyword, matchesKeywords} from "./keyword-filter";
import {postedAtRange} from "./post-time";
import {eligible, END_MARGIN_MS, makePlan, type Plan} from "./planner";

/** 한 번 확인할 때 최대로 넘겨볼 목록 페이지 수입니다. */
const MAX_PAGES_PER_TICK = 3;

/** LLM 요청 한 번에 묶어 보낼 최대 글 수입니다. 40개까지 묶어도 판단이 거의 흔들리지 않는 것을 확인했습니다. */
const MAX_BATCH_POSTS = 40;

/** 본문을 연달아 읽을 때 사이에 둘 간격입니다. 새 글이 많을 때 요청이 한꺼번에 몰리지 않게 합니다. */
const BODY_READ_GAP_MS = 500;
/** 올라온 지 이보다 오래된 글에는 자동으로 줄 서지 않습니다. 오래 쉬었다가 다시 확인할 때 지난 나눔에 줄 서지 않기 위해서입니다. */
const STALE_POST_MS = 60 * 60 * 1000;
/** 깨어난 뒤 네트워크가 다시 붙기를 처음 기다리는 시간입니다. */
const WAKE_SETTLE_MS = 10 * 1000;
/** 깨어난 뒤 이 시간 안에 네트워크가 붙지 않으면 감시를 멈춥니다. */
const WAKE_NETWORK_LIMIT_MS = 60 * 1000;
/** 네트워크가 붙었는지 다시 확인하는 간격입니다. */
const WAKE_NETWORK_RETRY_MS = 5 * 1000;
/** 이보다 오래 잠들었으면 그사이 글은 버리고 기준 글을 새로 잡습니다. */
const LONG_SLEEP_MS = 5 * 60 * 1000;
/** 일시적인 오류로 자동 재로그인을 기다리는 동안 "로그인 필요"를 알리지 않고 기다리는 시간입니다. */
const LOGIN_RECOVERY_QUIET_MS = 10 * 60 * 1000;
/** 목록 확인이 연달아 실패할 때 다음 확인까지 기다리는 최대 시간입니다. */
const FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** 목록 확인이 이만큼 연달아 실패하면 Discord로 한 번 알립니다. */
const FAILURE_ALERT_AFTER = 5;
/** 확인 한 번에 본문 읽기가 이만큼 실패하면 남은 글은 다음 확인 때 다시 읽습니다. */
const READ_FAILURES_PER_TICK = 2;

export interface NewPost {
    no: number;
    title: string;
    /** 목록에 나온 작성 시각 문자열(한국 시간)입니다. */
    dateTime?: string;
}

export interface Analysis {
    /** LLM 판단입니다. 분석이 실패하면 null입니다. */
    decision: Decision | null;
    plan: Plan;
}

type CommentPlan = Extract<Plan, {kind: "comment"}>;

/** LLM으로 판단할 글입니다. 본문을 읽지 않았으면 body가 비어 있습니다. */
interface Candidate {
    post: NewPost;
    title: string;
    body: string;
    /** 본문을 실제로 읽었는지입니다. 읽지 않은 글은 본문의 조건(봇 색출 등)을 확인할 수 없어 자동으로 줄 서지 않습니다. */
    bodyRead: boolean;
    /** 제목이나 본문에 키워드가 있는 글입니다. 판단에 실패하면 이런 글만 알립니다. */
    keyword: boolean;
    detectedAt: number;
    /** 글을 올린 시각 추정값입니다. 확실하지 않으면 늦은 쪽(감지한 시각)으로 잡습니다. */
    postedAt: number;
    /** 작성 시각 추정값이 실제보다 늦을 수 있는 최대 시간입니다. 마감을 이만큼 앞당겨 봅니다. */
    postedSlackMs: number;
    /** 본문에 나온 작성 시각 문자열입니다. */
    dateTime?: string;
}

export interface EngineDeps {
    /**
     * 이 갤러리의 글을 읽을 클라이언트입니다. 그 갤러리의 대기 계정 중 로그인된 첫 계정의 것만 씁니다.
     * 갤러리마다 쓰는 계정을 나누기 위해서이고(예: 테스트용 계정만 쓰는 갤러리), 로그인된 대기 계정이 없으면 null이라
     * 디시에 요청하지 않습니다. 로그인하지 않은 채 요청을 쌓으면 비정상 접근으로 보일 수 있어서입니다.
     */
    reader(gallery: GalleryConfig): DCInside | null;
    /** app_id 거절이 오래 이어질 때 이 갤러리의 글을 읽는 계정의 기기 정보를 새로 받습니다. */
    resetReader(gallery: GalleryConfig): Promise<void>;
    /**
     * 글을 읽던 클라이언트의 로그인이 풀려 라이브러리의 자동 재로그인도 실패했을 때 부릅니다.
     * 다시 로그인했으면 "recovered", 일시적인 오류로 다시 로그인하지 못해 자동으로 또 시도할 예정이면 "retrying",
     * 그 계정을 내려놓았으면 "expired",
     * 로그인하지 않은 읽기용 클라이언트라 할 일이 없으면 "none"입니다.
     */
    onReaderLoginExpired(client: DCInside, reason: string): Promise<"recovered" | "retrying" | "expired" | "none">;
    /** app_id 발급 거절 대기 규칙입니다. 거절은 IP 단위라 계정들과 함께 씁니다. */
    appId: AppIdBackoff;
    accounts: AccountManager;
    ledger: Ledger;
    history: {add(entry: HistoryEntry): void};
    secrets: SecretStore;
    logger: Logger;
    settings(): Settings;
    /** 계정 상태나 감시 상태가 바뀌었을 때 화면을 갱신합니다. */
    onStateChanged?(): void;
    /** 오늘 보낸 LLM 요청 수입니다(무료 등급 하루 한도). 없으면 앱을 켜 둔 동안만 셉니다. */
    usage?: LlmUsage;
    /** 나눔으로 판단된 글이 있는 묶음과 2차 확인에서 LLM에 보낸 내용과 판단 원문을 남깁니다(나중에 되짚기 위해). */
    recordJudgment?(record: JudgmentRecord): void;
    /** 테스트에서 시각을 바꿀 수 있게 합니다. */
    now?(): number;
    /** 인터넷에 실제로 연결돼 있는지 확인합니다. 잠자기에서 깨어난 뒤 확인을 이어가도 되는지 볼 때 씁니다. */
    checkNetwork?(): Promise<boolean>;
    /** 컴퓨터 알림을 띄웁니다. 네트워크가 없어 Discord로 알릴 수 없을 때 씁니다. */
    desktopNotice?(title: string, body: string): void;
    /** 테스트에서 기다리는 시간을 줄일 수 있게 합니다. */
    sleep?(ms: number): Promise<void>;
}

/** LLM에 보낸 내용과 판단 원문 기록입니다. */
export interface JudgmentRecord {
    time: number;
    galleryId: string;
    /** "batch"는 여러 글 묶음 판단(또는 글 하나 판단), "confirm"은 2차 확인입니다. */
    kind: "batch" | "confirm";
    /** 쓴 LLM 서비스와 모델입니다. */
    model: string;
    /** 시스템 지시문의 이름입니다. 지시문 원문은 코드(src/main/llm/decision.ts)에 있습니다. */
    systemPrompt: "SYSTEM_PROMPT" | "BATCH_SYSTEM_PROMPT";
    /** LLM에 보낸 사용자 메시지 원문입니다. */
    message: string;
    /** 글마다 감지한 시각, 추정한 작성 시각(ms), 디시가 준 작성 시각 문자열(없으면 null)도 함께 남깁니다. */
    posts: {no: number; title: string; bodyRead: boolean; keyword: boolean; detectedAt: number; postedAt: number; dateTime: string | null}[];
    /** 글마다 LLM이 돌려준 판단입니다(posts와 같은 순서, 빠진 글은 null). */
    decisions: (Decision | null)[];
}

/** LLM 판단을 로그에 남길 짧은 문장으로 줄입니다. */
function describeDecision(decision: Decision): string {
    const parts = [
        decision.is_food ? "음식" : "음식 아님",
        decision.line_method === "text" ? `텍스트 댓글${decision.line_text ? ` "${decision.line_text}"` : ""}` : decision.line_method === "dccon" ? `디시콘 "${decision.dccon_keyword ?? ""}"` : "방법 불분명",
        decision.member_requirement !== "any" ? `자격 ${decision.member_requirement}` : null,
        decision.starts_at ? `시작 ${decision.starts_at}` : null,
        decision.ends_at ? `마감 ${decision.ends_at}` : null,
        decision.needs_extra_action ? "댓글 외 행동 필요" : null
    ];
    return parts.filter(Boolean).join(", ");
}

/** 로그인된 계정이 없어 디시에 요청하지 않았다는 오류입니다. 읽던 글은 다음 확인 때 다시 봅니다. */
class NotLoggedInError extends Error {
    constructor() {
        super("로그인된 계정이 없어 디시에 요청하지 않았습니다.");
    }
}

/** 감시로 찾은 글의 줄 서기입니다. 개발 모드 테스트(`live`가 없음)와 구분합니다. */
interface Live {
    /** 예약할 때의 세대입니다. 사용자가 감시를 멈추면 세대가 바뀌어, 그 전에 시작한 일은 댓글을 달지 않습니다. */
    epoch: number;
}

function postUrl(galleryId: string, postNo: number): string {
    return `https://m.dcinside.com/board/${galleryId}/${postNo}`;
}


/** 갤러리 감시, 글 분석, 줄 서기를 실행합니다. */
export class Engine {
    private readonly watchers = new Map<string, ReturnType<typeof setTimeout>>();
    /** 예약된 줄 서기입니다. */
    private readonly scheduled = new Map<ReturnType<typeof setTimeout>, {gallery: GalleryConfig; post: NewPost; test: boolean}>();
    /** 마지막으로 처리한 글 번호입니다. 갤러리 설정 항목과 갤러리 ID를 함께 키로 써서, ID를 바꾸면 기준을 새로 잡습니다. */
    private readonly lastSeen = new Map<string, number>();
    /** 감시 타이머 세대입니다. 시작/멈춤마다 바뀝니다. */
    private runId = 0;
    /** 줄 서기 세대입니다. 사용자가 감시를 멈출 때만 바뀌고, 감시를 다시 시작할 때는 예약을 유지합니다. */
    private epoch = 0;
    /** 갤러리 설정 항목 id별 마지막 확인 결과입니다. */
    private readonly statuses = new Map<string, GalleryStatus>();
    /** LLM 요청 창구입니다(클라이언트, 분당·하루 한도, 한도 소진 시 쉬기). */
    private readonly llm: LlmGate;
    /** 개발 모드 테스트용입니다. 켜 두면 감시로 찾은 글에 처음 줄을 서는 데 성공하는 즉시 감시를 멈춥니다. */
    stopAfterFirstSuccess = false;
    /** 무료 등급 하루 LLM 요청 수를 다 써서 감시를 쉰다고 이미 알렸는지입니다. */
    private dailyLimitWarned = false;
    /** 다음 본문을 읽어도 되는 시각입니다. 갤러리 여러 개가 함께 읽어도 간격을 지킵니다. */
    private nextReadAt = 0;
    private readonly readGapMs = BODY_READ_GAP_MS;
    /** 앱 버전이 낮아 접속이 거절됐다고 이미 알렸는지입니다. */
    private outdatedNotified = false;
    /** 로그인된 계정이 없어 감시를 쉰다고 이미 알렸는지입니다. 로그인되면 다시 알릴 수 있게 됩니다. */
    private readonly notLoggedInWarned = new Set<string>();
    /** 갤러리 설정 항목 id별로 목록 확인이 연달아 실패한 횟수입니다. 실패가 이어지면 다음 확인을 늦춥니다. */
    private readonly listFailures = new Map<string, number>();
    /** app_id 거절로 확인을 쉰다고 이미 로그에 남겼는지입니다. */
    private appIdPauseLogged = false;
    /**
     * 읽기 요청이 실패했을 때 그 요청을 보낸 클라이언트입니다. 여러 갤러리를 함께 확인하면 요청이 섞이므로,
     * 로그인 만료를 처리할 때 "마지막으로 읽은 클라이언트"가 아니라 실패한 요청의 클라이언트를 씁니다.
     */
    private readonly failedReaders = new WeakMap<object, DCInside>();
    /** 진행 중인 LLM 판단입니다. 목록 확인이 판단을 기다리지 않도록 따로 돌립니다. */
    private readonly inflight = new Set<Promise<void>>();
    /** 감시를 시작한 시각입니다. 감시 중에 다시 시작해도 바뀌지 않아 "N분 후" 자동 중지가 처음 시작한 때부터 셉니다. */
    private startedAt: number | null = null;
    /** 설정한 시각에 감시를 멈추는 타이머입니다. */
    private readonly autoStop: AutoStopTimer;
    private readonly now: () => number;
    /**
     * 컴퓨터가 잠들어 있거나, 깨어나서 네트워크를 기다리는 중입니다. 이동안에는 확인을 멈추고 디시·LLM에 요청하지 않습니다.
     * `since`는 잠든 시각, `awake`는 확인을 이어가도 될 때(또는 감시를 멈췄을 때) 풀리는 약속입니다.
     */
    private asleep: {since: number; awake: Promise<void>; release: () => void} | null = null;
    /** 마지막으로 잠들었던 구간입니다. 그 구간에 걸친 LLM 판단이 실패하면 알리지 않습니다. */
    private lastSleep: {from: number; to: number} | null = null;

    constructor(private readonly deps: EngineDeps) {
        this.llm = new LlmGate(deps, (message) => this.alert("LLM 요청 한도 소진", message));
        this.now = deps.now ?? Date.now;
        this.autoStop = new AutoStopTimer(this.now, () => void this.stopAutomatically());
    }

    get running(): boolean {
        return this.watchers.size > 0;
    }

    get watching(): number {
        return this.watchers.size;
    }

    /** 갤러리별 마지막 확인 시각과 결과입니다. */
    galleryStatus(): Record<string, GalleryStatus> {
        return Object.fromEntries(this.statuses);
    }

    /**
     * 감시를 (다시) 시작합니다. 예약해 둔 줄 서기와, 계속 감시하는 갤러리의 기준 글은 그대로 둡니다.
     * 그래서 감시 중에 다시 시작해도 그사이 올라온 글을 건너뛰지 않습니다. 시작할 수 없는 갤러리는 로그에 이유를 남기고 건너뜁니다.
     */
    start(): void {
        // 감시가 모두 멈춰 있었다면(갤러리를 꺼서 감시가 0개가 된 경우 포함) 자동 중지 시간을 지금부터 셉니다.
        const wasRunning = this.running;
        this.haltWatchers(false);
        const keys = new Set(this.deps.settings().galleries.map((gallery) => this.seenKey(gallery)));
        for (const key of this.lastSeen.keys()) if (!keys.has(key)) this.lastSeen.delete(key);
        const runId = this.runId;
        const {logger} = this.deps;
        for (const gallery of this.deps.settings().galleries) {
            if (!gallery.enabled) continue;
            const problems = galleryProblems(gallery);
            if (problems.length > 0) {
                logger.warn(`감시하지 않음: ${problems.join(" ")}`, {galleryId: gallery.galleryId || "(이름 없음)"});
                continue;
            }
            this.schedule(gallery.id, runId, 0);
            if (this.deps.accounts.candidates(this.deps.settings().accounts, gallery.accountIds).length === 0) {
                logger.warn("로그인된 대기 계정이 없습니다. 이대로면 나눔 글을 찾아도 줄을 설 수 없습니다.", {galleryId: gallery.galleryId});
            }
        }
        if (this.watchers.size === 0) {
            logger.warn("감시할 수 있는 갤러리가 없습니다.");
            this.startedAt = null;
        } else {
            logger.info(`갤러리 ${this.watchers.size}개 감시를 시작합니다.`);
            if (!wasRunning || this.startedAt === null) this.startedAt = this.now();
        }
        this.refreshAutoStop(true);
    }

    /** 컴퓨터가 잠들 때 부릅니다. 깨어날 때까지 확인을 멈춥니다(반쯤 깨어난 짧은 순간에도 요청하지 않습니다). */
    suspend(at = this.now()): void {
        if (!this.running || this.asleep) return;
        let release = () => {};
        const awake = new Promise<void>((resolve) => (release = resolve));
        this.asleep = {since: at, awake, release};
        this.deps.logger.info("컴퓨터가 잠들어 감시를 멈춥니다. 깨어나면 네트워크를 확인하고 이어갑니다.");
    }

    /**
     * 컴퓨터가 깨어날 때 부릅니다. 10초 기다린 뒤 네트워크가 실제로 붙었는지 보고, 붙었으면 확인을 이어갑니다.
     * 5분 넘게 잠들었으면 그사이 글은 버리고 기준 글을 새로 잡습니다. 1분이 지나도 네트워크가 없으면 감시를 멈추고 알립니다.
     */
    async resume(): Promise<void> {
        const sleeping = this.asleep;
        if (!sleeping) return;
        const wokeAt = this.now();
        const slept = wokeAt - sleeping.since;
        this.lastSleep = {from: sleeping.since, to: wokeAt};
        const {logger} = this.deps;
        const wait = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        logger.info(`컴퓨터가 깨어났습니다(${Math.round(slept / 60000)}분 잠듦). 네트워크가 붙기를 기다립니다.`);
        await wait(WAKE_SETTLE_MS);
        let online = false;
        while (this.asleep === sleeping) {
            online = await (this.deps.checkNetwork?.() ?? Promise.resolve(true)).catch(() => false);
            if (online || this.now() - wokeAt >= WAKE_NETWORK_LIMIT_MS) break;
            await wait(WAKE_NETWORK_RETRY_MS);
        }
        // 기다리는 사이 사용자가 감시를 멈췄으면 할 일이 없습니다.
        if (this.asleep !== sleeping) return;
        if (!online) {
            const message = "컴퓨터가 깨어난 뒤 1분이 지나도 인터넷에 연결되지 않아 감시를 멈췄습니다. 네트워크를 확인하고 감시를 다시 시작하세요.";
            logger.warn(message);
            this.deps.desktopNotice?.("Hamboogie 감시 중지", message);
            this.stop();
            this.deps.onStateChanged?.();
            return;
        }
        if (slept > LONG_SLEEP_MS) {
            // 잠든 사이 올라온 글은 버립니다. 다음 확인에서 지금의 최신 글을 기준으로 다시 잡습니다.
            this.lastSeen.clear();
            logger.info(`${Math.round(slept / 60000)}분 동안 잠들어 있었으므로 그사이 글은 건너뛰고 기준 글을 새로 잡습니다.`);
        }
        logger.info("네트워크가 연결되어 감시를 이어갑니다.");
        this.asleep = null;
        sleeping.release();
        for (const configId of this.watchers.keys()) this.schedule(configId, this.runId, 0);
    }

    /** 이 시각에 시작한 일이 잠자기 구간에 걸쳐 있었는지입니다. */
    private sleptSince(startedAt: number): boolean {
        return this.asleep !== null || (this.lastSleep !== null && startedAt <= this.lastSleep.to);
    }

    /** 자동으로 멈출 시각(ms)입니다. 감시 중이 아니거나 자동 중지가 꺼져 있으면 null입니다. */
    get autoStopAt(): number | null {
        return this.autoStop.at;
    }

    /**
     * 자동 중지 설정에 맞춰 멈출 시각을 다시 잡습니다. 감시를 시작할 때와 설정을 저장할 때 부릅니다.
     * @param announce 멈출 시각을 로그에 남깁니다. 설정을 저장했을 때는 시각이 바뀐 경우에만 남깁니다.
     */
    refreshAutoStop(announce = false): void {
        const previous = this.autoStop.at;
        const at = this.startedAt !== null && this.running ? nextAutoStopAt(this.deps.settings().autoStop, this.startedAt, this.now()) : null;
        this.autoStop.set(at);
        if (at === null) {
            if (previous !== null && this.running) this.deps.logger.info("감시 자동 중지를 껐습니다.");
        } else if (announce || at !== previous) {
            this.deps.logger.info(`${clockText(at, this.now())}에 감시를 자동으로 멈춥니다.`);
        }
    }

    private async stopAutomatically(): Promise<void> {
        if (!this.running) return;
        this.deps.logger.info("설정한 시각이 되어 감시를 자동으로 멈춥니다.");
        this.stop();
        this.deps.onStateChanged?.();
        if (this.deps.settings().discordWebhookUrl) await this.alert("감시 자동 중지", "설정한 시각이 되어 감시를 멈췄습니다.");
    }

    /** 감시를 멈추고 예약해 둔 줄 서기도 취소합니다. 분석 중이던 글에도 댓글을 달지 않습니다. */
    stop(): void {
        const wasRunning = this.watchers.size > 0;
        // 잠자기에서 깨어나 네트워크를 기다리던 중이면 기다림을 끝냅니다.
        const sleeping = this.asleep;
        this.asleep = null;
        sleeping?.release();
        this.haltWatchers(true);
        this.epoch++;
        for (const [timer, pending] of this.scheduled) {
            clearTimeout(timer);
            this.deps.logger.warn("감시를 멈춰 예약된 줄 서기를 취소했습니다.", {galleryId: pending.gallery.galleryId, postNo: pending.post.no});
            this.record(pending.gallery, pending.post, "failure", "감시를 멈춰 예약된 줄 서기를 취소함", pending.test);
        }
        this.scheduled.clear();
        this.startedAt = null;
        this.autoStop.clear();
        if (wasRunning) this.deps.logger.info("감시를 멈췄습니다.");
    }

    /** @param forget 기준 글까지 잊습니다. 사용자가 감시를 멈출 때만 씁니다. */
    private haltWatchers(forget: boolean): void {
        this.runId++;
        for (const timer of this.watchers.values()) clearTimeout(timer);
        this.watchers.clear();
        this.statuses.clear();
        if (forget) this.lastSeen.clear();
    }

    /** 진행 중인 LLM 판단이 모두 끝날 때까지 기다립니다. */
    async idle(): Promise<void> {
        while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    }

    private track(work: Promise<void>): void {
        const tracked = work.catch((error) => this.deps.logger.error(`글 판단 중 오류: ${errorMessage(error)}`)).finally(() => this.inflight.delete(tracked));
        this.inflight.add(tracked);
    }

    /** 글을 읽을 클라이언트입니다. 로그인이 풀렸을 때 어느 계정인지 알 수 있게 마지막으로 쓴 것을 기억합니다. */
    /** 그 갤러리의 대기 계정으로 읽기 요청을 보냅니다. 실패하면 어느 클라이언트의 요청이었는지 기억해 둡니다. */
    private async read<T>(gallery: GalleryConfig, request: (client: DCInside) => Promise<T>): Promise<T> {
        const client = this.deps.reader(gallery);
        if (!client) throw new NotLoggedInError();
        try {
            return await request(client);
        } catch (error) {
            if (typeof error === "object" && error !== null) this.failedReaders.set(error, client);
            throw error;
        }
    }

    private schedule(configId: string, runId: number, delayMs: number): void {
        const timer = setTimeout(() => void this.tick(configId, runId), delayMs);
        this.watchers.set(configId, timer);
    }

    private gallery(configId: string): GalleryConfig | undefined {
        return this.deps.settings().galleries.find((item) => item.id === configId);
    }

    private async tick(configId: string, runId: number): Promise<void> {
        const gallery = this.gallery(configId);
        if (!gallery || !gallery.enabled || runId !== this.runId) {
            if (runId === this.runId) this.watchers.delete(configId);
            return;
        }
        // 잠들어 있거나 깨어나서 네트워크를 기다리는 중이면 확인하지 않습니다. 깨어나 네트워크가 붙으면 다시 예약합니다.
        if (this.asleep) return;
        // 감시 중에 갤러리 ID를 바꿨는데 아직 확인하지 않았으면 그 갤러리 감시를 멈춥니다.
        const problems = galleryProblems(gallery);
        if (problems.length > 0) {
            this.deps.logger.warn(`감시를 멈춤: ${problems.join(" ")}`, {galleryId: gallery.galleryId || "(이름 없음)"});
            this.watchers.delete(configId);
            this.deps.onStateChanged?.();
            return;
        }
        let delayMs: number | null = null;
        try {
            if (await this.deps.accounts.maintain(this.deps.settings().accounts)) this.deps.onStateChanged?.();
            // 로그인된 계정이 없으면 디시에 요청하지 않습니다. 로그인이 풀린 채 요청을 쌓지 않기 위해서입니다.
            if (!this.deps.reader(gallery)) {
                // 앱을 켠 직후처럼 대기 계정이 아직 로그인하는 중이거나, 잠자기에서 깨어난 직후처럼 일시적인 오류로 자동 재로그인을
                // 기다리는 중이면(10분까지) 알리지 않고 다음 확인을 기다립니다. 그보다 오래 실패하면 감시가 멈춰 있다고 알립니다.
                if (!gallery.accountIds.some((id) => this.recoveringLogin(id))) await this.warnNotLoggedIn(gallery);
            // 무료 등급 하루 LLM 요청 수를 다 썼으면 판단할 수 없으므로 디시에도 요청하지 않고 초기화될 때까지 쉽니다.
            // 다시 확인할 때 그동안 쌓인 옛 글을 판단하지 않도록 기준 글을 새로 잡습니다.
            } else if (!this.llm.canUseToday()) {
                this.lastSeen.delete(this.seenKey(gallery));
                await this.warnDailyLimit();
            // LLM 서비스의 한도(하루 한도, 결제 한도)를 다 써서 쉬는 중이어도 같습니다.
            } else if (this.llm.paused) {
                this.lastSeen.delete(this.seenKey(gallery));
            // app_id 발급이 거절된 뒤에는 잠시 목록 확인을 쉽니다. 다시 시도해 봐야 거절만 늘어납니다.
            } else if (this.deps.appId.canTry()) {
                this.notLoggedInWarned.delete(gallery.id);
                this.dailyLimitWarned = false;
                await this.checkGallery(gallery, runId);
                this.listFailures.delete(configId);
                this.appIdPauseLogged = false;
            } else if (!this.appIdPauseLogged) {
                // 다른 계정의 요청이 app_id 거절을 받아 함께 쉬는 중입니다. 감시가 멈춘 것처럼 보이지 않게 한 번 남깁니다.
                this.appIdPauseLogged = true;
                this.deps.logger.warn("디시 앱 인증(app_id) 거절로 잠시 목록 확인을 쉽니다.", {galleryId: gallery.galleryId});
            }
        } catch (error) {
            this.deps.logger.error(`목록 확인 실패: ${errorMessage(error)}`, {galleryId: gallery.galleryId});
            if (isLoginExpired(error) || isAppIdFailure(error) || error instanceof NotLoggedInError) {
                await this.recoverReader(error, gallery);
            } else {
                delayMs = await this.backOff(configId, gallery);
            }
        } finally {
            // 설정이 바뀌었을 수 있으니 다음 간격은 최신 설정에서 읽습니다.
            if (runId === this.runId) this.schedule(configId, runId, delayMs ?? (this.gallery(configId)?.intervalSec ?? gallery.intervalSec) * 1000);
        }
    }

    /**
     * 차단 페이지나 서버 오류처럼 다시 해 봐도 같을 수 있는 실패가 이어지면, 다음 확인을 감시 간격의 2배, 4배…(최대 30분)로 늦춥니다.
     * 차단된 상태에서 요청을 계속 쌓지 않기 위해서입니다. 여러 번 이어지면 한 번 알립니다.
     */
    private async backOff(configId: string, gallery: GalleryConfig): Promise<number> {
        const failures = (this.listFailures.get(configId) ?? 0) + 1;
        this.listFailures.set(configId, failures);
        const intervalMs = (this.gallery(configId)?.intervalSec ?? gallery.intervalSec) * 1000;
        const delayMs = Math.min(intervalMs * 2 ** failures, Math.max(intervalMs, FAILURE_BACKOFF_MAX_MS));
        this.deps.logger.warn(`목록 확인이 ${failures}번 연달아 실패해 ${Math.round(delayMs / 1000)}초 뒤 다시 확인합니다.`, {galleryId: gallery.galleryId});
        if (failures === FAILURE_ALERT_AFTER) {
            await this.alert("디시 목록 확인이 계속 실패합니다", `${gallery.galleryId} 갤러리 목록 확인이 ${failures}번 연달아 실패했습니다. 디시 접속이 막혔을 수 있습니다. 감시 간격을 늘려 다시 시도합니다.`);
        }
        return delayMs;
    }

    private seenKey(gallery: GalleryConfig): string {
        return `${gallery.id}\n${gallery.galleryId}`;
    }

    /**
     * 새 글을 확인합니다. 처음 확인할 때는 기준점만 잡습니다.
     *
     * 1. 오래된 순서로 새 글을 보며 본문을 읽습니다. 키워드에 걸린 글은 늘 읽고, 나머지는 본문 요청 상한까지 읽습니다.
     *    app_id 거절로 글을 못 읽으면 거기서 멈추고, 그 글부터 다음에 다시 봅니다.
     * 2. 새 글 전부를 글 번호, 제목, 본문과 함께 LLM 요청 한 번으로 판단하고, 줄을 서야 하는 글만 따로 한 번 더 확인합니다.
     */
    private async checkGallery(gallery: GalleryConfig, runId: number): Promise<void> {
        const {logger} = this.deps;
        const key = this.seenKey(gallery);
        const lastSeen = this.lastSeen.get(key);
        const collected = new Map<number, NewPost>();
        let reachedLastSeen = false;

        for (let page = 1; page <= MAX_PAGES_PER_TICK; page++) {
            const response = await this.read(gallery, (client) => client.articles.list({gallery: gallery.galleryId, page}));
            this.deps.appId.succeed();
            const items = (response.gall_list ?? []).filter((item: PostItem) => typeof item.no === "number" && !item.fixtop);
            for (const item of items) collected.set(item.no!, {no: item.no!, title: item.subject ?? "", ...(item.date_time ? {dateTime: item.date_time} : {})});
            // 첫 확인이거나, 이번 페이지에 이미 본 글이 있으면 더 넘기지 않습니다.
            reachedLastSeen = items.length === 0 || (lastSeen !== undefined && items.some((item) => item.no! <= lastSeen));
            if (lastSeen === undefined || reachedLastSeen) break;
        }
        if (runId !== this.runId) return;
        if (lastSeen !== undefined && !reachedLastSeen && collected.size > 0) {
            const oldest = Math.min(...collected.keys());
            if (oldest > lastSeen + 1) {
                logger.warn(`새 글이 너무 많아 ${MAX_PAGES_PER_TICK}페이지 밖의 글(#${lastSeen + 1}~#${oldest - 1})은 확인하지 못했습니다. 감시 간격을 줄여 보세요.`, {galleryId: gallery.galleryId});
            }
        }

        const report = (newPosts: number, matched: number) => {
            this.statuses.set(gallery.id, {lastCheckedAt: Date.now(), newPosts, matched});
            this.deps.onStateChanged?.();
        };
        if (lastSeen === undefined) {
            // 목록이 비어 오면 기준 글을 잡지 않고 다음 확인 때 다시 잡습니다. #0을 기준으로 잡으면 다음 확인에서 옛 글 전부를 새 글로 보게 됩니다.
            if (collected.size === 0) {
                logger.warn("목록이 비어 있어 기준 글을 잡지 못했습니다. 다음 확인 때 다시 잡습니다.", {galleryId: gallery.galleryId});
                return;
            }
            const newest = Math.max(...collected.keys());
            this.lastSeen.set(key, newest);
            logger.info(`감시 시작. 기준 글 #${newest} 이후의 새 글만 확인합니다.`, {galleryId: gallery.galleryId});
            report(0, 0);
            return;
        }
        const posts = [...collected.values()].filter((post) => post.no > lastSeen).sort((a, b) => a.no - b.no);
        const epoch = this.epoch;
        let judged = 0;
        try {
            const found = await this.collect(gallery, posts, runId);
            // 확인하는 사이 감시가 다시 시작됐으면 이 결과는 버립니다. 다음 확인에서 다시 봅니다.
            if (!found || runId !== this.runId) return;
            if (found.last !== null) this.lastSeen.set(key, found.last);
            judged = found.candidates.length;
            // 판단은 따로 돌려, 분당 요청 한도를 기다리는 동안에도 목록 확인이 멈추지 않게 합니다.
            if (found.candidates.length > 0) this.track(this.judgeAll(gallery, found.candidates, epoch));
        } finally {
            report(posts.length, judged);
        }
    }

    /**
     * 새 글을 오래된 순서로 보며 LLM에 보낼 글을 모읍니다. 감시가 다시 시작되면 null입니다.
     * 본문은 키워드에 걸린 글은 늘 읽고, 나머지는 최근 글부터 본문 요청 상한까지 읽습니다(본문 확인을 끄면 키워드에 걸린 글만).
     * 본문을 읽지 않은 글은 제목만 보냅니다. `last`는 끝까지 본 마지막 글 번호입니다.
     */
    private async collect(gallery: GalleryConfig, posts: NewPost[], runId: number) {
        const {ledger, logger} = this.deps;
        const fresh = posts.filter((post) => !ledger.has(gallery.galleryId, post.no) && !this.excludedBy(gallery, post.title));
        const keyword = new Set(gallery.keywords.length === 0 ? [] : fresh.filter((post) => matchesKeywords(post.title, gallery.keywords)).map((post) => post.no));
        const others = gallery.scanBody ? fresh.filter((post) => !keyword.has(post.no)) : [];
        // 상한을 넘으면 최근 글부터 본문을 엽니다. 오래된 글일수록 이미 마감됐을 가능성이 큽니다.
        const limit = gallery.bodyReadLimit;
        const scanned = limit === 0 ? others : others.slice(-limit);
        const read = new Set([...keyword, ...scanned.map((post) => post.no)]);
        if (scanned.length < others.length) {
            logger.info(`새 글 ${others.length}개 중 최근 ${scanned.length}개만 본문을 읽고, 나머지는 제목만 판단합니다. (본문 요청 상한 ${limit}개)`, {galleryId: gallery.galleryId});
        }

        const result = {candidates: [] as Candidate[], last: null as number | null};
        const failures = {reads: 0};
        for (const post of posts) {
            if (runId !== this.runId) return null;
            const outcome = await this.inspect(gallery, post, keyword.has(post.no), read.has(post.no), failures);
            if (outcome === "retry") break;
            if (outcome !== "done") result.candidates.push(outcome);
            result.last = post.no;
        }
        return result;
    }

    /**
     * 글 하나를 LLM에 보낼 수 있게 준비합니다. `read`이면 본문을 읽고, 아니면 제목만 씁니다.
     * 넘길 글이면 "done", 지금은 읽을 수 없어 다음에 다시 봐야 하면 "retry"입니다.
     */
    private async inspect(gallery: GalleryConfig, post: NewPost, titleKeyword: boolean, read: boolean, failures: {reads: number}): Promise<"done" | "retry" | Candidate> {
        const {ledger, logger} = this.deps;
        if (ledger.has(gallery.galleryId, post.no)) return "done";
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const excludedByTitle = this.excludedBy(gallery, post.title);
        if (excludedByTitle) {
            if (titleKeyword) logger.info(`넘어감: 제목에 제외 키워드 "${excludedByTitle}"`, context);
            return "done";
        }
        const detectedAt = Date.now();
        const listed = postedAtRange([post.dateTime], detectedAt);
        const titleOnly: Candidate = {post, title: post.title, body: "", bodyRead: false, keyword: titleKeyword, detectedAt, postedAt: listed.latest, postedSlackMs: listed.latest - listed.earliest};
        if (!read) return titleOnly;
        if (!this.deps.appId.canTry()) return "retry";

        await this.paceRead();
        let title = post.title;
        let body: string;
        let dateTime: string | undefined;
        try {
            const article = await this.read(gallery, (client) => client.articles.read(gallery.galleryId, post.no));
            title = article.view_info?.subject ?? post.title;
            dateTime = article.view_info?.date_time;
            body = htmlToText(article.view_main?.memo ?? "");
        } catch (error) {
            // 금방 지워진 글은 알릴 필요가 없습니다.
            if (/삭제했거나 존재하지 않는/.test(errorMessage(error))) return "done";
            // app_id 거절이나 로그인 만료면 처리한 뒤 이 글부터 다음에 다시 봅니다. 알리거나 처리한 글로 남기지 않고,
            // 남은 글을 계속 읽어 로그인 재시도를 쌓지 않습니다. 로그인된 계정이 없어진 경우도 같습니다.
            if (error instanceof NotLoggedInError) return "retry";
            if (isAppIdFailure(error) || isLoginExpired(error)) {
                await this.recoverReader(error, gallery);
                return "retry";
            }
            // 차단이나 서버 오류처럼 계속 실패할 수 있는 오류가 이번 확인에서 이어지면, 요청을 쌓지 않도록 남은 글은 다음 확인 때 다시 읽습니다.
            if (++failures.reads >= READ_FAILURES_PER_TICK) {
                logger.warn(`본문 읽기가 연달아 실패해 이 글부터는 다음 확인 때 다시 읽습니다: ${errorMessage(error)}`, context);
                return "retry";
            }
            // 이 글만의 문제(성인 인증 글 등)일 수 있으니 제목만 판단하고 넘어갑니다(본문을 못 본 글은 자동으로 줄 서지 않습니다).
            logger.warn(`본문을 읽지 못해 제목만 판단합니다: ${errorMessage(error)}`, context);
            return titleOnly;
        }

        const excludedByBody = this.excludedBy(gallery, body);
        if (excludedByBody) {
            if (titleKeyword) logger.info(`넘어감: 본문에 제외 키워드 "${excludedByBody}"`, context);
            return "done";
        }
        const keyword = titleKeyword || (gallery.keywords.length > 0 && findKeyword(body, gallery.keywords) !== null);
        const posted = postedAtRange([dateTime, post.dateTime], detectedAt);
        return {post, title, body, bodyRead: true, keyword, detectedAt, postedAt: posted.latest, postedSlackMs: posted.latest - posted.earliest, ...(dateTime ? {dateTime} : {})};
    }

    /** 무료 등급 하루 LLM 요청 수를 다 써서 감시를 쉰다고 한 번만 알립니다. */
    private async warnDailyLimit(): Promise<void> {
        if (this.dailyLimitWarned) return;
        this.dailyLimitWarned = true;
        const reset = new Date(this.llm.usage.resetAt).toLocaleTimeString("ko-KR", {hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Seoul"});
        const message = `무료 등급 하루 LLM 요청 수(${FREE_DAILY_LLM_REQUESTS}회)를 다 써서 한국 시간 ${reset}까지 감시를 쉽니다. 감시 간격을 늘리면 하루에 더 오래 감시할 수 있고, 유료 요금제를 쓰면 이 제한이 없습니다.`;
        this.deps.logger.warn(message);
        await this.alert("감시 일시 중지: 하루 LLM 요청 수 소진", message);
    }

    /** 이 계정이 로그인하는 중이거나, 일시적인 오류로 자동 재로그인을 기다린 지 얼마 안 됐는지입니다. */
    private recoveringLogin(accountId: string): boolean {
        const status = this.deps.accounts.status?.(accountId);
        if (status?.state === "logging_in") return true;
        return status?.state === "error" && status.failingSince !== undefined && this.now() - status.failingSince < LOGIN_RECOVERY_QUIET_MS;
    }

    /** 로그인된 계정이 없어 감시를 쉰다고 한 번만 알립니다. */
    private async warnNotLoggedIn(gallery: GalleryConfig): Promise<void> {
        if (this.notLoggedInWarned.has(gallery.id)) return;
        this.notLoggedInWarned.add(gallery.id);
        const message = "이 갤러리의 대기 계정 중 로그인된 계정이 없어 디시에 요청하지 않고 감시를 쉽니다. 계정 탭에서 로그인하면 이어서 확인합니다.";
        this.deps.logger.warn(message, {galleryId: gallery.galleryId});
        await this.alert(`감시 일시 중지: 로그인 필요 (${gallery.galleryId})`, message);
    }

    /** 본문 읽기 사이에 간격을 둡니다. */
    private async paceRead(): Promise<void> {
        const now = Date.now();
        const wait = this.nextReadAt - now;
        this.nextReadAt = Math.max(now, this.nextReadAt) + this.readGapMs;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }

    /**
     * 새 글들을 LLM으로 판단하고 바로 처리합니다. 글 번호, 제목, 본문을 묶어 요청 한 번(최대 ${MAX_BATCH_POSTS}개씩)으로 보내고,
     * 나눔으로 판단돼 줄을 서야 하는 글만 그 글 하나로 다시 물어 확인합니다(묶인 다른 글이 판단을 조작하지 못하게).
     * 무료 등급이면 하루 요청 수를 넘지 않게 합니다.
     */
    private async judgeAll(gallery: GalleryConfig, candidates: Candidate[], epoch: number): Promise<void> {
        const {logger} = this.deps;
        const context = {galleryId: gallery.galleryId};
        const failAll = async (group: Candidate[], reason: string) => {
            // 키워드에 걸린 글만 알립니다. 모든 새 글을 알리면 알림이 넘칩니다.
            for (const candidate of group) {
                if (candidate.keyword) await this.dispatch(gallery, candidate.post, {kind: "notify", reason: `글 분석 실패: ${reason}`}, {live: {epoch}});
            }
        };
        let provider: LlmProvider;
        try {
            provider = this.llm.provider();
        } catch (error) {
            logger.warn(`새 글 ${candidates.length}개를 판단하지 못했습니다: ${errorMessage(error)}`, context);
            return failAll(candidates, errorMessage(error));
        }
        let giveaways = 0;
        for (let start = 0; start < candidates.length; start += MAX_BATCH_POSTS) {
            const group = candidates.slice(start, start + MAX_BATCH_POSTS);
            if (!this.llm.canUseToday()) {
                logger.warn(`무료 등급 하루 LLM 요청 수를 다 써서 새 글 ${candidates.length - start}개는 판단하지 못했습니다.`, context);
                return;
            }
            let startedAt = this.now();
            let decisions: (Decision | null)[];
            const decide = async () => {
                await this.llm.request(gallery.galleryId);
                const posts = group.map(({post, title, body, postedAt}) => ({no: post.no, title, body, postedAt}));
                return group.length === 1 ? [await provider.decide(posts[0]!)] : await provider.decideMany(posts);
            };
            try {
                decisions = await decide();
            } catch (error) {
                // 판단하는 사이 컴퓨터가 잠들었다 깨어나 실패한 것이면 알리지 않습니다. 짧게 잤으면 깨어나 네트워크가 붙은 뒤 한 번 더 판단하고,
                // 오래 잤으면(기준 글을 새로 잡았으므로) 버립니다.
                if (!this.sleptSince(startedAt)) {
                    logger.warn(`새 글 ${group.length}개를 판단하지 못했습니다: ${errorMessage(error)}`, context);
                    await failAll(group, errorMessage(error));
                    continue;
                }
                await this.asleep?.awake;
                const sleep = this.lastSleep;
                if (epoch !== this.epoch || !sleep || sleep.to - sleep.from > LONG_SLEEP_MS) {
                    logger.info(`판단하는 사이 컴퓨터가 잠들어 새 글 ${group.length}개는 건너뜁니다.`, context);
                    continue;
                }
                try {
                    startedAt = this.now();
                    decisions = await decide();
                } catch (retryError) {
                    logger.warn(`잠자기에서 깨어난 뒤 다시 판단했지만 새 글 ${group.length}개를 판단하지 못했습니다: ${errorMessage(retryError)}`, context);
                    await failAll(group, errorMessage(retryError));
                    continue;
                }
            }
            const found = group.filter((_, index) => decisions[index]?.is_giveaway).length;
            if (found > 0) this.recordJudgment(gallery, "batch", group, decisions);
            logger.info(`새 글 ${group.length}개를 LLM 요청 한 번으로 판단: 나눔 ${found}개 (${((this.now() - startedAt) / 1000).toFixed(1)}초)`, context);
            for (const [index, candidate] of group.entries()) {
                const decision = decisions[index] ?? null;
                const postContext = {...context, postNo: candidate.post.no};
                if (!decision) {
                    if (candidate.keyword) await this.dispatch(gallery, candidate.post, {kind: "notify", reason: "글 분석 실패: LLM 응답에 이 글의 판단이 빠져 있음"}, {live: {epoch}});
                    continue;
                }
                // 나중에 놓친 글이나 잘못 선 글을 되짚을 수 있도록, 글마다 판단과 LLM의 근거를 남깁니다.
                if (!decision.is_giveaway) {
                    logger.info(`나눔 아님: "${candidate.title}" (근거: ${decision.reason})`, postContext);
                    continue;
                }
                giveaways++;
                logger.info(`나눔으로 판단: "${candidate.title}" (${describeDecision(decision)}) (근거: ${decision.reason})`, postContext);
                let plan = this.planFor(gallery, decision, candidate);
                if (plan.kind === "comment" && group.length > 1) plan = await this.confirm(gallery, provider, candidate);
                await this.dispatch(gallery, candidate.post, plan, {live: {epoch}});
            }
        }
        const status = this.statuses.get(gallery.id);
        if (status && giveaways > 0) {
            status.matched += giveaways;
            this.deps.onStateChanged?.();
        }
    }

    /**
     * 묶음 판단에서 줄을 서라고 나온 글을 그 글 하나로 다시 물어 확인합니다. 지금 남은 요청 자리가 없으면
     * 기다리지 않고(선착순을 놓치지 않게) 자동으로 서지 않고 알립니다.
     */
    private async confirm(gallery: GalleryConfig, provider: LlmProvider, candidate: Candidate): Promise<Plan> {
        if (!this.llm.hasSlotNow() || !this.llm.canUseToday()) {
            return {kind: "notify", reason: "여러 글을 묶어 판단한 결과라 따로 확인해야 하는데 남은 LLM 요청이 없어 직접 확인이 필요함"};
        }
        try {
            await this.llm.request(gallery.galleryId);
            const decision = await provider.decide({no: candidate.post.no, title: candidate.title, body: candidate.body, postedAt: candidate.postedAt});
            this.recordJudgment(gallery, "confirm", [candidate], [decision]);
            this.deps.logger.info(`2차 확인: ${decision.is_giveaway ? "나눔" : "나눔 아님"} (${describeDecision(decision)}) (근거: ${decision.reason})`,
                {galleryId: gallery.galleryId, postNo: candidate.post.no});
            if (!decision.is_giveaway) return {kind: "skip", reason: "따로 다시 판단하니 나눔 글이 아님"};
            return this.planFor(gallery, decision, candidate);
        } catch (error) {
            return {kind: "notify", reason: `묶음 판단 결과를 확인하지 못함: ${errorMessage(error)}`};
        }
    }

    /** LLM에 보낸 내용(요청과 똑같이 만든 메시지)과 판단 원문을 남깁니다. */
    private recordJudgment(gallery: GalleryConfig, kind: JudgmentRecord["kind"], group: Candidate[], decisions: (Decision | null)[]): void {
        if (!this.deps.recordJudgment) return;
        const {llm} = this.deps.settings();
        const posts = group.map(({post, title, body, postedAt}) => ({no: post.no, title, body, postedAt}));
        const single = group.length === 1;
        this.deps.recordJudgment({
            time: Date.now(),
            galleryId: gallery.galleryId,
            kind,
            model: `${llm.provider}/${llm.models[llm.provider]}`,
            systemPrompt: single ? "SYSTEM_PROMPT" : "BATCH_SYSTEM_PROMPT",
            message: single ? buildUserMessage(posts[0]!.title, posts[0]!.body, posts[0]!.postedAt) : buildBatchMessage(posts),
            // 디시가 준 작성 시각 문자열도 남겨 두어, 작성 시각을 제대로 읽었는지 나중에 확인할 수 있게 합니다.
            posts: group.map((candidate) => ({
                no: candidate.post.no, title: candidate.title, bodyRead: candidate.bodyRead, keyword: candidate.keyword,
                detectedAt: candidate.detectedAt, postedAt: candidate.postedAt, dateTime: candidate.dateTime ?? candidate.post.dateTime ?? null
            })),
            decisions
        });
    }

    /** 오늘 쓴 LLM 요청 수와 한도입니다. 화면에 보여줍니다. */
    llmUsage(): {count: number; limit: number; resetAt: number} {
        return this.llm.view();
    }

    private planFor(gallery: GalleryConfig, decision: Decision, candidate: {title: string; body: string; bodyRead?: boolean; detectedAt: number; postedAt?: number; postedSlackMs?: number}): Plan {
        if (decision.is_giveaway && candidate.postedAt !== undefined && candidate.detectedAt - candidate.postedAt > STALE_POST_MS) {
            return {kind: "skip", reason: `올라온 지 ${Math.round((candidate.detectedAt - candidate.postedAt) / 60000)}분 지난 글이라 자동으로 줄 서지 않음`};
        }
        const settings = this.deps.settings();
        const accounts = this.deps.accounts.candidates(settings.accounts, gallery.accountIds);
        const plan = makePlan(decision, gallery, accounts, candidate.detectedAt, `${candidate.title}\n${candidate.body}`, candidate.postedSlackMs ?? 0);
        // 본문을 읽지 않은 글은 본문에 봇 색출 문구나 다른 조건이 있어도 알 수 없으므로, 자동으로 서지 않고 알립니다.
        if (plan.kind === "comment" && candidate.bodyRead === false) {
            return {kind: "notify", reason: "본문 요청 상한을 넘어 본문을 확인하지 못했습니다. 글을 직접 확인하세요."};
        }
        return plan.kind === "comment" ? {...plan, basis: decision.reason} : plan;
    }

    /**
     * app_id 발급이 거절됐으면 잠시 목록 확인을 쉽니다.
     * 거절이 오래 이어질 때만 읽기용 기기 정보를 새로 받습니다.
     */
    private async recoverReader(error: unknown, gallery: GalleryConfig): Promise<void> {
        // 읽던 계정의 로그인이 풀렸으면(비밀번호 변경 등) 그 계정을 내려놓아, 확인할 때마다 로그인을 다시 시도하지 않게 합니다.
        if (isLoginExpired(error)) {
            const client = typeof error === "object" && error !== null ? this.failedReaders.get(error) : undefined;
            const outcome = client ? await this.deps.onReaderLoginExpired(client, errorMessage(error)) : "none";
            this.deps.onStateChanged?.();
            if (outcome === "recovered") {
                this.deps.logger.info("글을 읽던 계정의 로그인이 풀려 다시 로그인했습니다.");
            } else if (outcome === "retrying") {
                this.deps.logger.warn(`글을 읽던 계정의 로그인이 풀렸는데 지금은 다시 로그인하지 못해(네트워크 등) 잠시 뒤 자동으로 다시 시도합니다: ${errorMessage(error)}`);
            } else if (outcome === "expired") {
                // 바로 아래 알림으로 알렸으니, 대기 계정이 더 없어 쉬게 되어도 "로그인 필요"를 또 보내지 않습니다.
                this.notLoggedInWarned.add(gallery.id);
                this.deps.logger.warn(`글을 읽던 계정의 로그인이 풀려 다음 계정으로 읽습니다: ${errorMessage(error)}`);
                await this.alert("디시 로그인이 풀렸습니다", "글을 읽던 계정의 로그인이 풀렸습니다. 계정 탭에서 다시 로그인하세요.");
            }
            return;
        }
        if (!isAppIdFailure(error)) return;
        const outdated = isOutdatedAppError(error);
        const needsFreshDevice = this.deps.appId.fail(outdated ? OUTDATED_PAUSE_MS : undefined);
        const minutes = Math.round(this.deps.appId.lastPauseMs / 60000);
        // 앱 버전이 낮아 거절된 것이면 기기 정보를 새로 받아도 풀리지 않습니다. 쉬면서 한 번만 알립니다.
        if (outdated) {
            this.deps.logger.error(`${OUTDATED_APP_MESSAGE} ${minutes}분 뒤 다시 확인합니다.`);
            if (!this.outdatedNotified) {
                this.outdatedNotified = true;
                await this.alert("디시 접속 불가: Hamboogie 업데이트 필요", OUTDATED_APP_MESSAGE);
            }
            return;
        }
        if (!needsFreshDevice) {
            this.deps.logger.warn(`디시 앱 인증(app_id) 발급이 거절되어 ${minutes}분 동안 목록 확인을 쉽니다.`);
            return;
        }
        this.deps.logger.warn(`디시 앱 인증(app_id) 거절이 오래 이어져 글 읽는 쪽의 기기 정보를 새로 받습니다. ${minutes}분 뒤 다시 확인합니다.`);
        await this.deps.resetReader(gallery);
    }

    /** 제외 키워드가 들어 있으면 그 키워드를 돌려줍니다. */
    excludedBy(gallery: GalleryConfig, text: string): string | null {
        return findKeyword(text, gallery.excludeKeywords ?? []);
    }

    /** 여러 글을 감시할 때와 같은 방식(글이 하나면 하나만 판단)으로 LLM 요청 한 번에 판단합니다. 응답에 빠진 글은 null입니다. */
    async decideBatch(posts: PostInput[]): Promise<(Decision | null)[]> {
        const provider = this.llm.provider();
        await this.llm.request();
        return posts.length === 1 ? [await provider.decide(posts[0]!)] : provider.decideMany(posts);
    }

    /** 글 내용을 LLM으로 판단하고 행동 계획을 세웁니다. LLM 호출이 실패하면 알림 계획을 돌려줍니다. */
    async analyze(gallery: GalleryConfig, title: string, body: string, detectedAt: number): Promise<Analysis> {
        try {
            const provider = this.llm.provider();
            await this.llm.request(gallery.galleryId);
            // 실제 감시처럼 글을 올린 시각을 함께 보냅니다. 방금 올라온 글로 보고 감지한 시각을 씁니다.
            const decision = await provider.decide({title, body, postedAt: detectedAt});
            return {decision, plan: this.planFor(gallery, decision, {title, body, detectedAt})};
        } catch (error) {
            return {decision: null, plan: {kind: "notify", reason: `글 분석 실패: ${errorMessage(error)}`}};
        }
    }

    /**
     * 계획대로 넘어가거나, 알리거나, 줄 서기를 예약합니다.
     *
     * @param options.live 감시로 찾은 글이면 넘깁니다. 처리한 글 기록을 남기고, 사용자가 감시를 멈췄으면 아무것도 하지 않으며,
     *   실행 직전에 최신 설정을 다시 확인합니다. 없으면 개발 모드 테스트로 보고 기록과 설정 확인을 건너뜁니다.
     * @param options.label 로그와 알림 앞에 붙일 표시입니다.
     */
    async dispatch(gallery: GalleryConfig, post: NewPost, plan: Plan, options: {live?: Live; label?: string} = {}): Promise<void> {
        const {ledger, logger} = this.deps;
        const {live} = options;
        const label = options.label ? `${options.label} ` : "";
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        if (live && live.epoch !== this.epoch) {
            logger.info(`${label}감시를 멈춰 이 글은 처리하지 않습니다.`, context);
            return;
        }
        const claim = () => !live || ledger.claim(gallery.galleryId, post.no);

        switch (plan.kind) {
            case "skip":
                logger.info(`${label}넘어감: ${plan.reason}`, context);
                return;
            case "notify":
                if (!claim()) return;
                logger.warn(`${label}판단 불가, 알림 전송: ${plan.reason}`, context);
                await this.notify(`${label}판단이 필요한 글: ${post.title}`, plan.reason, gallery.galleryId, post.no);
                return;
            case "comment": {
                if (!claim()) return;
                const waitMs = Math.max(0, plan.notBefore - Date.now());
                if (waitMs > 0) logger.info(`${label}${Math.round(waitMs / 1000)}초 뒤에 줄을 섭니다.`, context);
                const timer = setTimeout(() => {
                    this.scheduled.delete(timer);
                    void this.execute(gallery, post, plan, label, live);
                }, waitMs);
                this.scheduled.set(timer, {gallery, post, test: !live});
            }
        }
    }

    /**
     * 실행 직전에 최신 설정으로 계획을 다시 확인합니다. 줄을 서면 안 되면 그 이유를 돌려줍니다.
     * 서도 되면 지금 설정에서 시도할 수 있는 계정만 남긴 시도 목록을 돌려줍니다.
     */
    private revalidate(gallery: GalleryConfig, plan: CommentPlan): {reason: string} | {attempts: CommentPlan["attempts"]} {
        const settings = this.deps.settings();
        const latest = settings.galleries.find((item) => item.id === gallery.id);
        if (!latest || !latest.enabled || latest.galleryId !== gallery.galleryId) return {reason: "감시 설정이 바뀌어(갤러리 삭제/끄기/ID 변경) 취소함"};
        if (latest.category === "food" && !plan.isFood) return {reason: "나눔 종류 설정이 '음식만'으로 바뀌어 취소함"};
        const allowed = new Set(latest.accountIds);
        const candidates = new Map(this.deps.accounts.candidates(settings.accounts, latest.accountIds).map((account) => [account.id, account]));
        const attempts = plan.attempts.filter((attempt) => {
            if (!allowed.has(attempt.accountId)) return false;
            const candidate = candidates.get(attempt.accountId);
            // 로그아웃된 계정은 시도해서 실패로 남기고, 로그인된 계정은 바뀐 계정 종류로 자격을 다시 봅니다.
            return !candidate || eligible(candidate, plan.requirement);
        });
        if (attempts.length === 0) return {reason: "대기 계정 설정이 바뀌어 줄을 설 계정이 없어 취소함"};
        return {attempts};
    }

    /**
     * 우선순위 순서로 한 계정씩 시도하고, 하나라도 성공하면 멈춥니다. 글 하나에는 댓글 하나만 답니다.
     * 댓글이 달리지 않은 것이 확실한 실패일 때만 다음 계정으로 넘어가고, 결과를 알 수 없으면(응답 시간 초과 등) 멈추고 알립니다.
     */
    private async execute(gallery: GalleryConfig, post: NewPost, plan: CommentPlan, prefix: string, live: Live | undefined): Promise<void> {
        const {accounts, logger} = this.deps;
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const test = !live;
        const cancel = (reason: string) => {
            logger.warn(`${prefix}줄 서기를 하지 않음: ${reason}`, context);
            this.record(gallery, post, "failure", reason, test);
        };

        // 예약해 둔 줄 서기가 잠든 사이 시각이 되었으면, 깨어나 네트워크가 붙은 뒤에 섭니다(감시를 멈췄으면 아래에서 취소됩니다).
        if (live && this.asleep) await this.asleep.awake;
        let attempts = plan.attempts;
        if (live) {
            const checked = this.revalidate(gallery, plan);
            if ("reason" in checked) return cancel(checked.reason);
            attempts = checked.attempts;
        }

        const failures: string[] = [];
        for (const attempt of attempts) {
            if (live && live.epoch !== this.epoch) return cancel("감시를 멈춰 취소함");
            // 예약해 둔 사이, 또는 앞 계정이 실패해 재시도하는 사이 마감이 지났으면 달지 않습니다.
            if (plan.deadline !== undefined && Date.now() > plan.deadline - END_MARGIN_MS) return cancel("마감 시각이 지나 댓글을 달지 않음");

            const label = attempt.content.type === "text" ? `"${attempt.content.text}"` : `디시콘 "${attempt.content.dccon.title}"`;
            let failure: unknown = null;
            try {
                await accounts.writeComment(attempt.accountId, gallery.galleryId, post.no, attempt.content);
            } catch (error) {
                failure = error;
            }
            const nickname = accounts.nickname(attempt.accountId);

            if (failure === null) {
                const summary = `${nickname} 계정으로 ${label}`;
                logger.success(`${prefix}줄 서기 성공: ${summary}`, context);
                this.record(gallery, post, "success", summary, test);
                if (this.deps.settings().notifyOnSuccess) {
                    await this.alert(`${prefix}줄 서기 성공: ${post.title}`, plan.basis ? `${summary}\n판단 근거: ${plan.basis}` : summary, context, true);
                }
                if (live && this.stopAfterFirstSuccess) {
                    this.stopAfterFirstSuccess = false;
                    logger.info("테스트 설정에 따라 첫 줄 서기에 성공해 감시를 멈춥니다.", context);
                    this.stop();
                    this.deps.onStateChanged?.();
                }
                return;
            }
            const message = `${nickname}: ${errorMessage(failure)}`;
            // 갤러리에 보안 코드(캡차)가 걸려 있으면 계정을 바꿔도 같으므로 멈추고 알립니다.
            if (isCaptchaFailure(failure)) {
                const detail = `이 갤러리는 댓글에 보안 코드 입력이 필요해 자동으로 줄을 설 수 없습니다. (${message})`;
                logger.error(`${prefix}줄 서기 실패: 보안 코드 필요`, context);
                this.record(gallery, post, "failure", detail, test);
                await this.notify(`${prefix}줄 서기 실패(보안 코드 필요): ${post.title}`, detail, gallery.galleryId, post.no);
                return;
            }
            if (!isDefiniteCommentFailure(failure)) {
                // 서버가 댓글을 저장했을 수도 있으므로 다른 계정으로 또 달지 않습니다.
                const detail = `결과를 알 수 없음 (${message}). 댓글이 달렸는지 글에서 직접 확인하세요.`;
                logger.error(`${prefix}줄 서기 결과 불명: ${message}`, context);
                this.record(gallery, post, "failure", detail, test);
                await this.notify(`${prefix}줄 서기 결과 확인 필요: ${post.title}`, detail, gallery.galleryId, post.no);
                return;
            }
            failures.push(message);
            logger.error(`${prefix}줄 서기 실패 (${message})`, context);
        }
        this.record(gallery, post, "failure", failures.join("\n"), test);
        await this.notify(`${prefix}줄 서기 실패: ${post.title}`, failures.join("\n"), gallery.galleryId, post.no);
    }

    private record(gallery: GalleryConfig, post: NewPost, outcome: HistoryEntry["outcome"], detail: string, test: boolean): void {
        this.deps.history.add({
            time: Date.now(),
            galleryId: gallery.galleryId,
            postNo: post.no,
            title: post.title,
            outcome,
            detail,
            ...(test ? {test} : {})
        });
    }

    private notify(title: string, description: string, galleryId: string, postNo: number): Promise<void> {
        return this.alert(title, description, {galleryId, postNo});
    }

    /** Discord로 알립니다. 글과 관련된 알림이면 글 링크를 붙입니다. */
    async alert(title: string, description: string, post?: {galleryId: string; postNo: number}, success = false): Promise<void> {
        const {logger} = this.deps;
        const webhookUrl = this.deps.settings().discordWebhookUrl;
        if (!webhookUrl) {
            logger.warn("Discord 웹훅이 설정되지 않아 알림을 보내지 못했습니다.", post);
            return;
        }
        try {
            await sendDiscordNotice(webhookUrl, {title, description, success, ...(post ? {url: postUrl(post.galleryId, post.postNo)} : {})});
        } catch (error) {
            logger.error(`Discord 알림 전송 실패: ${errorMessage(error)}`, post);
        }
    }
}
