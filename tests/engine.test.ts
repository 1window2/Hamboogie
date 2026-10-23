import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {defaultSettings, newGallery} from "@shared/settings";
import type {GalleryConfig, HistoryEntry, Settings} from "@shared/types";
import {CommentNotPostedError} from "../src/main/dc/accounts";
import {AppIdBackoff} from "../src/main/dc/app-id-backoff";
import {Engine, type EngineDeps} from "../src/main/pipeline/engine";
import {Logger} from "../src/main/logger";
import {Ledger} from "../src/main/store";

const gallery: GalleryConfig = {...newGallery("g"), galleryId: "gf2", checkedId: "gf2", accountIds: ["a", "b"]};
const LIVE = {live: {epoch: 0}};

function setup(options: {notifyOnSuccess?: boolean; write?: (accountId: string, postNo: number) => Promise<void>} = {}) {
    const dir = mkdtempSync(join(tmpdir(), "hamboogie-engine-"));
    const ledger = new Ledger(dir);
    const logger = new Logger(join(dir, "test.log"));
    const written: [string, number][] = [];
    const recorded: HistoryEntry[] = [];
    let settings: Settings = {...defaultSettings(), notifyOnSuccess: options.notifyOnSuccess ?? false, galleries: [gallery]};
    const deps = {
        ledger,
        appId: new AppIdBackoff(),
        history: {add: (entry: HistoryEntry) => recorded.push(entry)},
        logger,
        settings: () => settings,
        accounts: {
            candidates: () => [],
            maintain: async () => false,
            nickname: (id: string) => `계정${id}`,
            writeComment: async (accountId: string, _galleryId: string, postNo: number) => {
                await options.write?.(accountId, postNo);
                written.push([accountId, postNo]);
            }
        }
    } as unknown as EngineDeps;
    const update = (patch: Partial<Settings>) => {
        settings = {...settings, ...patch};
    };
    return {engine: new Engine(deps), ledger, logger, written, recorded, update};
}

function plan(delayMs: number, patch: Record<string, unknown> = {}) {
    return {
        kind: "comment" as const,
        notBefore: Date.now() + delayMs,
        requirement: "any" as const,
        isFood: true,
        attempts: [
            {accountId: "a", content: {type: "text" as const, text: "줄"}},
            {accountId: "b", content: {type: "text" as const, text: "줄"}}
        ],
        ...patch
    };
}

const logged = (logger: Logger, text: string) => logger.recent().some((entry) => entry.message.includes(text));

