import type {DCInside} from "@green-1052/dcinside.js";
import {errorMessage} from "@shared/errors";
import {FREE_DAILY_LLM_REQUESTS, galleryProblems, nextAutoStopAt} from "@shared/settings";
import type {GalleryConfig, GalleryStatus, HistoryEntry, LlmUsageView, Settings} from "@shared/types";
import {clockText, delay, kstClockText} from "@shared/time";
import {isAppIdFailure, isLoginExpired, type AccountManager} from "../dc/accounts";
import type {AppIdBackoff} from "../dc/app-id-backoff";
import {isOutdatedAppError, OUTDATED_APP_MESSAGE, OUTDATED_PAUSE_MS} from "../dc/app-version";
import type {LlmGate} from "../llm/gate";
import type {PostImageStats} from "../dc/post-images";
import type {LlmImage} from "../llm/providers";
import type {LlmUsage} from "../llm/usage";
import type {Logger} from "../logger";
import type {DiscordNotice} from "../notify/discord";
import type {Ledger, SecretStore} from "../store";
import {AutoStopTimer} from "./auto-stop";
import {NotLoggedInError, type Analysis, type JudgmentRecord, type Live, type NewPost} from "./candidate";
import {MAX_PAGES_PER_TICK, PostCollector} from "./collector";
import {Dispatcher, type PostContent} from "./dispatcher";
import {Judge} from "./judge";
import {findKeyword} from "./keyword-filter";
import {Notifier, type NoticeResult} from "./notifier";
import type {Plan} from "./planner";
import {LONG_SLEEP_MS, SleepState} from "./sleep-state";

export type {Analysis, JudgmentRecord, NewPost} from "./candidate";

/** 같은 갤러리의 앞선 확인이 끝나지 않았을 때 다시 볼 때까지 기다리는 시간입니다. */
const CHECK_BUSY_RETRY_MS = 2000;
/** 깨어난 뒤 네트워크가 다시 붙기를 처음 기다리는 시간입니다. */
const WAKE_SETTLE_MS = 10 * 1000;
/** 깨어난 뒤 이 시간 안에 네트워크가 붙지 않으면 감시를 멈춥니다. */
const WAKE_NETWORK_LIMIT_MS = 60 * 1000;
/** 네트워크가 붙었는지 다시 확인하는 간격입니다. */
const WAKE_NETWORK_RETRY_MS = 5 * 1000;
/** 일시적인 오류로 자동 재로그인을 기다리는 동안 "로그인 필요"를 알리지 않고 기다리는 시간입니다. */
const LOGIN_RECOVERY_QUIET_MS = 10 * 60 * 1000;
/** 목록 확인이 연달아 실패할 때 다음 확인까지 기다리는 최대 시간입니다. */
const FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** 목록 확인이 이만큼 연달아 실패하면 Discord로 한 번 알립니다. */
const FAILURE_ALERT_AFTER = 5;

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
    /** 나눔으로 판단된 글이나 키워드에 걸린 글이 있는 묶음과 2차 확인에서 LLM에 보낸 내용과 판단 원문을 남깁니다(나중에 되짚기 위해). */
    recordJudgment?(record: JudgmentRecord): void;
    /** 글에 올린 사진을 받아 LLM에 보낼 크기로 줄입니다. 없으면 사진 없이 판단합니다. `stats`에 열 수 없었던 사진 수를 셉니다. */
    postImages?(urls: string[], stats?: PostImageStats): Promise<LlmImage[]>;
    /** 테스트에서 시각을 바꿀 수 있게 합니다. */
    now?(): number;
    /** 인터넷에 실제로 연결돼 있는지 확인합니다. 잠자기에서 깨어난 뒤 확인을 이어가도 되는지 볼 때 씁니다. */
    checkNetwork?(): Promise<boolean>;
    /** 컴퓨터 알림을 띄웁니다. 네트워크가 없어 Discord로 알릴 수 없을 때나, 중요한 알림을 Discord로 보내지 못했을 때 씁니다. */
    desktopNotice?(title: string, body: string): void;
    /** 테스트에서 기다리는 시간을 줄일 수 있게 합니다. */
    sleep?(ms: number): Promise<void>;
}

/**
 * 갤러리 감시를 맡습니다: 시작과 멈춤, 잠자기 대응, 갤러리마다 확인 예약, 목록 확인 실패 대응.
 * 글 모으기(`PostCollector`), 판단(`Judge`), 줄 서기 실행(`Dispatcher`), 알림(`Notifier`)은 각각 따로 둡니다.
 */
