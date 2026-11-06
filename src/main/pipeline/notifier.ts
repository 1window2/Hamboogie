import {errorMessage} from "@shared/errors";
import {delay, postUrl} from "@shared/time";
import type {Settings} from "@shared/types";
import type {Logger} from "../logger";
import {DiscordRateLimitError, sendDiscordNotice, type DiscordNotice} from "../notify/discord";

/** 웹훅 하나로 알림을 보내는 최소 간격입니다. Discord 웹훅은 짧은 시간에 몰아 보내면 한동안 거절합니다(2초에 5개 정도). */
const SEND_GAP_MS = 500;
/** 전송 한도에 걸렸을 때 다시 보내 보는 횟수입니다. */
const RATE_LIMIT_RETRIES = 3;
/** 전송 한도에 걸렸을 때 기다리는 최대 시간입니다. 이보다 오래 기다리라고 하면 포기합니다. */
const RETRY_AFTER_MAX_MS = 60 * 1000;
/**
 * 밀려 있는 일반 알림(판단이 필요한 글, 성공 알림)의 최대 수입니다. 넘으면 알림 하나로 묶습니다.
 * 누구나 쓸 수 있는 글로 알림을 쏟아내 웹훅 한도를 다 쓰게 해도 중요한 알림이 밀리지 않게 하기 위해서입니다.
 */
const QUEUED_NOTICES_MAX = 20;
/** 묶음 알림에 링크로 붙일 최대 글 수입니다. */
const OVERFLOW_LINKS_MAX = 10;

export interface NoticeRequest {
    title: string;
    description: string;
    /** 글과 관련된 알림이면 그 글입니다. 글 링크를 붙입니다. */
    post?: {galleryId: string; postNo: number};
    success?: boolean;
    links?: DiscordNotice["links"];
    /**
     * 사용자가 꼭 알아야 하는 알림입니다(댓글 결과 확인 필요, 로그인 풀림, 감시 중지 등). 일반 알림보다 먼저 보내고,
     * Discord로 보내지 못하면 컴퓨터 알림으로 대신 띄웁니다.
     */
    critical?: boolean;
}

/** 알림 결과입니다. 웹훅을 정하지 않았으면 "no_webhook", 보내려 했지만 못 보냈으면 "failed"입니다. */
export type NoticeResult = "sent" | "no_webhook" | "failed";

interface Pending {
    request: NoticeRequest;
    done: (result: NoticeResult) => void;
}

export interface NotifierDeps {
    settings(): Settings;
    logger: Logger;
    /** 컴퓨터 알림을 띄웁니다. 중요한 알림을 Discord로 보내지 못했을 때 씁니다. */
    desktopNotice?(title: string, body: string): void;
    /** 테스트에서 기다리는 시간을 줄일 수 있게 합니다. */
    sleep?(ms: number): Promise<void>;
}

/** Discord 알림을 차례로 보냅니다. 전송 한도를 지키고, 중요한 알림이 일반 알림에 밀리지 않게 합니다. */
export class Notifier {
    private readonly queue: Pending[] = [];
    /** 대기열이 넘쳐 묶어 둔 일반 알림입니다. */
    private overflow: {count: number; links: NonNullable<DiscordNotice["links"]>; waiting: ((result: NoticeResult) => void)[]} | null = null;
    private sending: Promise<void> | null = null;

    constructor(private readonly deps: NotifierDeps) {}

    /** 알림을 보냅니다. 보낸 뒤(또는 포기한 뒤) 결과와 함께 끝납니다. 웹훅이 없으면 로그만 남기고 바로 끝납니다. */
    send(request: NoticeRequest): Promise<NoticeResult> {
        if (!this.deps.settings().discordWebhookUrl) {
            this.deps.logger.warn("Discord 웹훅이 설정되지 않아 알림을 보내지 못했습니다.", request.post);
            return Promise.resolve("no_webhook");
        }
        return new Promise<NoticeResult>((done) => {
            const pending = {request, done};
            if (request.critical) {
                // 중요한 알림은 앞서 밀린 중요한 알림 바로 뒤, 일반 알림보다 앞에 둡니다.
                const firstNormal = this.queue.findIndex((item) => !item.request.critical);
                this.queue.splice(firstNormal === -1 ? this.queue.length : firstNormal, 0, pending);
            } else if (this.queue.filter((item) => !item.request.critical).length >= QUEUED_NOTICES_MAX) {
                this.fold(pending);
            } else {
                this.queue.push(pending);
            }
            this.sending ??= this.drain();
        });
    }

    /** 밀린 알림을 모두 보낼 때까지 기다립니다. */
    async idle(): Promise<void> {
        while (this.sending) await this.sending;
    }

    /** 넘친 일반 알림을 묶음 알림 하나에 모읍니다. */
    private fold(pending: Pending): void {
        const {request} = pending;
        this.overflow ??= {count: 0, links: [], waiting: []};
        this.overflow.count++;
        this.overflow.waiting.push(pending.done);
        if (request.post && this.overflow.links.length < OVERFLOW_LINKS_MAX) {
            this.overflow.links.push({title: request.title, url: postUrl(request.post.galleryId, request.post.postNo)});
        }
    }

    private next(): Pending | null {
        const pending = this.queue.shift();
        if (pending) return pending;
        const overflow = this.overflow;
        if (!overflow) return null;
        this.overflow = null;
        const more = overflow.count > overflow.links.length ? `\n(아래 ${overflow.links.length}개 외 ${overflow.count - overflow.links.length}개)` : "";
        return {
            request: {title: `알림 ${overflow.count}개를 묶어 보냅니다`, description: `알림이 한꺼번에 많이 생겨 묶었습니다. 글을 직접 확인하세요.${more}`, links: overflow.links},
            done: (result) => overflow.waiting.forEach((done) => done(result))
        };
    }

    private async drain(): Promise<void> {
        const wait = this.deps.sleep ?? delay;
        try {
            for (let pending = this.next(); pending; pending = this.next()) {
                pending.done(await this.deliver(pending.request, wait));
                await wait(SEND_GAP_MS);
            }
        } finally {
            this.sending = null;
        }
    }

    private async deliver(request: NoticeRequest, wait: (ms: number) => Promise<void>): Promise<NoticeResult> {
        const {logger} = this.deps;
        const notice: DiscordNotice = {
            title: request.title,
            description: request.description,
            success: request.success,
            links: request.links,
            ...(request.post ? {url: postUrl(request.post.galleryId, request.post.postNo)} : {})
        };
        let failure: unknown = null;
        for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
            // 기다리는 사이 웹훅을 지웠으면 보내지 않습니다.
            const webhookUrl = this.deps.settings().discordWebhookUrl;
            if (!webhookUrl) return "no_webhook";
            try {
                await sendDiscordNotice(webhookUrl, notice);
                return "sent";
            } catch (error) {
                failure = error;
                if (!(error instanceof DiscordRateLimitError) || error.retryAfterMs > RETRY_AFTER_MAX_MS) break;
                await wait(error.retryAfterMs);
            }
        }
        logger.error(`Discord 알림 전송 실패: ${errorMessage(failure)}`, request.post);
        if (request.critical) this.deps.desktopNotice?.(`Hamboogie: ${request.title}`, request.description);
        return "failed";
    }
}
