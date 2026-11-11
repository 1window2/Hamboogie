import {errorMessage} from "@shared/errors";
import {postUrl} from "@shared/time";
import type {GalleryConfig} from "@shared/types";
import {buildBatchMessage, buildUserMessage, type Decision} from "../llm/decision";
import {LlmGate} from "../llm/gate";
import {LlmError, type LlmProvider, type PostInput} from "../llm/providers";
import {describeDecision, STALE_POST_MS, toPostInput, type Analysis, type Candidate, type JudgmentRecord} from "./candidate";
import type {Dispatcher} from "./dispatcher";
import type {EngineDeps} from "./engine";
import type {Notifier} from "./notifier";
import {brief, findInjectionWord, hasLineAndDeadline, makePlan, roleIn, type Plan} from "./planner";
import {LONG_SLEEP_MS, type SleepState} from "./sleep-state";

/** LLM 요청 한 번에 묶어 보낼 최대 글 수입니다. 40개까지 묶어도 판단이 거의 흔들리지 않는 것을 확인했습니다. */
const MAX_BATCH_POSTS = 40;
/** 판단 실패를 알릴 때 한 알림에 적는 글 수입니다. */
const FAILED_ALERT_MAX_POSTS = 10;
/** 글 하나로(사진까지 함께) 다시 판단하니 나눔 글이 아니었을 때의 이유입니다. 이런 글은 "나눔 판단" 수에 세지 않습니다. */
const NOT_GIVEAWAY_ON_RECHECK = "따로 다시 판단하니 나눔 글이 아님";
/** 묶음 판단이 통째로 실패했을 때 키워드에 걸린 글을 하나씩 다시 판단하는 최대 수입니다. 나머지는 알립니다. */
const SINGLE_RETRY_MAX = 5;

/** 글이 하나면 그 글 하나로, 여러 개면 묶어서 LLM 요청 한 번으로 판단합니다. 응답에 빠진 글은 null입니다. */
async function decideGroup(provider: LlmProvider, posts: PostInput[]): Promise<(Decision | null)[]> {
    return posts.length === 1 ? [await provider.decide(posts[0]!)] : provider.decideMany(posts);
}

/** LLM이 나눔이 아니라고 했어도 글에 "줄"과 마감 시각이 함께 있으면 나눔 줄일 때가 많아 넘기지 않고 알립니다. 아니면 null입니다. */
function missedLinePlan(candidate: Candidate, decision: Decision): Plan | null {
    if (!hasLineAndDeadline(`${candidate.title}\n${candidate.body}`)) return null;
    return {kind: "notify", reason: `나눔 글이 아니라고 판단했지만 글에 "줄"과 마감 시각이 함께 있어 직접 확인이 필요함 (LLM 근거: ${brief(decision.reason)})`};
}

/** LLM 판단을 바꾸려는 듯한 말이 든 글입니다. 다른 글과 묶으면 묶인 다른 글의 판단까지 흔들 수 있어 따로 묶습니다. */
function suspicious(candidate: Candidate): boolean {
    return findInjectionWord(`${candidate.title}\n${candidate.body}`) !== null;
}

/**
 * 판단할 글을 LLM 요청 단위로 나눕니다. 평범한 글과 판단을 바꾸려는 듯한 글을 따로 최대 `MAX_BATCH_POSTS`개씩 묶습니다.
 * 의심 글끼리는 서로의 판단만 흔들 수 있고 그런 글은 어차피 자동으로 줄 서지 않으므로(알림), 하나씩 따로 보내 요청을 늘리지 않습니다.
 * 글 순서(오래된 순서)는 묶음 안에서 지킵니다.
 */
function groupCandidates(candidates: Candidate[]): Candidate[][] {
    const groups: Candidate[][] = [];
    for (const part of [candidates.filter((candidate) => !suspicious(candidate)), candidates.filter(suspicious)]) {
        for (let start = 0; start < part.length; start += MAX_BATCH_POSTS) groups.push(part.slice(start, start + MAX_BATCH_POSTS));
    }
    return groups;
}

