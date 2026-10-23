import type {DCInside, PostItem} from "@green-1052/dcinside.js";
import {errorMessage} from "@shared/errors";
import {effectiveRpm, galleryProblems, PROVIDER_LABELS} from "@shared/settings";
import type {GalleryConfig, GalleryStatus, HistoryEntry, Settings} from "@shared/types";
import {isAppIdFailure, isDefiniteCommentFailure, type AccountManager} from "../dc/accounts";
import type {AppIdBackoff} from "../dc/app-id-backoff";
import {isOutdatedAppError, OUTDATED_APP_MESSAGE, OUTDATED_PAUSE_MS} from "../dc/app-version";
import {htmlToText} from "../dc/text";
import type {Decision} from "../llm/decision";
import {createProvider, type LlmProvider} from "../llm/providers";
import {chunkForLimit, RateLimiter} from "../llm/rate-limit";
import type {Logger} from "../logger";
import {sendDiscordNotice} from "../notify/discord";
import type {Ledger, SecretStore} from "../store";
import {findKeyword, matchesKeywords} from "./keyword-filter";
import {eligible, END_MARGIN_MS, makePlan, type Plan} from "./planner";

/** 한 번 확인할 때 최대로 넘겨볼 목록 페이지 수입니다. */
const MAX_PAGES_PER_TICK = 3;

/** 골라내기를 미뤄 둘 때 갤러리마다 쌓아 둘 최대 글 수입니다. 넘으면 오래된 글부터 버립니다. */
const MAX_UNSCREENED = 200;

/** 골라내기를 이보다 오래 미루지 않습니다. 요청 자리가 모자라도 이만큼 기다린 글이 있으면 골라냅니다. */
const MAX_SCREEN_DEFER_MS = 2 * 60 * 1000;

/** 본문을 연달아 읽을 때 사이에 둘 간격입니다. 새 글이 많을 때 요청이 한꺼번에 몰리지 않게 합니다. */
const BODY_READ_GAP_MS = 500;

export interface NewPost {
    no: number;
    title: string;
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
    detectedAt: number;
}

export interface EngineDeps {
    /** 글을 읽을 클라이언트입니다. 로그인된 계정이 있으면 그 계정의 것을, 없으면 읽기용 클라이언트를 돌려줍니다. */
    reader(): DCInside;
    /** 목록을 읽는 데 성공했을 때 부릅니다(app_id가 유효함을 기록하고, 읽기용 기기 정보를 저장합니다). */
    onReadSucceeded(): Promise<void>;
    /** app_id 거절이 오래 이어질 때 글 읽는 쪽의 기기 정보를 새로 받습니다. */
    resetReader(): Promise<void>;
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
    /** 같은 서비스/모델/키라면 LLM 클라이언트를 다시 만들지 않습니다. */
    private provider: {key: string; instance: LlmProvider} | null = null;
    /** 갤러리와 상관없이 앱 전체의 LLM 요청 수를 셉니다. */
    private readonly limiter = new RateLimiter(() => effectiveRpm(this.deps.settings().llm));
    /** 요청 자리가 모자라 아직 골라내지 못한 글입니다. 다음 확인 때 함께 보냅니다. */
    private readonly unscreened = new Map<string, Candidate[]>();
    /** 다음 본문을 읽어도 되는 시각입니다. 갤러리 여러 개가 함께 읽어도 간격을 지킵니다. */
    private nextReadAt = 0;
    private readonly readGapMs = BODY_READ_GAP_MS;
    /** 앱 버전이 낮아 접속이 거절됐다고 이미 알렸는지입니다. */
    private outdatedNotified = false;
    /** 진행 중인 LLM 판단입니다. 목록 확인이 판단을 기다리지 않도록 따로 돌립니다. */
    private readonly inflight = new Set<Promise<void>>();