export class Engine {
    private readonly watchers = new Map<string, ReturnType<typeof setTimeout>>();
    /** 감시 중인 갤러리마다 지금 쓰는 감시 간격(초)입니다. 설정에서 간격을 바꾸면 기다리던 확인을 새 간격으로 다시 잡습니다. */
    private readonly intervals = new Map<string, number>();
    /** 마지막으로 처리한 글 번호입니다. 갤러리 설정 항목과 갤러리 ID를 함께 키로 써서, ID를 바꾸면 기준을 새로 잡습니다. */
    private readonly lastSeen = new Map<string, number>();
    /** 감시 타이머 세대입니다. 시작/멈춤마다 바뀝니다. */
    private runId = 0;
    /** 줄 서기 세대입니다. 사용자가 감시를 멈출 때만 바뀌고, 감시를 다시 시작할 때는 예약을 유지합니다. */
    private epoch = 0;
    /** 갤러리 설정 항목 id별 마지막 확인 결과입니다. */
    private readonly statuses = new Map<string, GalleryStatus>();
    /** 갤러리 설정 항목 id별로 감시를 시작한 뒤 나눔으로 판단한 글 수입니다. 확인마다 0으로 돌아가 숫자가 깜박이지 않게 따로 셉니다. */
    private readonly giveaways = new Map<string, {count: number}>();
    /** 갤러리 설정 항목 id별로 감시를 끈 횟수입니다. 확인하는 사이 그 갤러리 감시를 껐으면 결과를 버리는 데 씁니다. */
    private readonly dropped = new Map<string, number>();
    /** 무료 등급 하루 LLM 요청 수를 다 써서 감시를 쉰다고 이미 알렸는지입니다. */
    private dailyLimitWarned = false;
    /** 앱 버전이 낮아 접속이 거절됐다고 이미 알렸는지입니다. */
    private outdatedNotified = false;
    /** 로그인된 계정이 없어 감시를 쉰다고 이미 알렸는지입니다. 로그인되면 다시 알릴 수 있게 됩니다. */
    private readonly notLoggedInWarned = new Set<string>();
    /** 갤러리 설정 항목 id별로 목록 확인이 연달아 실패한 횟수입니다. 실패가 이어지면 다음 확인을 늦춥니다. */
    private readonly listFailures = new Map<string, number>();
    /** 목록 확인 실패가 이어진다고 이미 알린 갤러리입니다. 확인에 성공하면 다시 알릴 수 있게 됩니다. */
    private readonly listFailureWarned = new Set<string>();
    /** 갤러리별 마지막 예약 순번입니다. 이 순번의 예약만 확인을 실행하고 다음 확인을 예약합니다. */
    private readonly turns = new Map<string, number>();
    private turnCounter = 0;
    /** 지금 확인 중인 갤러리입니다. 같은 갤러리 확인이 겹치지 않게 합니다. */
    private readonly checking = new Set<string>();
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
    private readonly sleep = new SleepState();
    private readonly notifier: Notifier;
    private readonly collector: PostCollector;
    private readonly dispatcher: Dispatcher;
    private readonly judge: Judge;

    constructor(private readonly deps: EngineDeps) {
        this.now = deps.now ?? Date.now;
        this.autoStop = new AutoStopTimer(this.now, () => void this.stopAutomatically());
        this.notifier = new Notifier(deps);
        const host = {
            deps,
            now: () => this.now(),
            sleep: this.sleep,
            notifier: this.notifier,
            epoch: () => this.epoch,
            excludedBy: (gallery: GalleryConfig, text: string) => this.excludedBy(gallery, text)
        };
        this.collector = new PostCollector({
            ...host,
            read: (gallery, request) => this.read(gallery, request),
            recoverReader: (error, gallery) => this.recoverReader(error, gallery)
        });
        this.dispatcher = new Dispatcher({...host, readPost: (gallery, postNo) => this.collector.readPost(gallery, postNo)});
        this.judge = new Judge({...host, dispatcher: this.dispatcher});
    }

    get running(): boolean {
        return this.watchers.size > 0;
    }

    get watching(): number {
        return this.watchers.size;
    }

    /** LLM 요청 창구입니다. */
    get llm(): LlmGate {
        return this.judge.llm;
    }

