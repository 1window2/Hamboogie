import {ApiError, type DCInside, type PostItem} from "@green-1052/dcinside.js";
import {errorMessage} from "@shared/errors";
import {delay} from "@shared/time";
import type {GalleryConfig} from "@shared/types";
import {isAppIdFailure, isLoginExpired} from "../dc/accounts";
import {postImageUrls} from "../dc/post-images";
import {htmlToText} from "../dc/text";
import {NotLoggedInError, postedTimes, type Candidate, type NewPost} from "./candidate";
import type {PostContent} from "./dispatcher";
import type {EngineDeps} from "./engine";
import {findKeyword, matchesKeywords} from "./keyword-filter";
import {postedAtRange} from "./post-time";

/** 한 번 확인할 때 최대로 넘겨볼 목록 페이지 수입니다. */
export const MAX_PAGES_PER_TICK = 3;
/** 본문을 연달아 읽을 때 사이에 둘 간격입니다. 새 글이 많을 때 요청이 한꺼번에 몰리지 않게 합니다. */
const BODY_READ_GAP_MS = 500;
/** 확인 한 번에 본문 읽기가 이만큼 연달아 실패하면 남은 글은 다음 확인 때 다시 읽습니다. */
const READ_FAILURES_PER_TICK = 2;
/** 본문 읽기에 실패해 다음 확인에서 다시 읽을 글을 기억하는 최대 수입니다. */
const FAILED_READS_MAX = 200;

/** 디시가 지워진 글에 주는 오류입니다. */
function isDeletedPost(error: unknown): boolean {
    return /삭제했거나 존재하지 않는/.test(errorMessage(error));
}

export interface CollectorHost {
    deps: EngineDeps;
    now(): number;
    /** 그 갤러리의 대기 계정으로 읽기 요청을 보냅니다. */
    read<T>(gallery: GalleryConfig, request: (client: DCInside) => Promise<T>): Promise<T>;
    /** 읽기가 app_id 거절이나 로그인 만료로 실패했을 때 처리합니다. */
    recoverReader(error: unknown, gallery: GalleryConfig): Promise<void>;
    excludedBy(gallery: GalleryConfig, text: string): string | null;
}

/** 갤러리 목록과 글 본문을 읽어 LLM에 보낼 글을 모읍니다. */
export class PostCollector {
    /** 본문 읽기 사이의 간격입니다. 테스트에서 줄입니다. */
    readGapMs = BODY_READ_GAP_MS;
    /** 다음 본문을 읽어도 되는 시각입니다. 갤러리 여러 개가 함께 읽어도 간격을 지킵니다. */
    private nextReadAt = 0;
    /**
     * 본문 읽기가 연달아 실패해 그 글부터 다음 확인으로 미룬 글입니다(`갤러리ID:글번호`). 다음 확인에서 그 글이 또 실패하면
     * 그 글만의 문제(비밀글, 성인 인증 글 등)로 보고 제목만 판단하고 넘어갑니다. 읽을 수 없는 글 하나가 확인마다 진행을 막아
     * 그 뒤의 글이 한참 늦게 판단되는 일을 막습니다.
     */
    private readonly failedReads = new Set<string>();

    constructor(private readonly host: CollectorHost) {}

    /** 목록을 최대 `MAX_PAGES_PER_TICK`페이지까지 읽습니다. 첫 확인이거나 이미 본 글이 나오면 더 넘기지 않습니다. */
    async list(gallery: GalleryConfig, lastSeen: number | undefined): Promise<{collected: Map<number, NewPost>; reachedLastSeen: boolean}> {
        const collected = new Map<number, NewPost>();
        let reachedLastSeen = false;
        for (let page = 1; page <= MAX_PAGES_PER_TICK; page++) {
            const response = await this.host.read(gallery, (client) => client.articles.list({gallery: gallery.galleryId, page}));
            this.host.deps.appId.succeed();
            const items = (response.gall_list ?? []).filter((item: PostItem) => typeof item.no === "number" && Number.isInteger(item.no) && !item.fixtop);
            for (const item of items) collected.set(item.no!, {no: item.no!, title: item.subject ?? "", ...(item.date_time ? {dateTime: item.date_time} : {})});
            reachedLastSeen = items.length === 0 || (lastSeen !== undefined && items.some((item) => item.no! <= lastSeen));
            if (lastSeen === undefined || reachedLastSeen) break;
        }
        return {collected, reachedLastSeen};
    }

