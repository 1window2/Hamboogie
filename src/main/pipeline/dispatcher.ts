import {errorMessage} from "@shared/errors";
import {DEFAULT_COMMENT_TEXT, PROVIDERS} from "@shared/settings";
import {normalizeForMatch} from "@shared/text";
import type {GalleryConfig, HistoryEntry} from "@shared/types";
import {isCaptchaFailure, isDefiniteCommentFailure} from "../dc/accounts";
import {imageIdentity} from "../dc/post-images";
import type {CommentPlan, Live, NewPost} from "./candidate";
import type {EngineDeps} from "./engine";
import type {Notifier} from "./notifier";
import {containsSecret, eligible, END_MARGIN_MS, findBaitWord, findInjectionWord, findPrivacyProbe, hasStartHint, roleAllowed, type CommentContent, type Plan} from "./planner";
import type {SleepState} from "./sleep-state";
import {WallTimer} from "./wall-timer";

/** 줄 서기를 판단할 때 본 글 내용입니다. 예약해 둔 줄 서기를 실행하기 직전에 글이 바뀌지 않았는지 볼 때 씁니다. */
export interface PostContent {
    title: string;
    body: string;
    images: string[];
    /** 이 내용을 읽은 시각입니다. 판단을 오래 기다려 그사이 글이 바뀌었을 수 있으면 달기 직전에 다시 읽습니다. */
    readAt?: number;
}

/** 예약해 둔 줄 서기는 정한 시각보다 이만큼 먼저 글을 다시 읽어, 다시 읽느라 정각 선착순에 늦지 않게 합니다. */
const RECHECK_LEAD_MS = 3000;

/** 글을 읽은 지 이만큼 지난 뒤에 바로 서게 되면(분당 요청 한도를 기다린 판단 등) 달기 직전에 글을 다시 읽습니다. */
const STALE_CONTENT_MS = 10_000;

/**
 * 글 내용을 비교하기 쉬운 값으로 만듭니다. 보이지 않는 글자, 공백, 대소문자 차이는 바뀐 것으로 보지 않습니다.
 * 사진은 `imagesKey`로 따로 비교합니다.
 */
function contentKey(content: PostContent): string {
    return `${normalizeForMatch(content.title)}\n${normalizeForMatch(content.body)}`;
}

/** 글의 사진들을 비교하기 쉬운 값입니다. 서버 이름과 순서는 보지 않습니다(`imageIdentity`). */
function imagesKey(images: string[]): string {
    return images.map(imageIdentity).sort().join("\n");
}

export interface DispatcherHost {
    deps: EngineDeps;
    now(): number;
    sleep: SleepState;
    notifier: Notifier;
    /** 지금의 줄 서기 세대입니다. 사용자가 감시를 멈출 때마다 바뀝니다. */
    epoch(): number;
    /** 글을 다시 읽습니다. 지워졌으면 null입니다. */
    readPost(gallery: GalleryConfig, postNo: number): Promise<PostContent | null>;
    excludedBy(gallery: GalleryConfig, text: string): string | null;
}

interface Scheduled {
    gallery: GalleryConfig;
    post: NewPost;
    test: boolean;
}

/** 계획대로 넘어가거나, 알리거나, 줄 서기를 예약하고 실행합니다. */
export class Dispatcher {
    /** 예약된 줄 서기입니다. */
    private readonly scheduled = new Map<WallTimer, Scheduled>();

    constructor(private readonly host: DispatcherHost) {
        // 깨어나 네트워크가 붙으면, 잠든 사이 시각이 된 줄 서기를 기다리지 않고 바로 확인합니다.
        host.sleep.onWake(() => {
            for (const timer of this.scheduled.keys()) timer.check();
        });
    }