    /** 본문 읽기 사이의 간격입니다. 테스트에서 줄입니다. */
    set readGapMs(ms: number) {
        this.collector.readGapMs = ms;
    }

    /** 갤러리별 마지막 확인 시각과 결과입니다. */
    galleryStatus(): Record<string, GalleryStatus> {
        return Object.fromEntries([...this.statuses].map(([id, status]) => [id, {...status}]));
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
        const {logger} = this.deps;
        for (const gallery of this.deps.settings().galleries) {
            if (!gallery.enabled) continue;
            const problems = galleryProblems(gallery);
            if (problems.length > 0) {
                this.warnProblems("감시하지 않음", gallery, problems);
                continue;
            }
            this.watch(gallery, 0);
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
        if (!this.running) return;
        if (this.sleep.begin(at)) this.deps.logger.info("컴퓨터가 잠들어 감시를 멈춥니다. 깨어나면 네트워크를 확인하고 이어갑니다.");
    }

    /**
     * 컴퓨터가 깨어날 때 부릅니다. 10초 기다린 뒤 네트워크가 실제로 붙었는지 보고, 붙었으면 확인을 이어갑니다.
     * 5분 넘게 잠들었으면 그사이 글은 버리고 기준 글을 새로 잡습니다. 1분이 지나도 네트워크가 없으면 감시를 멈추고 알립니다.
     */
    async resume(): Promise<void> {
        const sleeping = this.sleep.current;
        // 같은 깨어남에 대해 여러 번 불리면(깨어남, 화면 잠금 해제 등) 먼저 불린 것만 이어갑니다.
        if (!sleeping || sleeping.resuming) return;
        sleeping.resuming = true;
        const wake = ++sleeping.wakes;
        const wokeAt = this.now();
        const slept = wokeAt - sleeping.since;
        this.sleep.last = {from: sleeping.since, to: wokeAt};
        const {logger} = this.deps;
        const wait = this.deps.sleep ?? delay;
        logger.info(`컴퓨터가 깨어났습니다(${Math.round(slept / 60000)}분 잠듦). 네트워크가 붙기를 기다립니다.`);
        await wait(WAKE_SETTLE_MS);
        let online = false;
        const current = () => this.sleep.current === sleeping && sleeping.wakes === wake;
        while (current()) {
            online = await (this.deps.checkNetwork?.() ?? Promise.resolve(true)).catch(() => false);
            if (online || this.now() - wokeAt >= WAKE_NETWORK_LIMIT_MS) break;
            await wait(WAKE_NETWORK_RETRY_MS);
        }
        // 기다리는 사이 사용자가 감시를 멈췄거나, 다시 잠들었거나, 다른 깨어남이 이어받았으면 할 일이 없습니다.
        if (!current()) return;
        if (!online) {
            const message = "컴퓨터가 깨어난 뒤 1분이 지나도 인터넷에 연결되지 않아 감시를 멈췄습니다. 네트워크를 확인하고 감시를 다시 시작하세요.";
            logger.warn(message);
            this.deps.desktopNotice?.("Hamboogie 감시 중지", message);
            this.stopAndNotify();
            return;
        }
        if (slept > LONG_SLEEP_MS) {
            // 잠든 사이 올라온 글은 버립니다. 다음 확인에서 지금의 최신 글을 기준으로 다시 잡습니다.
            this.lastSeen.clear();
            logger.info(`${Math.round(slept / 60000)}분 동안 잠들어 있었으므로 그사이 글은 건너뛰고 기준 글을 새로 잡습니다.`);
        }
        logger.info("네트워크가 연결되어 감시를 이어갑니다.");
        this.sleep.end();
        for (const configId of this.watchers.keys()) this.schedule(configId, this.runId, 0);
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
        this.stopAndNotify();
        if (this.deps.settings().discordWebhookUrl) await this.notifier.send({title: "감시 자동 중지", description: "설정한 시각이 되어 감시를 멈췄습니다.", critical: true});
    }

    /** 감시를 멈추고 화면·트레이·잠자기 방지가 "멈춤"을 따르도록 알립니다(사용자가 아니라 앱이 스스로 멈출 때). */
    private stopAndNotify(): void {
        this.stop();
        this.deps.onStateChanged?.();
    }

    /** 감시하지 않는 이유(갤러리 설정 문제)를 로그에 남깁니다. */
    private warnProblems(prefix: string, gallery: GalleryConfig, problems: string[]): void {
        this.deps.logger.warn(`${prefix}: ${problems.join(" ")}`, {galleryId: gallery.galleryId || "(이름 없음)"});
    }

    /** 감시를 멈추고 예약해 둔 줄 서기도 취소합니다. 분석 중이던 글에도 댓글을 달지 않습니다. */
    stop(): void {
        const wasRunning = this.watchers.size > 0;
        // 잠자기에서 깨어나 네트워크를 기다리던 중이면 기다림을 끝냅니다.
        this.sleep.end();
        this.haltWatchers(true);
        this.epoch++;
        this.dispatcher.cancelAll();
        this.giveaways.clear();
        this.listFailures.clear();
        this.listFailureWarned.clear();
        this.startedAt = null;
        this.autoStop.clear();
        if (wasRunning) this.deps.logger.info("감시를 멈췄습니다.");
    }

    /**
     * 갤러리 하나의 감시를 뺍니다(갤러리를 끄거나 지운 경우). 마지막 갤러리였으면 감시가 끝난 것이므로 자동 중지를 풀고
     * 화면·트레이·잠자기 방지가 "멈춤"을 따르도록 알립니다.
     */
    private dropWatcher(configId: string): void {
        const timer = this.watchers.get(configId);
        if (timer) clearTimeout(timer);
        this.watchers.delete(configId);
        this.intervals.delete(configId);
        this.turns.delete(configId);
        this.statuses.delete(configId);
        this.giveaways.delete(configId);
        this.dropped.set(configId, (this.dropped.get(configId) ?? 0) + 1);
        if (this.watchers.size === 0) {
            this.startedAt = null;
            this.autoStop.clear();
            this.deps.logger.info("감시하는 갤러리가 없어 감시를 멈췄습니다.");
        }
        this.deps.onStateChanged?.();
    }

    /**
     * 감시 중에 저장한 갤러리 설정을 반영합니다. 새로 켜거나 추가한 갤러리는 바로 감시를 시작하고, 끄거나 지운 갤러리는 뺍니다.
     * 이미 감시 중인 갤러리는 그대로 두어(기준 글, 예약된 줄 서기 유지) 다시 시작할 필요가 없고, 감시 간격만 바뀌었으면
     * 기다리던 확인을 새 간격으로 다시 잡습니다.
     *
     * 추가를 먼저 합니다. 끄는 갤러리와 켜는 갤러리를 한 번에 저장했을 때 빼는 쪽을 먼저 하면 잠시 감시하는 갤러리가 0개가 되어
     * 감시가 끝난 것으로 처리되고(자동 중지가 풀림), 이어서 추가한 갤러리는 자동 중지 없이 감시하게 됩니다.
     */
    syncGalleries(): void {
        if (!this.running) return;
        const galleries = this.deps.settings().galleries;
        for (const gallery of galleries) {
            if (!gallery.enabled || this.watchers.has(gallery.id) || galleryProblems(gallery).length > 0) continue;
            this.deps.logger.info("감시에 추가했습니다.", {galleryId: gallery.galleryId});
            this.watch(gallery, 0);
        }
        for (const configId of [...this.watchers.keys()]) {
            const gallery = galleries.find((item) => item.id === configId);
            const problems = gallery?.enabled ? galleryProblems(gallery) : [];
            if (problems.length > 0) this.warnProblems("감시를 멈춤", gallery!, problems);
            if (!gallery || !gallery.enabled || problems.length > 0) {
                this.dropWatcher(configId);
            } else if (this.intervals.get(configId) !== gallery.intervalSec) {
                this.intervals.set(configId, gallery.intervalSec);
                // 실패가 이어져 늘려 둔 대기도 새 간격으로 다시 셉니다. 확인 중이면 끝난 뒤 새 간격으로 잡힙니다.
                this.listFailures.delete(configId);
                if (!this.checking.has(configId)) this.schedule(configId, this.runId, gallery.intervalSec * 1000);
            }
        }
        this.deps.onStateChanged?.();
    }

    /** 갤러리 감시를 시작합니다(첫 확인 예약). */
    private watch(gallery: GalleryConfig, delayMs: number): void {
        this.intervals.set(gallery.id, gallery.intervalSec);
        this.schedule(gallery.id, this.runId, delayMs);
    }

    /** @param forget 기준 글까지 잊습니다. 사용자가 감시를 멈출 때만 씁니다. */
    private haltWatchers(forget: boolean): void {
        this.runId++;
        for (const timer of this.watchers.values()) clearTimeout(timer);
        this.watchers.clear();
        this.intervals.clear();
        this.turns.clear();
        this.statuses.clear();
        if (forget) this.lastSeen.clear();
    }

    /** 진행 중인 LLM 판단과 밀린 알림이 모두 끝날 때까지 기다립니다. */
    async idle(): Promise<void> {
        while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
        await this.notifier.idle();
    }

    private track(work: Promise<void>): void {
        const tracked = work.catch((error) => this.deps.logger.error(`글 판단 중 오류: ${errorMessage(error)}`)).finally(() => this.inflight.delete(tracked));
        this.inflight.add(tracked);
    }

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

    /**
     * 갤러리 확인을 예약합니다. 갤러리마다 예약은 하나뿐입니다. 앞선 예약을 지우고 새 순번을 매겨, 잠자기 전에 걸어 둔 타이머나
     * 그때 진행 중이던 확인이 끝나며 다음 확인을 또 예약해 확인이 겹치는 일을 막습니다.
     */
    private schedule(configId: string, runId: number, delayMs: number): void {
        const previous = this.watchers.get(configId);
        if (previous) clearTimeout(previous);
        const turn = ++this.turnCounter;
        this.turns.set(configId, turn);
        const timer = setTimeout(() => void this.tick(configId, runId, turn), delayMs);
        this.watchers.set(configId, timer);
    }

    private gallery(configId: string): GalleryConfig | undefined {
        return this.deps.settings().galleries.find((item) => item.id === configId);
    }

    /** @param turn 예약 순번입니다. 이 갤러리의 마지막 예약이 아니면(지워진 예약) 아무것도 하지 않습니다. */
    private async tick(configId: string, runId: number, turn?: number): Promise<void> {
        if (turn !== undefined && this.turns.get(configId) !== turn) return;
        const gallery = this.gallery(configId);
        if (!gallery || !gallery.enabled || runId !== this.runId) {
            if (runId === this.runId) this.dropWatcher(configId);
            return;
        }
        // 잠들어 있거나 깨어나서 네트워크를 기다리는 중이면 확인하지 않습니다. 깨어나 네트워크가 붙으면 다시 예약합니다.
        if (this.sleep.asleep) return;
        // 이 갤러리의 앞선 확인이 아직 끝나지 않았으면(잠들기 전에 시작한 확인 등) 겹치지 않게 잠시 뒤에 다시 봅니다.
        if (this.checking.has(configId)) {
            this.schedule(configId, runId, CHECK_BUSY_RETRY_MS);
            return;
        }
        // 감시 중에 갤러리 ID를 바꿨는데 아직 확인하지 않았으면 그 갤러리 감시를 멈춥니다.
        const problems = galleryProblems(gallery);
        if (problems.length > 0) {
            this.warnProblems("감시를 멈춤", gallery, problems);
            this.dropWatcher(configId);
            return;
        }
        this.checking.add(configId);
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
                this.listFailureWarned.delete(configId);
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
            this.checking.delete(configId);
            // 설정이 바뀌었을 수 있으니 다음 간격은 최신 설정에서 읽습니다. 그사이 새로 예약됐으면(깨어남 등) 그 예약을 따릅니다.
            const latest = turn === undefined || this.turns.get(configId) === turn;
            if (runId === this.runId && latest && !this.sleep.asleep) {
                this.schedule(configId, runId, delayMs ?? this.intervalMs(configId, gallery));
            }
        }
    }