describe("Engine 예약과 멈춤", () => {
    it("시각이 되면 줄을 서고 처리 기록과 줄 서기 기록이 남는다", async () => {
        const {engine, ledger, written, recorded} = setup();
        await engine.dispatch(gallery, {no: 11, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
        expect(written).toEqual([["a", 11]]);
        expect(recorded[0]).toMatchObject({postNo: 11, outcome: "success", detail: "계정a 계정으로 \"줄\""});
        expect(ledger.has("gf2", 11)).toBe(true);
    });

    it("감시를 멈추면 예약된 줄 서기를 취소하고 기록에 남긴다", async () => {
        const {engine, written, recorded} = setup();
        await engine.dispatch(gallery, {no: 10, title: "3시부터 나눔"}, plan(60_000), LIVE);
        engine.stop();
        expect(written).toEqual([]);
        expect(recorded).toEqual([expect.objectContaining({postNo: 10, outcome: "failure", detail: expect.stringContaining("감시를 멈춰")})]);
    });

    it("멈춘 뒤에 분석이 끝난 글은 처리하지 않는다", async () => {
        const {engine, ledger, written} = setup();
        engine.stop();
        // 멈추기 전(세대 0)에 시작한 분석이 이제 끝난 상황입니다.
        await engine.dispatch(gallery, {no: 12, title: "나눔"}, plan(0), LIVE);
        await new Promise((resolve) => setImmediate(resolve));
        expect(written).toEqual([]);
        expect(ledger.has("gf2", 12)).toBe(false);
    });

    it("감시를 다시 시작해도 예약된 줄 서기는 유지된다", async () => {
        const {engine, written} = setup();
        await engine.dispatch(gallery, {no: 13, title: "나눔"}, plan(30), LIVE);
        engine.start();
        await vi.waitFor(() => expect(written).toEqual([["a", 13]]));
        engine.stop();
    });
});

describe("Engine 실행 직전 확인", () => {
    it("예약해 둔 사이 마감이 지났으면 댓글을 달지 않고 실패로 기록한다", async () => {
        const {engine, written, recorded} = setup();
        await engine.dispatch(gallery, {no: 30, title: "3시까지 나눔"}, plan(30, {deadline: Date.now() + 10}), LIVE);
        await vi.waitFor(() => expect(recorded).toEqual([expect.objectContaining({postNo: 30, outcome: "failure", detail: expect.stringContaining("마감")})]));
        expect(written).toEqual([]);
    });

    it("예약한 뒤 갤러리를 끄거나 대기 계정에서 빼면 반영한다", async () => {
        const off = setup();
        await off.engine.dispatch(gallery, {no: 31, title: "나눔"}, plan(20), LIVE);
        off.update({galleries: [{...gallery, enabled: false}]});
        await vi.waitFor(() => expect(off.recorded).toEqual([expect.objectContaining({postNo: 31, detail: expect.stringContaining("감시 설정이 바뀌어")})]));
        expect(off.written).toEqual([]);

        const removed = setup();
        await removed.engine.dispatch(gallery, {no: 32, title: "나눔"}, plan(20), LIVE);
        removed.update({galleries: [{...gallery, accountIds: ["b"]}]});
        await vi.waitFor(() => expect(removed.written).toEqual([["b", 32]]));
    });

    it("나눔 종류를 '음식만'으로 바꾸면 음식이 아닌 나눔은 취소한다", async () => {
        const {engine, written, recorded, update} = setup();
        update({galleries: [{...gallery, category: "all"}]});
        await engine.dispatch({...gallery, category: "all"}, {no: 33, title: "쿠폰 나눔"}, plan(20, {isFood: false}), LIVE);
        update({galleries: [{...gallery, category: "food"}]});
        await vi.waitFor(() => expect(recorded).toEqual([expect.objectContaining({postNo: 33, detail: expect.stringContaining("음식만")})]));
        expect(written).toEqual([]);
    });
});

describe("Engine 글 하나에 댓글 하나", () => {
    it("확실히 안 달린 실패면 다음 계정이 시도한다", async () => {
        const {engine, written} = setup({
            write: async (accountId) => {
                if (accountId === "a") throw new CommentNotPostedError("로그인되지 않은 계정입니다.");
            }
        });
        await engine.dispatch(gallery, {no: 40, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(written).toEqual([["b", 40]]));
    });

    it("결과를 알 수 없는 실패(응답 시간 초과 등)면 다른 계정으로 또 달지 않고 알린다", async () => {
        const tried: string[] = [];
        const {engine, written, recorded, logger} = setup({
            write: async (accountId) => {
                tried.push(accountId);
                const error = new Error("The operation was aborted due to timeout");
                error.name = "TimeoutError";
                throw error;
            }
        });
        await engine.dispatch(gallery, {no: 41, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
        expect(tried).toEqual(["a"]);
        expect(written).toEqual([]);
        expect(recorded[0]).toMatchObject({outcome: "failure", detail: expect.stringContaining("결과를 알 수 없음")});
        expect(logged(logger, "결과 불명")).toBe(true);
    });
});

describe("Engine 성공 알림", () => {
    it("기본값(꺼짐)이면 성공해도 알리지 않고, 켜면 알린다", async () => {
        const off = setup();
        await off.engine.dispatch(gallery, {no: 20, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(off.recorded).toHaveLength(1));
        expect(logged(off.logger, "Discord 웹훅이 설정되지 않아")).toBe(false);

        const on = setup({notifyOnSuccess: true});
        await on.engine.dispatch(gallery, {no: 21, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(logged(on.logger, "Discord 웹훅이 설정되지 않아")).toBe(true));
    });
});

const GIVEAWAY = {
    is_giveaway: true, is_food: true, line_method: "text" as const, line_text: null, dccon_keyword: null,
    member_requirement: "any" as const, starts_at: null, ends_at: null, needs_extra_action: false, reason: "나눔"
};

/** 목록, 본문, LLM을 가짜로 바꾼 감시 한 번을 돌립니다. 첫 확인으로 기준점을 잡은 뒤 `articles`의 글이 새로 올라온 것으로 봅니다. */
function withGallery(articles: Record<number, {title: string; body: string}>, options: {screen?: (titles: string[]) => number[]; rpm?: number} = {}) {
    const reads: number[] = [];
    const calls: string[][] = [];
    const env = setup();
    env.update({llm: {...defaultSettings().llm, requestsPerMinute: options.rpm ?? 5}});
    let listed: number[] = [];
    const engine = env.engine as unknown as {deps: EngineDeps; readGapMs: number; llm: () => unknown; checkGallery(gallery: GalleryConfig, runId: number): Promise<void>};
    engine.readGapMs = 0;
    Object.assign(engine.deps, {
        reader: () => ({
            articles: {
                list: async () => ({gall_list: listed.map((no) => ({no, subject: articles[no]?.title ?? "기존 글"})).reverse()}),
                read: async (_gallery: string, no: number) => {
                    reads.push(no);
                    return {view_info: {subject: articles[no]!.title}, view_main: {memo: articles[no]!.body}};
                }
            }
        }),
        onReadSucceeded: async () => {}
    });
    engine.llm = () => ({
        decide: async (post: {title: string}) => {
            calls.push([post.title]);
            return GIVEAWAY;
        },
        decideMany: async (posts: {title: string}[]) => {
            calls.push(posts.map((post) => post.title));
            return posts.map(() => GIVEAWAY);
        },
        screen: async (posts: {title: string}[]) => {
            calls.push(["골라내기", ...posts.map((post) => post.title)]);
            return options.screen?.(posts.map((post) => post.title)) ?? [];
        }
    });
    const run = async (gallery: GalleryConfig) => {
        listed = [1];
        await engine.checkGallery(gallery, 0);
        listed = [1, ...Object.keys(articles).map(Number)];
        await engine.checkGallery(gallery, 0);
    };
    return {...env, reads, calls, run};
}

const decided = (calls: string[][]) => calls.filter((call) => call[0] !== "골라내기");

describe("Engine 본문 키워드 확인", () => {
    it("켜져 있으면 제목에 키워드가 없어도 본문에 있으면 판단한다", async () => {
        const {run, reads, calls, logger} = withGallery({8: {title: "테스트", body: "햄버거 선착 3명 뿌림"}, 9: {title: "잡담", body: "오늘 날씨 좋다"}});
        await run({...gallery, scanBody: true});
        expect(reads).toEqual([8, 9]);
        expect(calls).toEqual([["테스트"]]);
        expect(logged(logger, "본문 키워드")).toBe(true);
    });

    it("꺼져 있으면 제목에 키워드가 없는 글은 열지도 않는다", async () => {
        const {run, reads, calls} = withGallery({8: {title: "테스트", body: "햄버거 뿌림"}});
        await run({...gallery, scanBody: false});
        expect(reads).toEqual([]);
        expect(calls).toEqual([]);
    });

    it("본문에 제외 키워드가 있으면 넘어간다", async () => {
        const {run, calls} = withGallery({8: {title: "치킨 나눔", body: "구매 인증한 사람만"}});
        await run({...gallery, scanBody: true, excludeKeywords: ["인증"]});
        expect(calls).toEqual([]);
    });

    it("본문 요청 상한을 넘으면 최근 글만 열고, 제목에 키워드가 있는 글은 상한과 상관없이 연다", async () => {
        const {run, reads, logger} = withGallery({
            2: {title: "잡담1", body: ""}, 3: {title: "잡담2", body: ""}, 4: {title: "치킨 나눔", body: ""}, 5: {title: "잡담3", body: ""}, 6: {title: "잡담4", body: ""}
        });
        await run({...gallery, scanBody: true, bodyReadLimit: 2});
        expect(reads).toEqual([4, 5, 6]);
        expect(logged(logger, "최근 2개만 본문을 확인")).toBe(true);
    });

    it("상한이 0이면 모두 연다", async () => {
        const {run, reads} = withGallery({2: {title: "a", body: ""}, 3: {title: "b", body: ""}, 4: {title: "c", body: ""}});
        await run({...gallery, scanBody: true, bodyReadLimit: 0});
        expect(reads).toEqual([2, 3, 4]);
    });
});

describe("Engine LLM 요청 묶기", () => {
    const many = (count: number) => Object.fromEntries(Array.from({length: count}, (_, i) => [i + 2, {title: `나눔 ${i + 2}`, body: ""}]));

    it("분당 한도 이하면 글마다 따로 보낸다", async () => {
        const {run, calls} = withGallery(many(3));
        await run(gallery);
        expect(calls).toHaveLength(3);
        expect(calls.every((call) => call.length === 1)).toBe(true);
    });

    it("한도를 넘으면 한도만큼의 요청으로 묶는다", async () => {
        const {run, calls, ledger} = withGallery(many(12));
        await run(gallery);
        expect(calls.map((call) => call.length)).toEqual([3, 3, 2, 2, 2]);
        // 판단을 받은 글은 모두 처리한 글로 남습니다(로그인된 계정이 없어 알림으로 처리됩니다).
        expect(Array.from({length: 12}, (_, i) => ledger.has("gf2", i + 2)).every(Boolean)).toBe(true);
    });

    it("키워드에 안 걸린 글은 하나로 묶어 골라내고, 고른 글만 판단한다", async () => {
        const {run, calls, reads} = withGallery(
            {2: {title: "치킨 나눔", body: ""}, 3: {title: "오늘 3시까지 ㄱㄱ", body: ""}, 4: {title: "잡담", body: "오늘 날씨"}},
            {screen: (titles) => titles.flatMap((title, index) => title.includes("3시") ? [index] : [])}
        );
        await run({...gallery, keywords: ["나눔"], scanBody: true, bodyReadLimit: 1, screenUnmatched: true});
        // 상한 1이라 최근 글(4)만 본문을 열고, 3은 제목만으로 골라내기에 들어갑니다.
        expect(reads).toEqual([2, 4]);
        expect(calls.find((call) => call[0] === "골라내기")).toEqual(["골라내기", "오늘 3시까지 ㄱㄱ", "잡담"]);
        expect(decided(calls).flat().sort()).toEqual(["오늘 3시까지 ㄱㄱ", "치킨 나눔"]);
    });
});