    /**
     * 새 글을 오래된 순서로 보며 LLM에 보낼 글을 모읍니다. 그사이 감시가 다시 시작되면(`current`가 false) null입니다.
     * 본문은 키워드에 걸린 글은 늘 읽고, 나머지는 최근 글부터 본문 요청 상한까지 읽습니다(본문 확인을 끄면 키워드에 걸린 글만).
     * 본문을 읽지 않은 글은 제목만 보냅니다. `last`는 끝까지 본 마지막 글 번호입니다.
     */
    async collect(gallery: GalleryConfig, posts: NewPost[], current: () => boolean): Promise<{candidates: Candidate[]; last: number | null} | null> {
        const {ledger, logger} = this.host.deps;
        const fresh = posts.filter((post) => !ledger.has(gallery.galleryId, post.no) && !this.host.excludedBy(gallery, post.title));
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
            if (!current()) return null;
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
        const {ledger, logger} = this.host.deps;
        if (ledger.has(gallery.galleryId, post.no)) return "done";
        const context = {galleryId: gallery.galleryId, postNo: post.no};
        const excludedByTitle = this.host.excludedBy(gallery, post.title);
        if (excludedByTitle) {
            if (titleKeyword) logger.info(`넘어감: 제목에 제외 키워드 "${excludedByTitle}"`, context);
            return "done";
        }
        const detectedAt = this.host.now();
        const listed = postedAtRange([post.dateTime], detectedAt);
        const titleOnly: Candidate = {post, title: post.title, body: "", bodyRead: false, keyword: titleKeyword, detectedAt, ...postedTimes(listed), images: []};
        if (!read) return titleOnly;
        if (!this.host.deps.appId.canTry()) return "retry";

        await this.paceRead();
        const failedKey = `${gallery.galleryId}:${post.no}`;
        let article: Awaited<ReturnType<DCInside["articles"]["read"]>>;
        try {
            article = await this.host.read(gallery, (client) => client.articles.read(gallery.galleryId, post.no));
        } catch (error) {
            // 금방 지워진 글은 알릴 필요가 없습니다.
            if (isDeletedPost(error)) return "done";
            // app_id 거절이나 로그인 만료면 처리한 뒤 이 글부터 다음에 다시 봅니다. 알리거나 처리한 글로 남기지 않고,
            // 남은 글을 계속 읽어 로그인 재시도를 쌓지 않습니다. 로그인된 계정이 없어진 경우도 같습니다.
            if (error instanceof NotLoggedInError) return "retry";
            if (isAppIdFailure(error) || isLoginExpired(error)) {
                await this.host.recoverReader(error, gallery);
                return "retry";
            }
            // 디시가 이 글을 읽기를 명시적으로 거절했으면(비밀글, 성인 인증 글 등) 서버는 응답하고 있는 것이므로 이 글만의 문제입니다.
            // 연속 실패로 세지 않고 제목만 판단하고 넘어갑니다. 읽을 수 없는 글을 잔뜩 올려 뒤의 글 판단을 늦추지 못하게 하기 위해서입니다.
            if (error instanceof ApiError) {
                logger.warn(`디시가 본문 읽기를 거절해 제목만 판단합니다: ${errorMessage(error)}`, context);
                return titleOnly;
            }
            // 지난 확인에서 이 글부터 미뤘는데 또 실패하면 이 글만의 문제로 보고 제목만 판단하고 넘어갑니다(진행을 막지 않게).
            if (this.failedReads.delete(failedKey)) {
                logger.warn(`지난 확인에 이어 본문을 또 읽지 못해 제목만 판단합니다: ${errorMessage(error)}`, context);
                return titleOnly;
            }
            // 차단이나 서버 오류처럼 계속 실패할 수 있는 오류가 이번 확인에서 연달아 나면, 요청을 쌓지 않도록 남은 글은 다음 확인 때 다시 읽습니다.
            if (++failures.reads >= READ_FAILURES_PER_TICK) {
                logger.warn(`본문 읽기가 연달아 실패해 이 글부터는 다음 확인 때 다시 읽습니다: ${errorMessage(error)}`, context);
                this.rememberFailedRead(failedKey);
                return "retry";
            }
            // 이 글만의 문제(성인 인증 글 등)일 수 있으니 제목만 판단하고 넘어갑니다(본문을 못 본 글은 자동으로 줄 서지 않습니다).
            logger.warn(`본문을 읽지 못해 제목만 판단합니다: ${errorMessage(error)}`, context);
            return titleOnly;
        }
        // 연달아 실패한 것만 세도록, 읽기에 성공하면 다시 셉니다.
        failures.reads = 0;
        this.failedReads.delete(failedKey);

        const title = article.view_info?.subject ?? post.title;
        const dateTime = article.view_info?.date_time;
        const body = htmlToText(article.view_main?.memo ?? "");
        const images = postImageUrls(article.view_main?.memo ?? "");
        // 목록을 읽은 뒤 제목을 고쳤을 수 있어 본문을 읽을 때의 제목도 제외 키워드를 봅니다.
        const excludedByBody = (title !== post.title ? this.host.excludedBy(gallery, title) : null) ?? this.host.excludedBy(gallery, body);
        if (excludedByBody) {
            if (titleKeyword) logger.info(`넘어감: 제목이나 본문에 제외 키워드 "${excludedByBody}"`, context);
            return "done";
        }
        const keyword = titleKeyword || (gallery.keywords.length > 0 && (findKeyword(body, gallery.keywords) !== null || findKeyword(title, gallery.keywords) !== null));
        const posted = postedAtRange([dateTime, post.dateTime], detectedAt);
        return {post, title, body, bodyRead: true, keyword, detectedAt, ...postedTimes(posted), images, ...(dateTime ? {dateTime} : {})};
    }

    private rememberFailedRead(key: string): void {
        this.failedReads.add(key);
        if (this.failedReads.size > FAILED_READS_MAX) this.failedReads.delete(this.failedReads.values().next().value!);
    }

    /** 글을 다시 읽습니다(예약해 둔 줄 서기를 달기 직전 확인). 지워졌으면 null입니다. */
    async readPost(gallery: GalleryConfig, postNo: number): Promise<PostContent | null> {
        try {
            const article = await this.host.read(gallery, (client) => client.articles.read(gallery.galleryId, postNo));
            const memo = article.view_main?.memo ?? "";
            return {title: article.view_info?.subject ?? "", body: htmlToText(memo), images: postImageUrls(memo)};
        } catch (error) {
            if (isDeletedPost(error)) return null;
            throw error;
        }
    }

    /** 본문 읽기 사이에 간격을 둡니다. */
    private async paceRead(): Promise<void> {
        const now = this.host.now();
        const wait = this.nextReadAt - now;
        this.nextReadAt = Math.max(now, this.nextReadAt) + this.readGapMs;
        if (wait > 0) await delay(wait);
    }
}