    /**
     * 차단 페이지나 서버 오류처럼 다시 해 봐도 같을 수 있는 실패가 이어지면, 다음 확인을 감시 간격의 2배, 4배…(최대 30분)로 늦춥니다.
     * 차단된 상태에서 요청을 계속 쌓지 않기 위해서입니다. 여러 번 이어지면 한 번 알립니다(보내지 못했으면 다음 실패 때 다시 보냅니다).
     */
    private async backOff(configId: string, gallery: GalleryConfig): Promise<number> {
        const failures = (this.listFailures.get(configId) ?? 0) + 1;
        this.listFailures.set(configId, failures);
        const intervalMs = this.intervalMs(configId, gallery);
        const delayMs = Math.min(intervalMs * 2 ** failures, Math.max(intervalMs, FAILURE_BACKOFF_MAX_MS));
        this.deps.logger.warn(`목록 확인이 ${failures}번 연달아 실패해 ${Math.round(delayMs / 1000)}초 뒤 다시 확인합니다.`, {galleryId: gallery.galleryId});
        if (failures >= FAILURE_ALERT_AFTER && !this.listFailureWarned.has(configId)) {
            this.listFailureWarned.add(configId);
            this.alertOnce("디시 목록 확인이 계속 실패합니다",
                `${gallery.galleryId} 갤러리 목록 확인이 ${failures}번 연달아 실패했습니다. 디시 접속이 막혔을 수 있습니다. 감시 간격을 늘려 다시 시도합니다.`,
                () => this.listFailureWarned.delete(configId));
        }
        return delayMs;
    }

