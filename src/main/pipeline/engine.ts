import type {DCInside, PostItem} from "@green-1052/dcinside.js";
import {galleryProblems, PROVIDER_LABELS} from "@shared/settings";
import type {GalleryConfig, Settings} from "@shared/types";
import type {AccountManager} from "../dc/accounts";
import {htmlToText} from "../dc/text";
import {createProvider} from "../llm/providers";
import type {Logger} from "../logger";
import {sendDiscordNotice} from "../notify/discord";
import type {Ledger, SecretStore} from "../store";
import {matchesKeywords} from "./keyword-filter";
import {makePlan, type Plan} from "./planner";

/** 한 번 확인할 때 최대로 넘겨볼 목록 페이지 수입니다. */
const MAX_PAGES_PER_TICK = 3;

interface NewPost {
    no: number;
    title: string;
}

export interface EngineDeps {
    reader: DCInside;
    onReaderReady(): Promise<void>;
    accounts: AccountManager;
    ledger: Ledger;
    secrets: SecretStore;
    logger: Logger;
    settings(): Settings;
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
    private readonly scheduled = new Set<ReturnType<typeof setTimeout>>();
    private readonly lastSeen = new Map<string, number>();
    private readerReady = false;
    private runId = 0;

    constructor(private readonly deps: EngineDeps) {}

    get running(): boolean {
        return this.watchers.size > 0;
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
        if (this.watchers.size === 0) logger.warn("감시할 수 있는 갤러리가 없습니다.");
        else logger.info(`갤러리 ${this.watchers.size}개 감시를 시작합니다.`);
    }

    stop(): void {
        this.runId++;
        for (const timer of this.watchers.values()) clearTimeout(timer);
        for (const timer of this.scheduled) clearTimeout(timer);
        if (this.watchers.size > 0 || this.scheduled.size > 0) this.deps.logger.info("감시를 멈췄습니다. 예약된 줄 서기도 취소했습니다.");
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
        try {
            const posts = await this.fetchNewPosts(gallery);
            for (const post of posts) {
                if (runId !== this.runId) return;
                await this.handlePost(gallery, post);
            }
        } catch (error) {
            this.deps.logger.error(`목록 확인 실패: ${errorMessage(error)}`, {galleryId: gallery.galleryId});
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
            const response = await reader.articles.list({gallery: gallery.galleryId, page});
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
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        if (ledger.has(gallery.galleryId, post.no)) return;
        if (!matchesKeywords(post.title, gallery.keywords)) return;

        logger.info(`키워드 일치: "${post.title}"`, context);
        const detectedAt = Date.now();
        let plan: Plan;
        try {
            const article = await this.deps.reader.articles.read(gallery.galleryId, post.no);
            const title = article.view_info?.subject ?? post.title;
            const body = htmlToText(article.view_main?.memo ?? "");
            const decision = await this.decide(title, body);
            const settings = this.deps.settings();
            plan = makePlan(decision, gallery, this.deps.accounts.candidates(settings.accounts, gallery.accountIds), detectedAt);
        } catch (error) {
            plan = {kind: "notify", reason: `글 분석 실패: ${errorMessage(error)}`};
        }

        switch (plan.kind) {
            case "skip":
                logger.info(`넘어감: ${plan.reason}`, context);
                return;
            case "notify":
                if (!ledger.claim(gallery.galleryId, post.no)) return;
                logger.warn(`판단 불가, 알림 전송: ${plan.reason}`, context);
                await this.notify(`판단이 필요한 글: ${post.title}`, plan.reason, gallery.galleryId, post.no);
                return;
            case "comment": {
                if (!ledger.claim(gallery.galleryId, post.no)) return;
                const waitMs = Math.max(0, plan.notBefore - Date.now());
                if (waitMs > 0) logger.info(`${Math.round(waitMs / 1000)}초 뒤에 줄을 섭니다.`, context);
                const timer = setTimeout(() => {
                    this.scheduled.delete(timer);
                    void this.execute(gallery, post, plan);
                }, waitMs);
                this.scheduled.add(timer);
            }
        }
    }

    private async decide(title: string, body: string) {
        const {llm} = this.deps.settings();
        const apiKey = this.deps.secrets.get(`llm:${llm.provider}`);
        if (!apiKey) throw new Error(`${PROVIDER_LABELS[llm.provider]} API 키가 설정되지 않았습니다.`);
        return createProvider(llm.provider, apiKey, llm.models[llm.provider]).decide({title, body});
    }

    /** 우선순위 순서로 한 계정씩 시도하고, 하나라도 성공하면 멈춥니다. 글 하나에는 댓글 하나만 답니다. */
    private async execute(gallery: GalleryConfig, post: NewPost, plan: Extract<Plan, {kind: "comment"}>): Promise<void> {
        const {accounts, logger} = this.deps;
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const failures: string[] = [];
        for (const attempt of plan.attempts) {
            const label = attempt.content.type === "text" ? `"${attempt.content.text}"` : `디시콘 "${attempt.content.dccon.title}"`;
            try {
                await accounts.writeComment(attempt.accountId, gallery.galleryId, post.no, attempt.content);
                logger.success(`줄 서기 성공: ${accounts.nickname(attempt.accountId)} 계정으로 ${label}`, context);
                return;
            } catch (error) {
                const message = `${accounts.nickname(attempt.accountId)}: ${errorMessage(error)}`;
                failures.push(message);
                logger.error(`줄 서기 실패 (${message})`, context);
            }
        }
        await this.notify(`줄 서기 실패: ${post.title}`, failures.join("\n"), gallery.galleryId, post.no);
    }

    private async notify(title: string, description: string, galleryId: string, postNo: number): Promise<void> {
        const {logger} = this.deps;
        const webhookUrl = this.deps.settings().discordWebhookUrl;
        if (!webhookUrl) {
            logger.warn("Discord 웹훅이 설정되지 않아 알림을 보내지 못했습니다.", {galleryId, postNo});
            return;
        }
        try {
            await sendDiscordNotice(webhookUrl, {title, description, url: postUrl(galleryId, postNo)});
        } catch (error) {
            logger.error(`Discord 알림 전송 실패: ${errorMessage(error)}`, {galleryId, postNo});
        }
    }
}
