import type {DCInside, PostItem} from "@green-1052/dcinside.js";
import {galleryProblems, PROVIDER_LABELS} from "@shared/settings";
import type {GalleryConfig, Settings} from "@shared/types";
import {isAppIdFailure, type AccountManager} from "../dc/accounts";
import {AppIdBackoff} from "../dc/app-id-backoff";
import {htmlToText} from "../dc/text";
import type {Decision} from "../llm/decision";
import {createProvider, type LlmProvider} from "../llm/providers";
import type {Logger} from "../logger";
import {sendDiscordNotice} from "../notify/discord";
import type {Ledger, SecretStore} from "../store";
import {findKeyword, matchesKeywords} from "./keyword-filter";
import {makePlan, type Plan} from "./planner";

/** 한 번 확인할 때 최대로 넘겨볼 목록 페이지 수입니다. */
const MAX_PAGES_PER_TICK = 3;

export interface NewPost {
    no: number;
    title: string;
}

export interface Analysis {
    /** LLM 판단입니다. 분석이 실패하면 null입니다. */
    decision: Decision | null;
    plan: Plan;
}

export interface EngineDeps {
    /** 글 읽기 전용 클라이언트입니다. `resetReader` 뒤에는 새 클라이언트를 돌려줍니다. */
    reader(): DCInside;
    onReaderReady(): Promise<void>;
    /** 읽기용 기기 정보를 버리고 새 클라이언트를 만듭니다. */
    resetReader(): Promise<void>;
    accounts: AccountManager;
    ledger: Ledger;
    secrets: SecretStore;
    logger: Logger;
    settings(): Settings;
    /** 계정 상태가 바뀌었을 때(디시콘을 다시 불러온 경우 등) 화면을 갱신합니다. */
    onAccountsChanged?(): void;
}