    /** 감시 간격(ms)입니다. 설정이 바뀌었을 수 있으니 최신 설정에서 읽습니다. */
    private intervalMs(configId: string, gallery: GalleryConfig): number {
        return (this.gallery(configId)?.intervalSec ?? gallery.intervalSec) * 1000;
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
        const dropCount = this.dropped.get(gallery.id) ?? 0;
        // 확인하는 사이 감시를 다시 시작했거나 이 갤러리 감시를 껐으면 결과를 버립니다(상태가 되살아나거나 판단 요청을 쓰지 않게).
        const current = () => runId === this.runId && (this.dropped.get(gallery.id) ?? 0) === dropCount;
        const {collected, reachedLastSeen} = await this.collector.list(gallery, lastSeen);
        if (!current()) return;
        if (lastSeen !== undefined && !reachedLastSeen && collected.size > 0) {
            const oldest = Math.min(...collected.keys());
            if (oldest > lastSeen + 1) {
                logger.warn(`새 글이 너무 많아 ${MAX_PAGES_PER_TICK}페이지 밖의 글(#${lastSeen + 1}~#${oldest - 1})은 확인하지 못했습니다. 감시 간격을 줄여 보세요.`, {galleryId: gallery.galleryId});
            }
        }

        const status: GalleryStatus = {lastCheckedAt: this.now(), newPosts: 0, matched: 0, giveaways: this.giveaways.get(gallery.id)?.count ?? 0};
        const report = () => {
            // 이 확인을 하는 사이 앞 확인의 판단이 끝나 늘어난 수를 되돌리지 않도록 최신 누적 수로 맞춥니다.
            status.giveaways = this.giveaways.get(gallery.id)?.count ?? 0;
            this.statuses.set(gallery.id, status);
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
            report();
            return;
        }
        const posts = [...collected.values()].filter((post) => post.no > lastSeen).sort((a, b) => a.no - b.no);
        status.newPosts = posts.length;
        const epoch = this.epoch;
        try {
            const found = await this.collector.collect(gallery, posts, current);
            // 확인하는 사이 감시가 다시 시작됐거나 이 갤러리 감시를 껐으면 이 결과는 버립니다. 다음 확인에서 다시 봅니다.
            if (!found || !current()) return;
            if (found.last !== null) this.lastSeen.set(key, found.last);
            status.matched = found.candidates.filter((candidate) => candidate.keyword).length;
            // 판단은 따로 돌려, 분당 요청 한도를 기다리는 동안에도 목록 확인이 멈추지 않게 합니다.
            // 나눔으로 판단한 글은 감시를 시작한 뒤의 누적 수로 셉니다(그사이 감시를 멈췄으면 세지 않습니다).
            if (found.candidates.length > 0) {
                let counter = this.giveaways.get(gallery.id);
                if (!counter) this.giveaways.set(gallery.id, counter = {count: 0});
                this.track(this.judge.judgeAll(gallery, found.candidates, epoch, () => {
                    // 그사이 감시를 멈췄거나 이 갤러리 감시를 껐으면(누적 수를 새로 시작했으면) 세지 않습니다. 다시 켰을 때 예전 수가 되살아나지 않게 합니다.
                    if (epoch !== this.epoch || this.giveaways.get(gallery.id) !== counter) return;
                    counter.count++;
                    const latest = this.statuses.get(gallery.id);
                    if (latest) latest.giveaways = counter.count;
                    this.deps.onStateChanged?.();
                }));
            }
        } finally {
            if (current()) report();
        }
    }