/** 묶인 글 하나 때문에 실패했을 수 있는 판단 실패인지입니다. 이때만 글을 하나씩 다시 판단합니다. */
function contentRelated(error: unknown): boolean {
    return error instanceof LlmError && error.contentRelated;
}

export interface JudgeHost {
    deps: EngineDeps;
    now(): number;
    sleep: SleepState;
    notifier: Notifier;
    dispatcher: Dispatcher;
    /** 지금의 줄 서기 세대입니다. 사용자가 감시를 멈출 때마다 바뀝니다. */
    epoch(): number;
}

/** 새 글을 LLM으로 판단하고 행동 계획을 세웁니다. */
export class Judge {
    /** LLM 요청 창구입니다(클라이언트, 분당·하루 한도, 한도 소진 시 쉬기). */
    readonly llm: LlmGate;

    constructor(private readonly host: JudgeHost) {
        this.llm = new LlmGate(host.deps, async (message) => {
            void host.notifier.send({title: "LLM 요청 한도 소진", description: message, critical: true});
        });
    }

    /**
     * 새 글들을 LLM으로 판단하고 바로 처리합니다. 글 번호, 제목, 본문을 묶어 요청 한 번(최대 `MAX_BATCH_POSTS`개씩)으로 보내고,
     * 나눔으로 판단돼 줄을 서야 하는 글만 그 글 하나로 다시 물어 확인합니다(묶인 다른 글이 판단을 조작하지 못하게).
     * 묶음에서 판단이 빠졌거나 묶음 요청이 실패한 키워드 글도 하나씩 다시 판단합니다. 무료 등급이면 하루 요청 수를 넘지 않게 합니다.
     *
     * @param onGiveaway 나눔으로 판단한 글이 나올 때마다 부릅니다(갤러리 상태의 "나눔 판단" 수). 2차 확인에서 나눔이 아니라고 나온 글은 빼고 셉니다.
     */
    async judgeAll(gallery: GalleryConfig, candidates: Candidate[], epoch: number, onGiveaway: () => void): Promise<void> {
        const {logger} = this.host.deps;
        const context = {galleryId: gallery.galleryId};
        let provider: LlmProvider;
        try {
            provider = this.llm.provider();
        } catch (error) {
            logger.warn(`새 글 ${candidates.length}개를 판단하지 못했습니다: ${errorMessage(error)}`, context);
            return this.failAll(gallery, candidates, errorMessage(error), epoch);
        }
        const groups = groupCandidates(candidates);
        for (const [groupIndex, group] of groups.entries()) {
            if (epoch !== this.host.epoch()) return;
            if (!this.llm.canUseToday()) {
                const rest = groups.slice(groupIndex).flat();
                logger.warn(`무료 등급 하루 LLM 요청 수를 다 써서 새 글 ${rest.length}개는 판단하지 못했습니다.`, context);
                return this.failAll(gallery, rest, "무료 등급 하루 LLM 요청 수를 다 씀", epoch);
            }
            // 올라온 지 너무 오래된 글(판단을 오래 기다린 글 포함)은 판단해도 줄을 서지 않으므로 LLM 요청을 쓰지 않습니다.
            const fresh = group.filter((candidate) => this.host.now() - candidate.postedAt <= STALE_POST_MS);
            if (fresh.length < group.length) logger.info(`올라온 지 ${STALE_POST_MS / 60000}분이 지난 글 ${group.length - fresh.length}개는 판단하지 않습니다(자동으로 줄 서지 않음).`, context);
            if (fresh.length === 0) continue;
            const decisions = await this.decide(gallery, provider, fresh, epoch, onGiveaway);
            if (!decisions) continue;
            for (const [index, candidate] of fresh.entries()) {
                let decision = decisions[index] ?? null;
                // 묶음 응답에서 빠져 글 하나로 다시 판단한 결과는 묶음 판단 결과로 보지 않습니다(2차 확인을 또 하지 않게).
                let batched = fresh.length > 1;
                if (!decision && batched && candidate.keyword) {
                    decision = await this.decideAlone(gallery, provider, candidate);
                    batched = false;
                }
                if (!decision) {
                    if (candidate.keyword) await this.host.dispatcher.dispatch(gallery, candidate.post, {kind: "notify", reason: "글 분석 실패: LLM 응답에 이 글의 판단이 빠져 있음"}, {live: {epoch}});
                    continue;
                }
                await this.handle(gallery, provider, candidate, decision, batched, epoch, onGiveaway);
            }
        }
    }