    constructor(private readonly deps: EngineDeps) {}

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
        this.haltWatchers(false);
        const keys = new Set(this.deps.settings().galleries.map((gallery) => this.seenKey(gallery)));
        for (const map of [this.lastSeen, this.unscreened]) {
            for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
        }
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
        if (this.watchers.size === 0) logger.warn("감시할 수 있는 갤러리가 없습니다.");
        else logger.info(`갤러리 ${this.watchers.size}개 감시를 시작합니다.`);
    }

    /** 감시를 멈추고 예약해 둔 줄 서기도 취소합니다. 분석 중이던 글에도 댓글을 달지 않습니다. */
    stop(): void {
        const wasRunning = this.watchers.size > 0;
        this.haltWatchers(true);
        this.epoch++;
        for (const [timer, pending] of this.scheduled) {
            clearTimeout(timer);
            this.deps.logger.warn("감시를 멈춰 예약된 줄 서기를 취소했습니다.", {galleryId: pending.gallery.galleryId, postNo: pending.post.no});
            this.record(pending.gallery, pending.post, "failure", "감시를 멈춰 예약된 줄 서기를 취소함", pending.test);
        }
        this.scheduled.clear();
        if (wasRunning) this.deps.logger.info("감시를 멈췄습니다.");
    }

    /** @param forget 기준 글과 미뤄 둔 골라내기까지 잊습니다. 사용자가 감시를 멈출 때만 씁니다. */
    private haltWatchers(forget: boolean): void {
        this.runId++;
        for (const timer of this.watchers.values()) clearTimeout(timer);
        this.watchers.clear();
        this.statuses.clear();
        if (forget) {
            this.lastSeen.clear();
            this.unscreened.clear();
        }
    }

    /** 진행 중인 LLM 판단이 모두 끝날 때까지 기다립니다. */
    async idle(): Promise<void> {
        while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    }

    private track(work: Promise<void>): void {
        const tracked = work.catch((error) => this.deps.logger.error(`글 판단 중 오류: ${errorMessage(error)}`)).finally(() => this.inflight.delete(tracked));
        this.inflight.add(tracked);
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
        // 감시 중에 갤러리 ID를 바꿨는데 아직 확인하지 않았으면 그 갤러리 감시를 멈춥니다.
        const problems = galleryProblems(gallery);
        if (problems.length > 0) {
            this.deps.logger.warn(`감시를 멈춤: ${problems.join(" ")}`, {galleryId: gallery.galleryId || "(이름 없음)"});
            this.watchers.delete(configId);
            this.deps.onStateChanged?.();
            return;
        }
        try {
            if (await this.deps.accounts.maintain(this.deps.settings().accounts)) this.deps.onStateChanged?.();
            // app_id 발급이 거절된 뒤에는 잠시 목록 확인을 쉽니다. 다시 시도해 봐야 거절만 늘어납니다.
            if (this.deps.appId.canTry()) await this.checkGallery(gallery, runId);
        } catch (error) {
            this.deps.logger.error(`목록 확인 실패: ${errorMessage(error)}`, {galleryId: gallery.galleryId});
            await this.recoverReader(error);
        } finally {
            // 설정이 바뀌었을 수 있으니 다음 간격은 최신 설정에서 읽습니다.
            if (runId === this.runId) this.schedule(configId, runId, (this.gallery(configId)?.intervalSec ?? gallery.intervalSec) * 1000);
        }
    }

    private seenKey(gallery: GalleryConfig): string {
        return `${gallery.id}\n${gallery.galleryId}`;
    }

    /**
     * 새 글을 확인합니다. 처음 확인할 때는 기준점만 잡습니다.
     *
     * 1. 오래된 순서로 글을 보며, 제목에 키워드가 있는 글과 본문 확인 대상인 글의 본문을 읽습니다.
     *    본문 확인은 갤러리의 본문 요청 상한까지만 하고(최신 글 우선), 나머지는 제목으로만 봅니다.
     *    app_id 거절로 글을 못 읽으면 거기서 멈추고, 그 글부터 다음에 다시 봅니다.
     * 2. 골라내기가 켜져 있으면 키워드에 걸리지 않은 글을 한 번에 묶어 LLM에 보내 나눔 글로 보이는 것을 더합니다.
     * 3. 키워드에 걸린 글을 LLM으로 판단합니다. 분당 요청 한도 안이면 글마다 따로, 넘으면 묶어서 보냅니다.
     */
    private async checkGallery(gallery: GalleryConfig, runId: number): Promise<void> {
        const {reader, logger} = this.deps;
        const key = this.seenKey(gallery);
        const lastSeen = this.lastSeen.get(key);
        const collected = new Map<number, NewPost>();
        let reachedLastSeen = false;

        for (let page = 1; page <= MAX_PAGES_PER_TICK; page++) {
            const response = await reader().articles.list({gallery: gallery.galleryId, page});
            this.deps.appId.succeed();
            await this.deps.onReadSucceeded();
            const items = (response.gall_list ?? []).filter((item: PostItem) => typeof item.no === "number" && !item.fixtop);
            for (const item of items) collected.set(item.no!, {no: item.no!, title: item.subject ?? ""});
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
            const newest = Math.max(0, ...collected.keys());
            this.lastSeen.set(key, newest);
            logger.info(`감시 시작. 기준 글 #${newest} 이후의 새 글만 확인합니다.`, {galleryId: gallery.galleryId});
            report(0, 0);
            return;
        }
        const posts = [...collected.values()].filter((post) => post.no > lastSeen).sort((a, b) => a.no - b.no);
        const epoch = this.epoch;
        let matched = 0;
        try {
            const found = await this.collect(gallery, posts, runId, epoch);
            // 확인하는 사이 감시가 다시 시작됐으면 이 결과는 버립니다. 다음 확인에서 다시 봅니다.
            if (!found || runId !== this.runId) return;
            matched = found.notified;
            if (found.last !== null) this.lastSeen.set(key, found.last);
            const candidates = [...found.matched];
            const budget = this.tickBudget(gallery);
            let decisionSlots = budget;
            if (gallery.screenUnmatched) {
                const pending = this.queueForScreening(gallery, key, found.unmatched);
                const waitedTooLong = pending.length > 0 && Date.now() - pending[0]!.detectedAt > MAX_SCREEN_DEFER_MS;
                // 요청 한 자리는 골라내기 몫입니다. 한 번에 한 자리뿐이면 키워드에 걸린 글을 먼저 판단하고 골라내기는 미루되,
                // 너무 오래 미룬 글이 있으면 골라냅니다.
                if (pending.length > 0 && (budget >= 2 || candidates.length === 0 || waitedTooLong)) {
                    this.unscreened.delete(key);
                    decisionSlots = Math.max(1, budget - 1);
                    const picked = await this.screen(gallery, pending);
                    if (runId !== this.runId) return;
                    if (picked) candidates.push(...await this.withBodies(gallery, picked, found.reads));
                    // 골라내기가 실패하면 다음 확인 때 다시 보냅니다.
                    else this.queueForScreening(gallery, key, pending);
                }
            }
            matched += candidates.length;
            // 판단은 따로 돌려, 분당 요청 한도를 기다리는 동안에도 목록 확인이 멈추지 않게 합니다.
            if (candidates.length > 0) this.track(this.decideAll(gallery, candidates.sort((a, b) => a.post.no - b.post.no), epoch, decisionSlots));
        } finally {
            report(posts.length, matched);
        }
    }

    /** 골라낼 글을 미뤄 둔 글 뒤에 붙여 두고 전체를 돌려줍니다. 너무 많으면 오래된 글부터 버리고 로그를 남깁니다. */
    private queueForScreening(gallery: GalleryConfig, key: string, posts: Candidate[]): Candidate[] {
        const merged = [...(this.unscreened.get(key) ?? []), ...posts];
        const dropped = merged.length - MAX_UNSCREENED;
        if (dropped > 0) this.deps.logger.warn(`골라내기를 기다리는 글이 너무 많아 오래된 글 ${dropped}개는 골라내지 않고 넘깁니다.`, {galleryId: gallery.galleryId});
        const kept = merged.slice(-MAX_UNSCREENED);
        if (kept.length > 0) this.unscreened.set(key, kept);
        return kept;
    }

    /**
     * 골라낸 글 가운데 본문을 읽지 않은 글은 판단 전에 본문을 읽습니다. 제목만 보고 판단하면 본문의 줄 조건을 놓칩니다.
     * 지금 읽을 수 없거나, 지워졌거나, 본문에 제외 키워드가 있는 글은 뺍니다.
     * 이번 확인에서 이미 읽은 본문(`readSoFar`)과 합쳐 본문 요청 상한을 넘지 않게 하고, 넘는 글은 넘깁니다.
     * 글 하나가 LLM을 속여 많은 글을 고르게 하더라도 디시 요청이 상한을 넘지 않게 하기 위해서입니다.
     */
    private async withBodies(gallery: GalleryConfig, picked: Candidate[], readSoFar: number): Promise<Candidate[]> {
        const result: Candidate[] = [];
        let remaining = gallery.bodyReadLimit === 0 ? Infinity : Math.max(0, gallery.bodyReadLimit - readSoFar);
        let skipped = 0;
        for (const candidate of picked) {
            if (candidate.bodyRead) {
                result.push(candidate);
                continue;
            }
            if (remaining <= 0) {
                skipped++;
                continue;
            }
            remaining--;
            const context = {galleryId: gallery.galleryId, postNo: candidate.post.no};
            if (!this.deps.appId.canTry()) {
                this.deps.logger.warn("앱 인증 대기 중이라 골라낸 글의 본문을 읽지 못해 넘어감", context);
                continue;
            }
            try {
                await this.paceRead();
                const article = await this.deps.reader().articles.read(gallery.galleryId, candidate.post.no);
                const body = htmlToText(article.view_main?.memo ?? "");
                const excluded = this.excludedBy(gallery, body);
                if (excluded) {
                    this.deps.logger.info(`넘어감: 본문에 제외 키워드 "${excluded}"`, context);
                    continue;
                }
                result.push({...candidate, title: article.view_info?.subject ?? candidate.title, body, bodyRead: true});
            } catch (error) {
                if (isAppIdFailure(error)) await this.recoverReader(error);
                this.deps.logger.warn(`골라낸 글의 본문을 읽지 못해 넘어감: ${errorMessage(error)}`, context);
            }
        }
        if (skipped > 0) {
            this.deps.logger.warn(`골라낸 글 ${skipped}개는 본문 요청 상한(${gallery.bodyReadLimit}개)을 넘어 판단하지 않고 넘깁니다.`, {galleryId: gallery.galleryId});
        }
        return result;
    }

    /**
     * 새 글을 오래된 순서로 보며 키워드에 걸린 글과 걸리지 않은 글로 나눕니다. 감시가 다시 시작되면 null입니다.
     * `last`는 끝까지 본 마지막 글 번호이고, `notified`는 본문을 읽지 못해 바로 알린 글 수입니다.
     */
    private async collect(gallery: GalleryConfig, posts: NewPost[], runId: number, epoch: number) {
        const {ledger, logger} = this.deps;
        const fresh = posts.filter((post) => !ledger.has(gallery.galleryId, post.no));
        const titleMatched = new Set(fresh.filter((post) => matchesKeywords(post.title, gallery.keywords)).map((post) => post.no));
        // 키워드가 비어 있으면 모든 글이 판단 대상이라, 본문 요청 상한을 모든 글에 적용합니다.
        // 그렇지 않으면 제목에 키워드가 있는 글은 늘 열고, 상한은 나머지 글에만 적용합니다.
        const noKeywords = gallery.keywords.length === 0;
        const others = fresh.filter((post) => (noKeywords || !titleMatched.has(post.no)) && !this.excludedBy(gallery, post.title));
        // 상한을 넘으면 최근 글부터 본문을 엽니다. 오래된 글일수록 이미 마감됐을 가능성이 큽니다.
        const limit = gallery.bodyReadLimit;
        const scanning = gallery.scanBody || noKeywords;
        const scanned = !scanning ? [] : limit === 0 ? others : others.slice(-limit);
        const scan = new Set(scanned.map((post) => post.no));
        if (scanning && scanned.length < others.length) {
            logger.info(`새 글 ${others.length}개 중 최근 ${scanned.length}개만 본문을 확인하고, 나머지는 제목으로만 판단합니다. (본문 요청 상한 ${limit}개)`, {galleryId: gallery.galleryId});
        }

        const result = {matched: [] as Candidate[], unmatched: [] as Candidate[], last: null as number | null, notified: 0, reads: 0};
        for (const post of posts) {
            if (runId !== this.runId) return null;
            const matchedByTitle = titleMatched.has(post.no);
            const read = noKeywords ? scan.has(post.no) : matchedByTitle || scan.has(post.no);
            const outcome = await this.inspect(gallery, post, matchedByTitle, read, epoch);
            // 본문 요청 상한에 드는 읽기만 셉니다(키워드가 있으면 제목에 키워드가 있는 글은 상한과 상관없이 엽니다).
            if (read && (noKeywords || !matchedByTitle) && outcome !== "retry") result.reads++;
            if (outcome === "retry") break;
            if (outcome === "notified") result.notified++;
            else if (outcome !== "done") result[outcome.kind].push(outcome.candidate);
            result.last = post.no;
        }
        return result;
    }

    /**
     * 글 하나를 봅니다. `read`이면 본문을 읽고, 아니면 제목으로만 봅니다.
     * 지금은 읽을 수 없어 다음에 다시 봐야 하면 "retry", 읽지 못해 바로 알렸으면 "notified"입니다.
     */
    private async inspect(gallery: GalleryConfig, post: NewPost, titleMatched: boolean, read: boolean, epoch: number):
        Promise<"done" | "retry" | "notified" | {kind: "matched" | "unmatched"; candidate: Candidate}> {
        const {ledger, logger} = this.deps;
        if (ledger.has(gallery.galleryId, post.no)) return "done";
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const excludedByTitle = this.excludedBy(gallery, post.title);
        if (excludedByTitle) {
            if (titleMatched) logger.info(`넘어감: 제목에 제외 키워드 "${excludedByTitle}"`, context);
            return "done";
        }
        const detectedAt = Date.now();
        if (!read) {
            const candidate = {post, title: post.title, body: "", bodyRead: false, detectedAt};
            if (titleMatched) {
                logger.info(`키워드 일치(본문 요청 상한을 넘어 제목으로만 판단): "${post.title}"`, context);
                return {kind: "matched", candidate};
            }
            return gallery.screenUnmatched ? {kind: "unmatched", candidate} : "done";
        }
        if (!this.deps.appId.canTry()) return "retry";

        await this.paceRead();
        let title = post.title;
        let body: string;
        try {
            const article = await this.deps.reader().articles.read(gallery.galleryId, post.no);
            title = article.view_info?.subject ?? post.title;
            body = htmlToText(article.view_main?.memo ?? "");
        } catch (error) {
            // 금방 지워진 글은 알릴 필요가 없습니다.
            if (/삭제했거나 존재하지 않는/.test(errorMessage(error))) {
                if (titleMatched) logger.info("넘어감: 삭제된 글", context);
                return "done";
            }
            // app_id 거절이면 잠시 쉬고 이 글부터 다음에 다시 봅니다. 알리거나 처리한 글로 남기지 않습니다.
            if (isAppIdFailure(error)) {
                await this.recoverReader(error);
                return "retry";
            }
            // 제목에 키워드가 있던 글만 알립니다. 본문을 확인하려던 일반 글까지 알리면 알림이 넘칩니다.
            if (!titleMatched) {
                logger.warn(`본문을 읽지 못해 넘어감: ${errorMessage(error)}`, context);
                return "done";
            }
            await this.dispatch(gallery, post, {kind: "notify", reason: `글 분석 실패: ${errorMessage(error)}`}, {live: {epoch}});
            return "notified";
        }

        const excludedByBody = this.excludedBy(gallery, body);
        if (excludedByBody) {
            if (titleMatched) logger.info(`넘어감: 본문에 제외 키워드 "${excludedByBody}"`, context);
            return "done";
        }
        const candidate = {post, title, body, bodyRead: true, detectedAt};
        const bodyKeyword = titleMatched ? null : findKeyword(body, gallery.keywords);
        if (!titleMatched && !bodyKeyword) return gallery.screenUnmatched ? {kind: "unmatched", candidate} : "done";
        logger.info(bodyKeyword ? `본문 키워드 "${bodyKeyword}" 일치: "${title}"` : `키워드 일치: "${title}"`, context);
        return {kind: "matched", candidate};
    }

    /** 본문 읽기 사이에 간격을 둡니다. */
    private async paceRead(): Promise<void> {
        const now = Date.now();
        const wait = this.nextReadAt - now;
        this.nextReadAt = Math.max(now, this.nextReadAt) + this.readGapMs;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }

    /** 키워드에 걸리지 않은 글을 한 번에 묶어 LLM에 보내, 나눔 글로 보이는 것만 돌려줍니다. 실패하면 로그를 남기고 null입니다. */
    private async screen(gallery: GalleryConfig, candidates: Candidate[]): Promise<Candidate[] | null> {
        const {logger} = this.deps;
        try {
            const provider = this.llm();
            await this.slot(gallery);
            const picked = (await provider.screen(candidates)).map((index) => candidates[index]!);
            for (const candidate of picked) logger.info(`LLM이 키워드 없는 글을 나눔 글로 골라냄: "${candidate.title}"`, {galleryId: gallery.galleryId, postNo: candidate.post.no});
            return picked;
        } catch (error) {
            logger.warn(`키워드에 걸리지 않은 글 ${candidates.length}개를 골라내지 못해 다음 확인 때 다시 보냅니다: ${errorMessage(error)}`, {galleryId: gallery.galleryId});
            return null;
        }
    }

    /**
     * 글들을 LLM으로 판단하고 바로 처리합니다. 이번에 쓸 수 있는 요청 수(`slots`, 최근 1분 동안 남은 수를 넘지 않음) 안이면
     * 글마다 따로 보내고, 넘으면 그 수만큼으로 묶어 보냅니다. 묶음마다 응답이 오는 대로 처리합니다.
     */
    private async decideAll(gallery: GalleryConfig, candidates: Candidate[], epoch: number, slots: number): Promise<void> {
        if (candidates.length === 0) return;
        let provider: LlmProvider;
        try {
            provider = this.llm();
        } catch (error) {
            for (const candidate of candidates) {
                await this.dispatch(gallery, candidate.post, {kind: "notify", reason: `글 분석 실패: ${errorMessage(error)}`}, {live: {epoch}});
            }
            return;
        }
        const usable = Math.min(slots, this.limiter.available());
        const groups = chunkForLimit(candidates, Number.isFinite(usable) ? Math.max(1, usable) : 0);
        if (groups.length < candidates.length) {
            this.deps.logger.info(`판단할 글 ${candidates.length}개를 LLM 요청 ${groups.length}번으로 묶어 보냅니다.`, {galleryId: gallery.galleryId});
        }
        const decideOne = async (candidate: Candidate): Promise<{decision: Decision | null; failure: string}> => {
            try {
                await this.slot(gallery);
                return {decision: await provider.decide(candidate), failure: ""};
            } catch (error) {
                return {decision: null, failure: errorMessage(error)};
            }
        };
        await Promise.all(groups.map(async (group) => {
            let results: {decision: Decision | null; failure: string}[];
            if (group.length === 1) {
                results = [await decideOne(group[0]!)];
            } else {
                try {
                    await this.slot(gallery);
                    results = (await provider.decideMany(group)).map((decision) => ({decision, failure: "LLM 응답에 이 글의 판단이 빠져 있음"}));
                } catch (error) {
                    results = group.map(() => ({decision: null, failure: errorMessage(error)}));
                }
                // 묶어 보낸 글끼리는 한 글이 다른 글의 판단을 바꾸도록 꾸밀 수 있습니다. 나눔이라는 판단은 그 글만 따로 다시 물어 확인하고,
                // 지금 남은 요청 자리가 없으면 기다리지 않고(선착순을 놓치지 않게) 자동으로 서지 않고 알립니다.
                for (const [index, candidate] of group.entries()) {
                    if (!results[index]!.decision?.is_giveaway) continue;
                    results[index] = this.limiter.available() > 0
                        ? await decideOne(candidate)
                        : {decision: null, failure: "여러 글을 묶어 판단한 결과라 따로 확인해야 하는데 남은 LLM 요청이 없어, 직접 확인이 필요함"};
                }
                // 묶음 응답이 실패했거나 빠진 글은, 지금 남은 요청 수로 감당되면 하나씩 다시 물어봅니다.
                const missing = group.filter((_, index) => !results[index]!.decision);
                if (missing.length > 0 && missing.length <= this.limiter.available()) {
                    for (const [index, candidate] of group.entries()) {
                        if (!results[index]!.decision) results[index] = await decideOne(candidate);
                    }
                }
            }
            for (const [index, candidate] of group.entries()) {
                const {decision, failure} = results[index]!;
                const plan: Plan = decision ? this.planFor(gallery, decision, candidate) : {kind: "notify", reason: `글 분석 실패: ${failure}`};
                await this.dispatch(gallery, candidate.post, plan, {live: {epoch}});
            }
        }));
    }

    /**
     * 한 번 확인할 때 쓸 LLM 요청 수입니다. 분당 한도를 감시 중인 갤러리들의 1분당 확인 횟수로 나눕니다.
     * 감시 간격이 1분 이상인 갤러리 하나면 한도를 다 쓰고, 30초면 절반, 여러 갤러리면 그만큼 나눕니다. 최소 1입니다.
     * 제한이 없으면 Infinity입니다.
     */
    private tickBudget(gallery: GalleryConfig): number {
        const settings = this.deps.settings();
        const rpm = effectiveRpm(settings.llm);
        if (rpm <= 0) return Infinity;
        const watched = settings.galleries.filter((item) => item.enabled && (this.watchers.has(item.id) || item.id === gallery.id));
        const checksPerMinute = watched.reduce((sum, item) => sum + Math.max(1, 60 / item.intervalSec), 0);
        return Math.max(1, Math.floor(rpm / Math.max(1, checksPerMinute)));
    }

    /** 분당 요청 한도 안에서 LLM 요청 자리를 하나 받습니다. 한도에 닿았으면 로그를 남기고 기다립니다. */
    private async slot(gallery?: GalleryConfig): Promise<void> {
        if (this.limiter.available() === 0) {
            const limit = effectiveRpm(this.deps.settings().llm);
            this.deps.logger.info(`LLM 분당 요청 한도(${limit}회)에 닿아 잠시 기다립니다.`, gallery ? {galleryId: gallery.galleryId} : undefined);
        }
        await this.limiter.acquire();
    }

    private planFor(gallery: GalleryConfig, decision: Decision, candidate: {title: string; body: string; bodyRead?: boolean; detectedAt: number}): Plan {
        const settings = this.deps.settings();
        const accounts = this.deps.accounts.candidates(settings.accounts, gallery.accountIds);
        const plan = makePlan(decision, gallery, accounts, candidate.detectedAt, `${candidate.title}\n${candidate.body}`);
        // 본문을 읽지 않은 글은 본문에 봇 색출 문구나 다른 조건이 있어도 알 수 없으므로, 자동으로 서지 않고 알립니다.
        if (plan.kind === "comment" && candidate.bodyRead === false) {
            return {kind: "notify", reason: "본문 요청 상한을 넘어 본문을 확인하지 못했습니다. 글을 직접 확인하세요."};
        }
        return plan;
    }

    /**
     * app_id 발급이 거절됐으면 잠시 목록 확인을 쉽니다.
     * 거절이 오래 이어질 때만 읽기용 기기 정보를 새로 받습니다.
     */
    private async recoverReader(error: unknown): Promise<void> {
        if (!isAppIdFailure(error)) return;
        const outdated = isOutdatedAppError(error);
        const pauseMs = outdated ? OUTDATED_PAUSE_MS : this.deps.appId.pauseMs;
        const minutes = Math.round(pauseMs / 60000);
        const needsFreshDevice = this.deps.appId.fail(pauseMs);
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
        await this.deps.resetReader();
    }

    /** 제외 키워드가 들어 있으면 그 키워드를 돌려줍니다. */
    excludedBy(gallery: GalleryConfig, text: string): string | null {
        return findKeyword(text, gallery.excludeKeywords ?? []);
    }

    /** 글 내용을 LLM으로 판단하고 행동 계획을 세웁니다. LLM 호출이 실패하면 알림 계획을 돌려줍니다. */
    async analyze(gallery: GalleryConfig, title: string, body: string, detectedAt: number): Promise<Analysis> {
        try {
            const provider = this.llm();
            await this.slot(gallery);
            const decision = await provider.decide({title, body});
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

    /** 지금 설정의 LLM 클라이언트입니다. API 키가 없으면 오류를 던집니다. */
    private llm(): LlmProvider {
        const {llm} = this.deps.settings();
        const apiKey = this.deps.secrets.get(`llm:${llm.provider}`);
        if (!apiKey) throw new Error(`${PROVIDER_LABELS[llm.provider]} API 키가 설정되지 않았습니다.`);
        const model = llm.models[llm.provider];
        const key = `${llm.provider}\n${model}\n${apiKey}`;
        if (this.provider?.key !== key) this.provider = {key, instance: createProvider(llm.provider, apiKey, model)};
        return this.provider.instance;
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
                if (this.deps.settings().notifyOnSuccess) await this.alert(`${prefix}줄 서기 성공: ${post.title}`, summary, context, true);
                return;
            }
            const message = `${nickname}: ${errorMessage(failure)}`;
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