    /** 무료 등급 하루 LLM 요청 수를 다 써서 감시를 쉰다고 한 번만 알립니다(보내지 못했으면 다음 확인 때 다시 보냅니다). */
    private async warnDailyLimit(): Promise<void> {
        if (this.dailyLimitWarned) return;
        this.dailyLimitWarned = true;
        const message = `무료 등급 하루 LLM 요청 수(${FREE_DAILY_LLM_REQUESTS}회)를 다 써서 한국 시간 ${kstClockText(this.llm.usage.resetAt)}까지 감시를 쉽니다. 감시 간격을 늘리면 하루에 더 오래 감시할 수 있고, 유료 요금제를 쓰면 이 제한이 없습니다.`;
        this.deps.logger.warn(message);
        this.alertOnce("감시 일시 중지: 하루 LLM 요청 수 소진", message, () => (this.dailyLimitWarned = false));
    }

    /** 이 계정이 로그인하는 중이거나, 일시적인 오류로 자동 재로그인을 기다린 지 얼마 안 됐는지입니다. */
    private recoveringLogin(accountId: string): boolean {
        const status = this.deps.accounts.status(accountId);
        if (status.state === "logging_in") return true;
        return status.state === "error" && status.failingSince !== undefined && this.now() - status.failingSince < LOGIN_RECOVERY_QUIET_MS;
    }