    /**
     * 묶음(또는 글 하나)을 판단합니다. 실패하면 키워드에 걸린 글을 몇 개까지 하나씩 다시 판단하고, 나머지는 알린 뒤 null을 돌려줍니다.
     * 판단하는 사이 컴퓨터가 잠들었다 깨어나 실패한 것이면 알리지 않고, 짧게 잤으면 한 번 더 판단합니다.
     */
    private async decide(gallery: GalleryConfig, provider: LlmProvider, group: Candidate[], epoch: number, onGiveaway: () => void): Promise<(Decision | null)[] | null> {
        const {logger} = this.host.deps;
        const {sleep} = this.host;
        const context = {galleryId: gallery.galleryId};
        let startedAt = this.host.now();
        const request = async () => {
            await this.llm.request(gallery.galleryId);
            return decideGroup(provider, group.map((candidate) => this.postInput(gallery, candidate)));
        };
        let decisions: (Decision | null)[];
        try {
            decisions = await request();
        } catch (error) {
            if (sleep.sleptSince(startedAt)) {
                await sleep.waitAwake();
                const last = sleep.last;
                if (epoch !== this.host.epoch() || !last || last.to - last.from > LONG_SLEEP_MS) {
                    logger.info(`판단하는 사이 컴퓨터가 잠들어 새 글 ${group.length}개는 건너뜁니다.`, context);
                    return null;
                }
                try {
                    startedAt = this.host.now();
                    decisions = await request();
                } catch (retryError) {
                    logger.warn(`잠자기에서 깨어난 뒤 다시 판단했지만 새 글 ${group.length}개를 판단하지 못했습니다: ${errorMessage(retryError)}`, context);
                    await this.failAll(gallery, group, errorMessage(retryError), epoch);
                    return null;
                }
            } else {
                logger.warn(`새 글 ${group.length}개를 판단하지 못했습니다: ${errorMessage(error)}`, context);
                await this.retrySingly(gallery, provider, group, error, epoch, onGiveaway);
                return null;
            }
        }
        const found = group.filter((_, index) => decisions[index]?.is_giveaway).length;
        // 나눔으로 판단한 글이 있거나 키워드에 걸린 글이 있는 묶음은 남겨, 놓친 글이나 판단이 흔들린 묶음을 나중에 되짚을 수 있게 합니다.
        if (found > 0 || group.some((candidate) => candidate.keyword)) this.recordJudgment(gallery, "batch", group, decisions);
        logger.info(`새 글 ${group.length}개를 LLM 요청 한 번으로 판단: 나눔 ${found}개 (${((this.host.now() - startedAt) / 1000).toFixed(1)}초)`, context);
        return decisions;
    }

    /**
     * 묶음 요청이 통째로 실패했을 때, 묶인 글 하나 때문에 실패했을 수 있으면(응답 해석 실패, 거절, 잘못된 요청, 시간 초과) 키워드에 걸린 글을
     * 하나씩 다시 판단합니다. 키나 모델이 틀렸거나 한도를 다 썼거나 서비스가 멈춘 것처럼 글과 상관없는 실패면 다시 판단하지 않고 알립니다.
     * 다시 판단하지 못한 키워드 글은 알립니다. 키워드에 걸리지 않은 글은 알리지 않습니다(모든 새 글을 알리면 알림이 넘칩니다).
     */
    private async retrySingly(gallery: GalleryConfig, provider: LlmProvider, group: Candidate[], error: unknown, epoch: number, onGiveaway: () => void): Promise<void> {
        const reason = errorMessage(error);
        const keyword = group.filter((candidate) => candidate.keyword);
        if (group.length === 1 || !contentRelated(error) || this.llm.paused) return this.failAll(gallery, keyword, reason, epoch);
        const failed: Candidate[] = [];
        for (const [index, candidate] of keyword.entries()) {
            const decision = index < SINGLE_RETRY_MAX ? await this.decideAlone(gallery, provider, candidate) : null;
            if (!decision) {
                failed.push(candidate);
                continue;
            }
            await this.handle(gallery, provider, candidate, decision, false, epoch, onGiveaway);
        }
        await this.failAll(gallery, failed, reason, epoch);
    }