    /**
     * 계획대로 넘어가거나, 알리거나, 줄 서기를 예약합니다.
     *
     * @param options.live 감시로 찾은 글이면 넘깁니다. 처리한 글 기록을 남기고, 사용자가 감시를 멈췄으면 아무것도 하지 않으며,
     *   실행 직전에 최신 설정을 다시 확인합니다. 없으면 개발 모드 테스트로 보고 기록과 설정 확인을 건너뜁니다.
     * @param options.label 로그와 알림 앞에 붙일 표시입니다.
     * @param options.content 판단할 때 본 글 내용입니다. 줄 서기를 예약해 두었다가 달 때 글이 그사이 바뀌었는지 다시 확인합니다.
     */
    async dispatch(gallery: GalleryConfig, post: NewPost, plan: Plan, options: {live?: Live; label?: string; content?: PostContent} = {}): Promise<void> {
        const {ledger, logger} = this.host.deps;
        const {live} = options;
        const label = options.label ? `${options.label} ` : "";
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        if (live && live.epoch !== this.host.epoch()) {
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
                // 알림을 기다리지 않습니다. 같은 묶음의 다음 글(선착순 나눔일 수 있음)이 알림 전송 때문에 늦어지지 않게 하기 위해서입니다.
                void this.host.notifier.send({title: `${label}판단이 필요한 글: ${post.title}`, description: plan.reason, post: context});
                return;
            case "comment": {
                if (!claim()) return;
                const waitMs = Math.max(0, plan.notBefore - this.host.now());
                if (waitMs > 0) logger.info(`${label}${Math.round(waitMs / 1000)}초 뒤에 줄을 섭니다.`, context);
                const scheduledAt = this.host.now();
                // 예약해 둔 줄 서기는 정한 시각보다 조금 먼저 깨어 글을 다시 읽고, 정한 시각까지 기다렸다가 답니다.
                const wakeAt = options.content && waitMs > 0 ? plan.notBefore - RECHECK_LEAD_MS : plan.notBefore;
                const timer: WallTimer = new WallTimer(wakeAt, () => this.host.now(), () => {
                    this.scheduled.delete(timer);
                    void this.execute(gallery, post, plan, label, live, options.content ? {content: options.content, deferred: waitMs > 0, scheduledAt} : undefined);
                });
                this.scheduled.set(timer, {gallery, post, test: !live});
            }
        }
    }

    /** 예약된 줄 서기를 모두 취소하고 기록에 남깁니다(사용자가 감시를 멈출 때). */
    cancelAll(): void {
        for (const [timer, pending] of this.scheduled) {
            timer.cancel();
            this.host.deps.logger.warn("감시를 멈춰 예약된 줄 서기를 취소했습니다.", {galleryId: pending.gallery.galleryId, postNo: pending.post.no});
            this.record(pending.gallery, pending.post, "failure", "감시를 멈춰 예약된 줄 서기를 취소함", pending.test);
        }
        this.scheduled.clear();
    }

    /**
     * 실행 직전에 최신 설정으로 계획을 다시 확인합니다. 줄을 서면 안 되면 그 이유를 돌려줍니다.
     * 서도 되면 지금 설정에서 시도할 수 있는 계정만 남긴 시도 목록을 돌려줍니다.
     */
    private revalidate(gallery: GalleryConfig, plan: CommentPlan, content: PostContent | undefined): {reason: string} | {attempts: CommentPlan["attempts"]} {
        const settings = this.host.deps.settings();
        const latest = settings.galleries.find((item) => item.id === gallery.id);
        if (!latest || !latest.enabled || latest.galleryId !== gallery.galleryId) return {reason: "감시 설정이 바뀌어(갤러리 삭제/끄기/ID 변경) 취소함"};
        if (latest.category === "food" && !plan.isFood) return {reason: "나눔 종류 설정이 '음식만'으로 바뀌어 취소함"};
        // 예약한 뒤 제외 키워드를 더했으면 그 키워드도 지킵니다.
        const excluded = content && (this.host.excludedBy(latest, content.title) ?? this.host.excludedBy(latest, content.body));
        if (excluded) return {reason: `제외 키워드 "${excluded}"가 생겨 취소함`};
        const allowed = new Set(latest.accountIds);
        const candidates = new Map(this.host.deps.accounts.candidates(settings.accounts, latest.accountIds).map((account) => [account.id, account]));
        const attempts = plan.attempts.filter((attempt) => {
            if (!allowed.has(attempt.accountId)) return false;
            const candidate = candidates.get(attempt.accountId);
            // 로그아웃된 계정은 시도해서 실패로 남기고, 로그인된 계정은 바뀐 계정 종류와 완장으로 자격을 다시 봅니다.
            return !candidate || (eligible(candidate, plan.requirement) && (!plan.roles || roleAllowed(candidate, latest.galleryId, plan.roles) === true));
        });
        if (attempts.length === 0) return {reason: "대기 계정 설정이 바뀌어 줄을 설 계정이 없어 취소함"};
        return {attempts};
    }