    /** 로그인된 계정이 없어 감시를 쉰다고 한 번만 알립니다(보내지 못했으면 다음 확인 때 다시 보냅니다). */
    private async warnNotLoggedIn(gallery: GalleryConfig): Promise<void> {
        if (this.notLoggedInWarned.has(gallery.id)) return;
        this.notLoggedInWarned.add(gallery.id);
        const message = "이 갤러리의 대기 계정 중 로그인된 계정이 없어 디시에 요청하지 않고 감시를 쉽니다. 계정 탭에서 로그인하면 이어서 확인합니다.";
        this.deps.logger.warn(message, {galleryId: gallery.galleryId});
        this.alertOnce(`감시 일시 중지: 로그인 필요 (${gallery.galleryId})`, message, () => this.notLoggedInWarned.delete(gallery.id));
    }

    /** 오늘 쓴 LLM 요청 수와 한도입니다. 화면에 보여줍니다. */
    llmUsage(): LlmUsageView {
        return this.llm.view();
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
                this.alertOnce("디시 로그인이 풀렸습니다", "글을 읽던 계정의 로그인이 풀렸습니다. 계정 탭에서 다시 로그인하세요.", () => {});
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
                this.alertOnce("디시 접속 불가: Hamboogie 업데이트 필요", OUTDATED_APP_MESSAGE, () => (this.outdatedNotified = false));
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

    /** 글 내용을 LLM으로 판단하고 행동 계획을 세웁니다. LLM 호출이 실패하면 알림 계획을 돌려줍니다. */
    analyze(gallery: GalleryConfig, title: string, body: string, detectedAt: number): Promise<Analysis> {
        return this.judge.analyze(gallery, title, body, detectedAt);
    }

    /** 계획대로 넘어가거나, 알리거나, 줄 서기를 예약합니다(`Dispatcher.dispatch`). */
    dispatch(gallery: GalleryConfig, post: NewPost, plan: Plan, options: {live?: Live; label?: string; content?: PostContent} = {}): Promise<void> {
        return this.dispatcher.dispatch(gallery, post, plan, options);
    }

    /**
     * 중요한 알림을 보내되 기다리지 않습니다. 감시 흐름(목록 확인, 글 모으기)이 알림 전송에 막히지 않게 하기 위해서입니다.
     * 보내지 못했으면 `onFailed`로 "이미 알림" 표시를 되돌려, 다음에 다시 보냅니다.
     */
    private alertOnce(title: string, description: string, onFailed: () => void): void {
        void this.notifier.send({title, description, critical: true}).then((result) => {
            if (result === "failed") onFailed();
        });
    }

    /** Discord로 알립니다. 글과 관련된 알림이면 글 링크를 붙입니다. 성공 알림이 아니면 중요한 알림으로 먼저 보냅니다. */
    alert(title: string, description: string, post?: {galleryId: string; postNo: number}, success = false, links?: DiscordNotice["links"]): Promise<NoticeResult> {
        return this.notifier.send({title, description, success, links, ...(post ? {post} : {}), critical: !success});
    }
}