    /** 글 하나만 따로 판단합니다. 하루 요청 수를 다 썼거나 실패하면 null입니다. */
    private async decideAlone(gallery: GalleryConfig, provider: LlmProvider, candidate: Candidate): Promise<Decision | null> {
        if (!this.llm.canUseToday()) return null;
        try {
            await this.llm.request(gallery.galleryId);
            const decision = await provider.decide(this.postInput(gallery, candidate));
            this.recordJudgment(gallery, "batch", [candidate], [decision]);
            return decision;
        } catch (error) {
            this.host.deps.logger.warn(`글 하나로 다시 판단하지 못했습니다: ${errorMessage(error)}`, {galleryId: gallery.galleryId, postNo: candidate.post.no});
            return null;
        }
    }

    /** 판단 하나를 계획으로 바꾸고 처리합니다. 묶어 판단했거나 사진이 있는 나눔 글은 그 글 하나로(사진까지 함께) 다시 판단합니다. */
    private async handle(gallery: GalleryConfig, provider: LlmProvider, candidate: Candidate, decision: Decision, batched: boolean, epoch: number, onGiveaway: () => void): Promise<void> {
        const {logger} = this.host.deps;
        const postContext = {galleryId: gallery.galleryId, postNo: candidate.post.no};
        // 나중에 놓친 글이나 잘못 선 글을 되짚을 수 있도록, 글마다 판단과 LLM의 근거를 남깁니다.
        if (!decision.is_giveaway) {
            logger.info(`나눔 아님: "${candidate.title}" (근거: ${decision.reason})`, postContext);
            const missed = missedLinePlan(candidate, decision);
            if (missed) await this.host.dispatcher.dispatch(gallery, candidate.post, missed, {live: {epoch}});
            return;
        }
        logger.info(`나눔으로 판단: "${candidate.title}" (${describeDecision(decision)}) (근거: ${decision.reason})`, postContext);
        let plan = this.planFor(gallery, decision, candidate);
        if (plan.kind === "comment" && (batched || candidate.images.length > 0)) plan = await this.confirm(gallery, provider, candidate, batched ? null : plan);
        // 다시 판단해 나눔이 아니라고 나온 글(당첨자 안내 캡처 등)은 세지 않습니다.
        if (!(plan.kind === "skip" && plan.reason === NOT_GIVEAWAY_ON_RECHECK)) onGiveaway();
        const {title, body, images, detectedAt} = candidate;
        await this.host.dispatcher.dispatch(gallery, candidate.post, plan, {live: {epoch}, content: {title, body, images, readAt: detectedAt}});
    }