    /**
     * 예약해 둔 줄 서기면 달기 직전에 글을 다시 읽어, 판단한 뒤 글이 바뀌었는지 봅니다. 줄을 서면 안 되면 그 이유를 돌려줍니다.
     * 글쓴이는 깨끗한 글로 판단을 통과한 뒤, 예약 시각 전에 글을 "지금 댓글 다는 사람은 봇으로 보고 차단" 같은 글로 고칠 수 있습니다.
     * 나눔 글은 시작 시각에 고치는 일이 흔하므로("지금 시작", 남은 수량), 글이 바뀌었으면 바로 취소하지 않고 바뀐 글로 정해진 검사
     * (봇 색출·인젝션·개인정보 낱말, 제외 키워드, 요구 문구가 아직 글에 있는지)를 다시 해서 걸릴 때만 취소합니다.
     * 다시 읽지 못하면 확인하지 못한 글에는 자동으로 달지 않습니다.
     */
    private async recheck(gallery: GalleryConfig, post: NewPost, judged: PostContent, plan: CommentPlan, attempts: CommentPlan["attempts"]): Promise<{reason: string; notify: boolean} | null> {
        let current: PostContent | null;
        try {
            current = await this.host.readPost(gallery, post.no);
        } catch (error) {
            return {reason: `댓글을 달기 직전에 글을 다시 확인하지 못해 취소함: ${errorMessage(error)}`, notify: true};
        }
        if (!current) return {reason: "글이 지워져 취소함", notify: false};
        // 사진을 바꿨으면 사진 속 글자(봇 함정 등)를 다시 확인하지 못했으므로 달지 않습니다.
        if (imagesKey(current.images) !== imagesKey(judged.images)) return {reason: "판단한 뒤 글의 사진이 바뀌어 취소함", notify: true};
        if (contentKey(current) === contentKey(judged)) return null;
        const text = `${current.title}\n${current.body}`;
        const word = findBaitWord(text) ?? findInjectionWord(text) ?? findPrivacyProbe(text);
        if (word) return {reason: `판단한 뒤 글이 수정되어 직접 확인이 필요한 말("${word}")이 생겨 취소함`, notify: true};
        if (!plan.hasStartTime && hasStartHint(text)) return {reason: "판단한 뒤 글이 수정되어 줄 서기 시작 시각으로 보이는 말이 생겨 취소함", notify: true};
        const latest = this.host.deps.settings().galleries.find((item) => item.id === gallery.id) ?? gallery;
        const excluded = this.host.excludedBy(latest, current.title) ?? this.host.excludedBy(latest, current.body);
        if (excluded) return {reason: `판단한 뒤 글이 수정되어 제외 키워드 "${excluded}"가 생겨 취소함`, notify: false};
        const required = attempts.find((attempt) => attempt.content.type === "text" && attempt.content.text !== DEFAULT_COMMENT_TEXT);
        if (required?.content.type === "text" && !normalizeForMatch(text).includes(normalizeForMatch(required.content.text))) {
            return {reason: "판단한 뒤 글이 수정되어 요구 문구가 글에서 사라져 취소함", notify: true};
        }
        this.host.deps.logger.info("줄 서기로 판단한 뒤 글이 수정됐지만, 바뀐 글을 다시 확인해 그대로 섭니다.", {galleryId: gallery.galleryId, postNo: post.no});
        return null;
    }