function postUrl(galleryId: string, postNo: number): string {
    return `https://m.dcinside.com/board/${galleryId}/${postNo}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 갤러리 감시, 글 분석, 줄 서기를 실행합니다. */
export class Engine {
    private readonly watchers = new Map<string, ReturnType<typeof setTimeout>>();
    /** 예약된 줄 서기입니다. 취소되면 처리 기록을 되돌리기 위해 글 정보를 같이 둡니다. */
    private readonly scheduled = new Map<ReturnType<typeof setTimeout>, {galleryId: string; postNo: number; useLedger: boolean}>();
    private readonly lastSeen = new Map<string, number>();
    private readerReady = false;
    /** 읽기용 클라이언트의 app_id 발급이 거절됐을 때 목록 확인을 쉬는 규칙입니다. */
    private readonly readerAppId: AppIdBackoff;
    private runId = 0;
    /** 같은 서비스/모델/키라면 LLM 클라이언트를 다시 만들지 않습니다. */
    private provider: {key: string; instance: LlmProvider} | null = null;

    constructor(private readonly deps: EngineDeps, now: () => number = Date.now) {
        this.readerAppId = new AppIdBackoff(now);
    }

    get running(): boolean {
        return this.watchers.size > 0;
    }

    get watching(): number {
        return this.watchers.size;
    }

    /** 감시를 시작합니다. 시작할 수 없는 갤러리는 로그에 이유를 남기고 건너뜁니다. */
    start(): void {
        this.stop();
        const runId = ++this.runId;
        const {logger} = this.deps;
        for (const gallery of this.deps.settings().galleries) {
            if (!gallery.enabled) continue;
            const problems = galleryProblems(gallery);
            if (problems.length > 0) {
                logger.warn(`감시하지 않음: ${problems.join(" ")}`, {galleryId: gallery.galleryId || "(이름 없음)"});
                continue;
            }
            this.schedule(gallery.id, runId, 0);
        }
        for (const gallery of this.deps.settings().galleries) {
            if (!this.watchers.has(gallery.id)) continue;
            if (this.deps.accounts.candidates(this.deps.settings().accounts, gallery.accountIds).length === 0) {
                logger.warn("로그인된 대기 계정이 없습니다. 이대로면 나눔 글을 찾아도 줄을 설 수 없습니다.", {galleryId: gallery.galleryId});
            }
        }
        if (this.watchers.size === 0) logger.warn("감시할 수 있는 갤러리가 없습니다.");
        else logger.info(`갤러리 ${this.watchers.size}개 감시를 시작합니다.`);
    }

    stop(): void {
        this.runId++;
        for (const timer of this.watchers.values()) clearTimeout(timer);
        // 실행되지 못한 줄 서기는 처리 기록을 되돌려, 다시 감시할 때 같은 글을 다시 볼 수 있게 합니다.
        for (const [timer, pending] of this.scheduled) {
            clearTimeout(timer);
            if (pending.useLedger) this.deps.ledger.release(pending.galleryId, pending.postNo);
            this.deps.logger.warn("예약된 줄 서기를 취소했습니다.", {galleryId: pending.galleryId, postNo: pending.postNo});
        }
        if (this.watchers.size > 0) this.deps.logger.info("감시를 멈췄습니다.");
        this.watchers.clear();
        this.scheduled.clear();
        this.lastSeen.clear();
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
            this.watchers.delete(configId);
            return;
        }
        if (await this.deps.accounts.maintain(this.deps.settings().accounts)) this.deps.onAccountsChanged?.();
        // app_id 발급이 거절된 뒤에는 잠시 목록 확인을 쉽니다. 다시 시도해 봐야 거절만 늘어납니다.
        if (!this.readerAppId.canTry()) {
            this.schedule(configId, runId, (this.gallery(configId)?.intervalSec ?? gallery.intervalSec) * 1000);
            return;
        }
        try {
            const posts = await this.fetchNewPosts(gallery);
            this.readerAppId.succeed();
            for (const post of posts) {
                if (runId !== this.runId) return;
                await this.handlePost(gallery, post);
            }
        } catch (error) {
            this.deps.logger.error(`목록 확인 실패: ${errorMessage(error)}`, {galleryId: gallery.galleryId});
            await this.recoverReader(error);
        }
        // 설정이 바뀌었을 수 있으니 다음 간격은 최신 설정에서 읽습니다.
        if (runId === this.runId) this.schedule(configId, runId, (this.gallery(configId)?.intervalSec ?? gallery.intervalSec) * 1000);
    }

    /** 마지막으로 본 글보다 새 글을 오래된 순서로 돌려줍니다. 처음 확인할 때는 기준점만 잡습니다. */
    private async fetchNewPosts(gallery: GalleryConfig): Promise<NewPost[]> {
        const {reader, logger} = this.deps;
        const lastSeen = this.lastSeen.get(gallery.id);
        const collected = new Map<number, NewPost>();

        for (let page = 1; page <= MAX_PAGES_PER_TICK; page++) {
            const response = await reader().articles.list({gallery: gallery.galleryId, page});
            if (!this.readerReady) {
                this.readerReady = true;
                await this.deps.onReaderReady();
            }
            const items = (response.gall_list ?? []).filter((item: PostItem) => typeof item.no === "number" && !item.fixtop);
            for (const item of items) collected.set(item.no!, {no: item.no!, title: item.subject ?? ""});
            // 첫 확인이거나, 이번 페이지에 이미 본 글이 있으면 더 넘기지 않습니다.
            if (lastSeen === undefined || items.length === 0 || items.some((item) => item.no! <= lastSeen)) break;
        }

        const newest = Math.max(lastSeen ?? 0, ...collected.keys());
        this.lastSeen.set(gallery.id, newest);
        if (lastSeen === undefined) {
            logger.info(`감시 시작. 기준 글 #${newest} 이후의 새 글만 확인합니다.`, {galleryId: gallery.galleryId});
            return [];
        }
        return [...collected.values()].filter((post) => post.no > lastSeen).sort((a, b) => a.no - b.no);
    }

    private async handlePost(gallery: GalleryConfig, post: NewPost): Promise<void> {
        const {ledger, logger} = this.deps;
        if (ledger.has(gallery.galleryId, post.no)) return;
        if (!matchesKeywords(post.title, gallery.keywords)) return;
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const excludedByTitle = this.excludedBy(gallery, post.title);
        if (excludedByTitle) {
            logger.info(`넘어감: 제목에 제외 키워드 "${excludedByTitle}"`, context);
            return;
        }

        logger.info(`키워드 일치: "${post.title}"`, context);
        const detectedAt = Date.now();
        let analysis: Analysis;
        try {
            const article = await this.deps.reader().articles.read(gallery.galleryId, post.no);
            const title = article.view_info?.subject ?? post.title;
            const body = htmlToText(article.view_main?.memo ?? "");
            const excludedByBody = this.excludedBy(gallery, body);
            if (excludedByBody) {
                logger.info(`넘어감: 본문에 제외 키워드 "${excludedByBody}"`, context);
                return;
            }
            analysis = await this.analyze(gallery, title, body, detectedAt);
        } catch (error) {
            // 금방 지워진 글은 알릴 필요가 없습니다.
            if (/삭제했거나 존재하지 않는/.test(errorMessage(error))) {
                logger.info("넘어감: 삭제된 글", {galleryId: gallery.galleryId, postNo: post.no});
                return;
            }
            analysis = {decision: null, plan: {kind: "notify", reason: `글 분석 실패: ${errorMessage(error)}`}};
            await this.recoverReader(error);
        }
        await this.dispatch(gallery, post, analysis.plan);
    }

    /**
     * 읽기용 클라이언트의 app_id 발급이 거절됐으면 잠시 목록 확인을 쉽니다.
     * 거절이 오래 이어질 때만 기기 정보를 새로 받습니다.
     */
    private async recoverReader(error: unknown): Promise<void> {
        if (!isAppIdFailure(error)) return;
        const minutes = Math.round(this.readerAppId.pauseMs / 60000);
        if (!this.readerAppId.fail()) {
            this.deps.logger.warn(`디시 앱 인증(app_id) 발급이 거절되어 ${minutes}분 동안 목록 확인을 쉽니다.`);
            return;
        }
        this.deps.logger.warn(`디시 앱 인증(app_id) 거절이 오래 이어져 읽기용 기기 정보를 새로 받습니다. ${minutes}분 뒤 다시 확인합니다.`);
        this.readerReady = false;
        await this.deps.resetReader();
    }

    /** 제외 키워드가 들어 있으면 그 키워드를 돌려줍니다. */
    excludedBy(gallery: GalleryConfig, text: string): string | null {
        return findKeyword(text, gallery.excludeKeywords ?? []);
    }

    /** 글 내용을 LLM으로 판단하고 행동 계획을 세웁니다. LLM 호출이 실패하면 알림 계획을 돌려줍니다. */
    async analyze(gallery: GalleryConfig, title: string, body: string, detectedAt: number): Promise<Analysis> {
        try {
            const decision = await this.decide(title, body);
            const settings = this.deps.settings();
            const candidates = this.deps.accounts.candidates(settings.accounts, gallery.accountIds);
            return {decision, plan: makePlan(decision, gallery, candidates, detectedAt)};
        } catch (error) {
            return {decision: null, plan: {kind: "notify", reason: `글 분석 실패: ${errorMessage(error)}`}};
        }
    }

    /**
     * 계획대로 넘어가거나, 알리거나, 줄 서기를 예약합니다.
     *
     * @param options.useLedger false면 처리한 글 기록을 보지도 남기지도 않습니다. 개발 모드 테스트 전용입니다.
     * @param options.label 로그와 알림 앞에 붙일 표시입니다.
     */
    async dispatch(gallery: GalleryConfig, post: NewPost, plan: Plan, options: {useLedger?: boolean; label?: string} = {}): Promise<void> {
        const {ledger, logger} = this.deps;
        const useLedger = options.useLedger ?? true;
        const label = options.label ? `${options.label} ` : "";
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const claim = () => !useLedger || ledger.claim(gallery.galleryId, post.no);

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
                    void this.execute(gallery, post, plan, label);
                }, waitMs);
                this.scheduled.set(timer, {galleryId: gallery.galleryId, postNo: post.no, useLedger});
            }
        }
    }

    private async decide(title: string, body: string) {
        const {llm} = this.deps.settings();
        const apiKey = this.deps.secrets.get(`llm:${llm.provider}`);
        if (!apiKey) throw new Error(`${PROVIDER_LABELS[llm.provider]} API 키가 설정되지 않았습니다.`);
        const model = llm.models[llm.provider];
        const key = `${llm.provider}\n${model}\n${apiKey}`;
        if (this.provider?.key !== key) this.provider = {key, instance: createProvider(llm.provider, apiKey, model)};
        return this.provider.instance.decide({title, body});
    }

    /** 우선순위 순서로 한 계정씩 시도하고, 하나라도 성공하면 멈춥니다. 글 하나에는 댓글 하나만 답니다. */
    private async execute(gallery: GalleryConfig, post: NewPost, plan: Extract<Plan, {kind: "comment"}>, prefix = ""): Promise<void> {
        const {accounts, logger} = this.deps;
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const failures: string[] = [];
        for (const attempt of plan.attempts) {
            const label = attempt.content.type === "text" ? `"${attempt.content.text}"` : `디시콘 "${attempt.content.dccon.title}"`;
            try {
                await accounts.writeComment(attempt.accountId, gallery.galleryId, post.no, attempt.content);
                const summary = `${accounts.nickname(attempt.accountId)} 계정으로 ${label}`;
                logger.success(`${prefix}줄 서기 성공: ${summary}`, context);
                if (this.deps.settings().notifyOnSuccess) await this.alert(`${prefix}줄 서기 성공: ${post.title}`, summary, context, true);
                return;
            } catch (error) {
                const message = `${accounts.nickname(attempt.accountId)}: ${errorMessage(error)}`;
                failures.push(message);
                logger.error(`${prefix}줄 서기 실패 (${message})`, context);
            }
        }
        await this.notify(`${prefix}줄 서기 실패: ${post.title}`, failures.join("\n"), gallery.galleryId, post.no);
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