    /** 키워드에 걸린 글만 알립니다. 모든 새 글을 알리면 알림이 넘칩니다. 여러 글이면 알림 하나로 묶습니다. */
    private async failAll(gallery: GalleryConfig, group: Candidate[], reason: string, epoch: number): Promise<void> {
        if (epoch !== this.host.epoch()) return;
        const {logger, ledger} = this.host.deps;
        const context = {galleryId: gallery.galleryId};
        const failed = group.filter((candidate) => candidate.keyword && ledger.claim(gallery.galleryId, candidate.post.no));
        for (const candidate of failed) logger.warn(`판단 불가, 알림 전송: 글 분석 실패: ${reason}`, {...context, postNo: candidate.post.no});
        // 알림은 기다리지 않습니다. 알림이 밀려도 다음 묶음(선착순 글이 있을 수 있음)의 판단이 늦어지지 않게 하기 위해서입니다.
        if (failed.length === 1) {
            void this.host.notifier.send({title: `판단이 필요한 글: ${failed[0]!.post.title}`, description: `글 분석 실패: ${reason}`, post: {galleryId: gallery.galleryId, postNo: failed[0]!.post.no}});
        } else if (failed.length > 1) {
            const links = failed.slice(0, FAILED_ALERT_MAX_POSTS).map((candidate) => ({title: candidate.post.title || `#${candidate.post.no}`, url: postUrl(gallery.galleryId, candidate.post.no)}));
            const more = failed.length > links.length ? `\n(아래 ${links.length}개 외 ${failed.length - links.length}개)` : "";
            void this.host.notifier.send({title: `판단이 필요한 글 ${failed.length}개 (${gallery.galleryId})`, description: `글 분석 실패: ${reason}${more}`, links});
        }
    }

    /**
     * 줄을 서라고 나온 글을 그 글 하나로, 사진이 있으면 사진까지 함께 다시 물어 확인합니다(당첨자 안내 캡처 등은 사진을 봐야 압니다).
     * 지금 남은 요청 자리가 없으면 기다리지 않고(선착순을 놓치지 않게), 묶음 판단 결과면 자동으로 서지 않고 알리며
     * 글 하나로 판단한 결과(`fallback`)면 사진이 있어도 그대로 따릅니다(2차 확인을 기다리다 선착순을 놓치는 것보다 낫다고 봅니다).
     * 자리가 있어 다시 판단하려 했는데 사진을 받지 못했거나 다시 판단하지 못했으면,
     * 사진을 봐야 알 수 있는 경우(이미 끝난 나눔의 당첨자 안내 등)를 거르지 못했으므로 자동으로 서지 않고 알립니다.
     */
    private async confirm(gallery: GalleryConfig, provider: LlmProvider, candidate: Candidate, fallback: Plan | null): Promise<Plan> {
        const {deps} = this.host;
        if (!this.llm.hasSlotNow() || !this.llm.canUseToday()) {
            return fallback ?? {kind: "notify", reason: "여러 글을 묶어 판단한 결과라 따로 확인해야 하는데 남은 LLM 요청이 없어 직접 확인이 필요함"};
        }
        const context = {galleryId: gallery.galleryId, postNo: candidate.post.no};
        try {
            const stats = {unreadable: 0};
            const images = candidate.images.length > 0 && deps.postImages ? await deps.postImages(candidate.images, stats).catch(() => []) : [];
            if (candidate.images.length > 0 && deps.postImages && images.length === 0) {
                const why = stats.unreadable > 0 ? "글의 사진을 열 수 없어(지원하지 않는 형식이거나 해상도가 지나치게 큼)" : "글의 사진을 받지 못해";
                return {kind: "notify", reason: `${why} 사진까지 보고 확인하지 못함`};
            }
            await this.llm.request(gallery.galleryId);
            const decision = await provider.decide({...this.postInput(gallery, candidate), images});
            this.recordJudgment(gallery, "confirm", [candidate], [decision], images.length);
            const photos = images.length > 0 ? `, 사진 ${images.length}장` : "";
            deps.logger.info(`2차 확인${photos}: ${decision.is_giveaway ? "나눔" : "나눔 아님"} (${describeDecision(decision)}) (근거: ${decision.reason})`, context);
            if (!decision.is_giveaway) return missedLinePlan(candidate, decision) ?? {kind: "skip", reason: NOT_GIVEAWAY_ON_RECHECK};
            return this.planFor(gallery, decision, candidate);
        } catch (error) {
            if (candidate.images.length > 0) return {kind: "notify", reason: `사진까지 보고 다시 판단하지 못함: ${errorMessage(error)}`};
            // 글 하나로 판단한 결과가 있으면 처음 판단대로 합니다.
            if (fallback) {
                deps.logger.warn(`다시 판단하지 못해 처음 판단대로 합니다: ${errorMessage(error)}`, context);
                return fallback;
            }
            return {kind: "notify", reason: `묶음 판단 결과를 확인하지 못함: ${errorMessage(error)}`};
        }
    }