    /**
     * 우선순위 순서로 한 계정씩 시도하고, 하나라도 성공하면 멈춥니다. 글 하나에는 댓글 하나만 답니다.
     * 댓글이 달리지 않은 것이 확실한 실패일 때만 다음 계정으로 넘어가고, 결과를 알 수 없으면(응답 시간 초과 등) 멈추고 알립니다.
     *
     * @param binding 판단할 때 본 글 내용과, 그 뒤 기다렸는지(예약)입니다. 기다렸거나 글을 읽은 지 오래됐으면 달기 직전에 글을 다시 읽어 확인합니다.
     */
    private async execute(gallery: GalleryConfig, post: NewPost, plan: CommentPlan, prefix: string, live: Live | undefined,
        binding?: {content: PostContent; deferred: boolean; scheduledAt: number}): Promise<void> {
        const {accounts, logger} = this.host.deps;
        const {notifier, sleep} = this.host;
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const test = !live;
        const cancel = (reason: string) => {
            logger.warn(`${prefix}줄 서기를 하지 않음: ${reason}`, context);
            this.record(gallery, post, "failure", reason, test);
        };

        // 예약해 둔 줄 서기가 잠든 사이 시각이 되었으면, 깨어나 네트워크가 붙은 뒤에 섭니다(감시를 멈췄으면 아래에서 취소됩니다).
        // 5분 넘게 잠든 사이 시각이 지나 버렸으면 버립니다. 마감이 있으면 마감 전까지는 섭니다(마감은 아래에서 확인합니다).
        if (live) await sleep.waitAwake();
        // 기다리는 사이 사용자가 감시를 멈췄으면 글을 다시 읽거나 알리지 않고 끝냅니다.
        if (live && live.epoch !== this.host.epoch()) return cancel("감시를 멈춰 취소함");
        if (live && plan.deadline === undefined && sleep.inLongSleep(plan.notBefore)) return cancel("잠든 사이 줄 서기 시각이 지나 취소함");
        let attempts = plan.attempts;
        if (live) {
            const checked = this.revalidate(gallery, plan, binding?.content);
            if ("reason" in checked) return cancel(checked.reason);
            attempts = checked.attempts;
            const stale = binding?.content.readAt !== undefined && this.host.now() - binding.content.readAt > STALE_CONTENT_MS;
            if (binding && (binding.deferred || stale || sleep.sleptSince(binding.scheduledAt))) {
                const changed = await this.recheck(gallery, post, binding.content, plan, attempts);
                // 다시 읽는 사이 감시를 멈췄으면 알리지 않고 끝냅니다.
                if (live.epoch !== this.host.epoch()) return cancel("감시를 멈춰 취소함");
                if (changed) {
                    cancel(changed.reason);
                    if (changed.notify) void notifier.send({title: `${prefix}줄 서기 취소: ${post.title}`, description: `${changed.reason}. 글을 직접 확인하세요.`, post: context, critical: true});
                    return;
                }
                // 정한 시각보다 먼저 다시 읽었으면 정한 시각까지 기다립니다.
                if (this.host.now() < plan.notBefore) await new Promise<void>((resolve) => new WallTimer(plan.notBefore, () => this.host.now(), resolve));
                if (live.epoch !== this.host.epoch()) return cancel("감시를 멈춰 취소함");
            }
        }
        // 마지막 관문: 댓글 문구에 내 계정이나 설정의 비밀 정보가 들어 있으면 어떤 경로로 만들어진 계획이든 달지 않습니다.
        // 알림에는 문구를 넣지 않습니다(그 정보가 Discord로 나가지 않게).
        if (attempts.some((attempt) => attempt.content.type === "text" && containsSecret(attempt.content.text, this.secretValues()))) {
            const reason = "댓글 문구에 내 계정이나 설정 정보가 들어 있어 달지 않음";
            cancel(reason);
            await notifier.send({title: `${prefix}줄 서기 취소: ${post.title}`, description: `${reason}. 글을 직접 확인하세요.`, post: context, critical: true});
            return;
        }

        const failures: string[] = [];
        for (const attempt of attempts) {
            if (live && live.epoch !== this.host.epoch()) return cancel("감시를 멈춰 취소함");
            // 예약해 둔 사이, 또는 앞 계정이 실패해 재시도하는 사이 마감이 지났으면 달지 않습니다.
            if (plan.deadline !== undefined && this.host.now() > plan.deadline - END_MARGIN_MS) return cancel("마감 시각이 지나 댓글을 달지 않음");

            const labelOf = (content: CommentContent) => content.type === "text" ? `"${content.text}"` : `디시콘 "${content.dccon.title}"`;
            let label = labelOf(attempt.content);
            let failure: unknown = null;
            try {
                await accounts.writeComment(attempt.accountId, gallery.galleryId, post.no, attempt.content);
            } catch (error) {
                failure = error;
            }
            // 글이 요구하지 않은 기본 디시콘을 달지 못했으면(댓글이 달리지 않은 것이 확실할 때만) 같은 계정으로 "줄"을 대신 답니다.
            if (failure !== null && attempt.fallback && isDefiniteCommentFailure(failure) && !isCaptchaFailure(failure)) {
                logger.warn(`${prefix}${label}을(를) 달지 못해 ${labelOf(attempt.fallback)}로 다시 답니다: ${errorMessage(failure)}`, context);
                label = labelOf(attempt.fallback);
                failure = null;
                try {
                    await accounts.writeComment(attempt.accountId, gallery.galleryId, post.no, attempt.fallback);
                } catch (error) {
                    failure = error;
                }
            }
            const nickname = accounts.nickname(attempt.accountId);

            if (failure === null) {
                const summary = `${nickname} 계정으로 ${label}`;
                logger.success(`${prefix}줄 서기 성공: ${summary}`, context);
                this.record(gallery, post, "success", summary, test);
                if (this.host.deps.settings().notifyOnSuccess) {
                    await notifier.send({title: `${prefix}줄 서기 성공: ${post.title}`, description: plan.basis ? `${summary}\n판단 근거: ${plan.basis}` : summary, post: context, success: true});
                }
                return;
            }
            const message = `${nickname}: ${errorMessage(failure)}`;
            // 갤러리에 보안 코드(캡차)가 걸려 있으면 계정을 바꿔도 같으므로 멈추고 알립니다.
            if (isCaptchaFailure(failure)) {
                const detail = `이 갤러리는 댓글에 보안 코드 입력이 필요해 자동으로 줄을 설 수 없습니다. (${message})`;
                logger.error(`${prefix}줄 서기 실패: 보안 코드 필요`, context);
                this.record(gallery, post, "failure", detail, test);
                await notifier.send({title: `${prefix}줄 서기 실패(보안 코드 필요): ${post.title}`, description: detail, post: context, critical: true});
                return;
            }
            if (!isDefiniteCommentFailure(failure)) {
                // 서버가 댓글을 저장했을 수도 있으므로 다른 계정으로 또 달지 않습니다.
                const detail = `결과를 알 수 없음 (${message}). 댓글이 달렸는지 글에서 직접 확인하세요.`;
                logger.error(`${prefix}줄 서기 결과 불명: ${message}`, context);
                this.record(gallery, post, "failure", detail, test);
                await notifier.send({title: `${prefix}줄 서기 결과 확인 필요: ${post.title}`, description: detail, post: context, critical: true});
                return;
            }
            failures.push(message);
            logger.error(`${prefix}줄 서기 실패 (${message})`, context);
        }
        this.record(gallery, post, "failure", failures.join("\n"), test);
        await notifier.send({title: `${prefix}줄 서기 실패: ${post.title}`, description: failures.join("\n"), post: context, critical: true});
    }

    private record(gallery: GalleryConfig, post: NewPost, outcome: HistoryEntry["outcome"], detail: string, test: boolean): void {
        this.host.deps.history.add({
            time: this.host.now(),
            galleryId: gallery.galleryId,
            postNo: post.no,
            title: post.title,
            outcome,
            detail,
            ...(test ? {test} : {})
        });
    }

    /** 댓글에 들어가면 안 되는 값입니다: 계정 로그인 아이디와 비밀번호, LLM API 키, Discord 주소. */
    private secretValues(): (string | null)[] {
        const {secrets} = this.host.deps;
        const settings = this.host.deps.settings();
        return [
            ...settings.accounts.flatMap((account) => [account.loginId, secrets.get(`account:${account.id}`)]),
            ...PROVIDERS.map((provider) => secrets.get(`llm:${provider}`)),
            settings.discordWebhookUrl
        ];
    }
}