    /**
     * LLM에 보낸 내용(요청과 똑같이 만든 메시지)과 판단 원문을 남깁니다.
     * @param imageCount 글 하나를 판단할 때 함께 보낸 사진 수입니다.
     */
    /** LLM에 보낼 글입니다. 대기 계정마다 이 갤러리에서 맡은 완장(매니저, 부매니저, 일반 갤럼)을 함께 보냅니다. */
    private postInput(gallery: GalleryConfig, candidate: Candidate): PostInput {
        const {accounts, settings} = this.host.deps;
        const roles = accounts.candidates(settings().accounts, gallery.accountIds).map((account) => roleIn(account, gallery.galleryId));
        return {...toPostInput(candidate), accounts: {galleryId: gallery.galleryId, roles}};
    }

    private recordJudgment(gallery: GalleryConfig, kind: JudgmentRecord["kind"], group: Candidate[], decisions: (Decision | null)[], imageCount = 0): void {
        const {deps} = this.host;
        if (!deps.recordJudgment) return;
        const {llm} = deps.settings();
        const posts = group.map((candidate) => this.postInput(gallery, candidate));
        const single = group.length === 1;
        deps.recordJudgment({
            time: this.host.now(),
            galleryId: gallery.galleryId,
            kind,
            model: `${llm.provider}/${llm.models[llm.provider]}`,
            systemPrompt: single ? "SYSTEM_PROMPT" : "BATCH_SYSTEM_PROMPT",
            message: single ? buildUserMessage(posts[0]!.title, posts[0]!.body, posts[0]!.postedAt, imageCount, posts[0]!.accounts) : buildBatchMessage(posts, undefined, posts[0]!.accounts),
            // 디시가 준 작성 시각 문자열도 남겨 두어, 작성 시각을 제대로 읽었는지 나중에 확인할 수 있게 합니다.
            posts: group.map((candidate) => ({
                no: candidate.post.no, title: candidate.title, bodyRead: candidate.bodyRead, keyword: candidate.keyword,
                detectedAt: candidate.detectedAt, postedAt: candidate.postedAt, dateTime: candidate.dateTime ?? candidate.post.dateTime ?? null,
                ...(candidate.images.length > 0 ? {images: candidate.images} : {})
            })),
            decisions
        });
    }

    planFor(gallery: GalleryConfig, decision: Decision, candidate: {title: string; body: string; bodyRead?: boolean; detectedAt: number; postedAt?: number; postedSlackMs?: number}): Plan {
        // 감지한 때가 아니라 지금(판단이 끝난 때) 기준으로 봅니다. LLM 요청을 오래 기다린 글도 걸러집니다.
        const age = candidate.postedAt === undefined ? 0 : this.host.now() - candidate.postedAt;
        if (decision.is_giveaway && age > STALE_POST_MS) {
            return {kind: "skip", reason: `올라온 지 ${Math.round(age / 60000)}분 지난 글이라 자동으로 줄 서지 않음`};
        }
        const {accounts, settings} = this.host.deps;
        const candidates = accounts.candidates(settings().accounts, gallery.accountIds);
        const plan = makePlan(decision, gallery, candidates, `${candidate.title}\n${candidate.body}`, {
            detectedAt: candidate.detectedAt,
            ...(candidate.postedAt !== undefined ? {postedAt: candidate.postedAt} : {}),
            deadlineSlackMs: candidate.postedSlackMs ?? 0
        });
        // 본문을 읽지 않은 글은 본문에 봇 색출 문구나 다른 조건이 있어도 알 수 없으므로, 자동으로 서지 않고 알립니다.
        if (plan.kind === "comment" && candidate.bodyRead === false) {
            return {kind: "notify", reason: "본문 요청 상한을 넘어 본문을 확인하지 못했습니다. 글을 직접 확인하세요."};
        }
        return plan.kind === "comment" ? {...plan, basis: brief(decision.reason)} : plan;
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
}
