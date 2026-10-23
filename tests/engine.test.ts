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
interface GalleryOptions {
    screen?: (titles: string[]) => number[];
    paidRpm?: number;
    /** 처음 몇 번의 골라내기를 실패시킵니다. */
    screenFailures?: number;
    /** 묶음 판단을 실패시킵니다. */
    batchFails?: boolean;
}

function withGallery(articles: Record<number, {title: string; body: string}>, options: GalleryOptions = {}) {
    const reads: number[] = [];
    const calls: string[][] = [];
    const env = setup();
    if (options.paidRpm !== undefined) env.update({llm: {...defaultSettings().llm, paidPlan: true, requestsPerMinute: options.paidRpm}});
    let listed: number[] = [];
    const engine = env.engine as unknown as {deps: EngineDeps; readGapMs: number; llm: () => unknown; idle(): Promise<void>; checkGallery(gallery: GalleryConfig, runId: number): Promise<void>};
    let screenFailures = options.screenFailures ?? 0;
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
            if (options.batchFails) throw new Error("응답 시간 초과");
            return posts.map(() => GIVEAWAY);
        },
        screen: async (posts: {title: string}[]) => {
            calls.push(["골라내기", ...posts.map((post) => post.title)]);
            if (screenFailures-- > 0) throw new Error("서버 과부하");
            return options.screen?.(posts.map((post) => post.title)) ?? [];
        }
    });
    /** 목록에 이 글들이 보이는 상태로 한 번 확인합니다. 감시 간격 계산에 쓰도록 설정의 갤러리도 바꿉니다. */
    const check = async (gallery: GalleryConfig, nos: number[]) => {
        env.update({galleries: [gallery]});
        listed = [1, ...nos];
        await engine.checkGallery(gallery, 0);
        // 판단은 목록 확인과 따로 돌므로 끝날 때까지 기다립니다.
        await engine.idle();
    };
    /** 목록에 보일 글을 바꿉니다(감시 타이머가 직접 확인할 때 씁니다). */
    const list = (nos: number[]) => {
        listed = [1, ...nos];
    };
    const run = async (gallery: GalleryConfig) => {
        await check(gallery, []);
        await check(gallery, Object.keys(articles).map(Number));
    };
    return {...env, engine: env.engine, reads, calls, run, check, list};
}

const decided = (calls: string[][]) => calls.filter((call) => call[0] !== "골라내기");

describe("Engine 본문 키워드 확인", () => {
    it("켜져 있으면 제목에 키워드가 없어도 본문에 있으면 판단한다", async () => {
        const {run, reads, calls, logger} = withGallery({8: {title: "테스트", body: "햄버거 선착 3명 뿌림"}, 9: {title: "잡담", body: "오늘 날씨 좋다"}});
        await run({...gallery, scanBody: true});
        expect(reads).toEqual([8, 9]);
        expect(decided(calls)).toEqual([["테스트"]]);
        expect(logged(logger, "본문 키워드")).toBe(true);
    });

    it("꺼져 있으면 제목에 키워드가 없는 글은 열지도 않는다", async () => {
        const {run, reads, calls} = withGallery({8: {title: "테스트", body: "햄버거 뿌림"}});
        await run({...gallery, scanBody: false, screenUnmatched: false});
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
    // 묶음 크기만 봅니다. 묶음에서 나눔이라는 판단은 남은 자리가 있으면 하나씩 다시 묻기 때문에 그 요청은 뺍니다.
    const sizes = (calls: string[][]) => {
        const all = decided(calls);
        const batchedTitles = new Set(all.filter((call) => call.length > 1).flat());
        return all.filter((call) => call.length > 1 || !batchedTitles.has(call[0]!)).map((call) => call.length);
    };
    const unmatched = {99: {title: "잡담", body: ""}};

    it("감시 간격이 1분 이상이면 한도(5회) 안에서 글마다 따로 보낸다", async () => {
        const {run, calls} = withGallery(many(4));
        await run(gallery);
        expect(sizes(calls)).toEqual([1, 1, 1, 1]);
    });

    it("넘으면 묶는다. 골라낼 글이 있으면 1회를 골라내기에 쓰고 판단은 4회로 묶는다", async () => {
        const withScreening = withGallery({...many(12), ...unmatched});
        await withScreening.run(gallery);
        expect(sizes(withScreening.calls)).toEqual([3, 3, 3, 3]);
        // 판단을 받은 글은 모두 처리한 글로 남습니다(로그인된 계정이 없어 알림으로 처리됩니다).
        expect(Array.from({length: 12}, (_, i) => withScreening.ledger.has("gf2", i + 2)).every(Boolean)).toBe(true);

        // 골라낼 글이 없으면 자리를 남겨 두지 않고 5회를 다 씁니다.
        const without = withGallery(many(12));
        await without.run(gallery);
        expect(sizes(without.calls)).toEqual([3, 3, 2, 2, 2]);
    });

    it("감시 간격이 30초면 1분에 두 번 확인하므로 한 번에 2회(골라내기 1 + 판단 1)만 쓴다", async () => {
        const {run, calls} = withGallery({...many(3), ...unmatched});
        await run({...gallery, intervalSec: 30});
        expect(calls.filter((call) => call[0] === "골라내기")).toHaveLength(1);
        expect(sizes(calls)).toEqual([3]);
    });

    it("한 번에 1회뿐이면 키워드에 걸린 글을 먼저 판단하고, 골라내기는 다음 확인으로 미룬다", async () => {
        const {check, calls} = withGallery({2: {title: "나눔 2", body: ""}, 3: {title: "잡담", body: ""}, 4: {title: "잡담 2", body: ""}});
        const fast = {...gallery, intervalSec: 10, scanBody: false};
        await check(fast, []);
        await check(fast, [2, 3]);
        expect(calls).toEqual([["나눔 2"]]);
        await check(fast, [2, 3, 4]);
        expect(calls.at(-1)).toEqual(["골라내기", "잡담", "잡담 2"]);
    });

    it("유료 요금제에서 0으로 두면 제한 없이 글마다 따로 보낸다", async () => {
        const {run, calls} = withGallery(many(12), {paidRpm: 0});
        await run(gallery);
        expect(sizes(calls)).toEqual(Array(12).fill(1));
    });

    it("묶음 판단이 실패하면 남은 요청 수로 감당되는 만큼 하나씩 다시 묻는다", async () => {
        const {run, calls} = withGallery(many(6), {batchFails: true, paidRpm: 20});
        await run({...gallery, screenUnmatched: false, intervalSec: 60 * 4});
        // 한도 20을 4분 간격 확인 하나가 다 쓰므로 묶지 않습니다. 묶음이 생기도록 한도를 줄여 다시 봅니다.
        expect(sizes(calls)).toEqual(Array(6).fill(1));

        const batched = withGallery(many(6), {batchFails: true});
        await batched.run({...gallery, screenUnmatched: false});
        // 5회 중 묶음 5번(2,1,1,1,1)을 쓰고 남은 자리가 없어, 실패한 묶음(글 2개)은 알림으로 넘깁니다.
        expect(sizes(batched.calls)).toEqual([2, 1, 1, 1, 1]);
        expect(batched.ledger.has("gf2", 2)).toBe(true);
    });

    it("키워드에 안 걸린 글은 하나로 묶어 골라내고, 고른 글은 본문을 읽은 뒤 판단한다", async () => {
        const {run, calls, reads} = withGallery(
            {2: {title: "치킨 나눔", body: ""}, 3: {title: "오늘 3시까지 ㄱㄱ", body: "고닉만"}, 4: {title: "잡담", body: "오늘 날씨"}},
            {screen: (titles) => titles.flatMap((title, index) => title.includes("3시") ? [index] : [])}
        );
        await run({...gallery, keywords: ["나눔"], scanBody: false});
        // 본문 확인을 꺼 두면 키워드에 걸린 글(2)만 먼저 열고, 3은 제목만으로 골라내기에 들어갔다가 골라진 뒤 본문을 읽습니다.
        expect(reads).toEqual([2, 3]);
        expect(calls.find((call) => call[0] === "골라내기")).toEqual(["골라내기", "오늘 3시까지 ㄱㄱ", "잡담"]);
        expect(decided(calls).flat().sort()).toEqual(["오늘 3시까지 ㄱㄱ", "치킨 나눔"]);
    });

    it("골라내기가 실패하면 다음 확인 때 같은 글을 다시 보낸다", async () => {
        const {check, calls} = withGallery({2: {title: "잡담", body: ""}, 3: {title: "잡담 2", body: ""}}, {screenFailures: 1});
        const noScan = {...gallery, scanBody: false};
        await check(noScan, []);
        await check(noScan, [2]);
        await check(noScan, [2, 3]);
        expect(calls).toEqual([["골라내기", "잡담"], ["골라내기", "잡담", "잡담 2"]]);
    });
});

describe("Engine 보안 점검 반영", () => {
    it("골라낸 글의 본문도 본문 요청 상한 안에서만 읽는다", async () => {
        const posts = Object.fromEntries(Array.from({length: 5}, (_, i) => [i + 2, {title: `잡담 ${i + 2}`, body: ""}]));
        // 글 하나가 LLM을 속여 모든 글을 고르게 만든 상황입니다.
        const {run, reads, logger} = withGallery(posts, {screen: (titles) => titles.map((_, index) => index)});
        await run({...gallery, scanBody: false, bodyReadLimit: 2});
        expect(reads).toHaveLength(2);
        expect(logged(logger, "본문 요청 상한(2개)을 넘어")).toBe(true);
    });

    it("본문을 읽지 못한 글은 줄 서라는 판단이 나와도 알림으로 넘긴다", async () => {
        const {run, written, logger, engine} = withGallery({2: {title: "a", body: ""}, 3: {title: "b", body: ""}});
        const deps = (engine as unknown as {deps: EngineDeps}).deps;
        Object.assign(deps.accounts, {candidates: () => [{id: "a", memberType: "gonick", dccons: []}]});
        await run({...gallery, keywords: [], bodyReadLimit: 1});
        // 본문을 읽은 3번 글만 줄을 서고, 상한을 넘어 읽지 못한 2번 글은 알림으로 넘깁니다.
        await vi.waitFor(() => expect(written).toEqual([["a", 3]]));
        expect(logged(logger, "본문을 확인하지 못했습니다")).toBe(true);
    });

    it("묶어 판단한 글 중 나눔이라는 판단은 남은 자리가 있으면 따로 다시 묻고, 없으면 알림으로 넘긴다", async () => {
        const many = Object.fromEntries(Array.from({length: 6}, (_, i) => [i + 2, {title: `나눔 ${i + 2}`, body: ""}]));
        // 한도 10에 30초 간격이면 한 번에 5회만 써서 묶음이 생기고, 1분 한도에는 5자리가 남습니다.
        const spare = withGallery(many, {paidRpm: 10});
        await spare.run({...gallery, screenUnmatched: false, intervalSec: 30});
        const batched = decided(spare.calls).filter((call) => call.length > 1).flat();
        const single = decided(spare.calls).filter((call) => call.length === 1).flat();
        expect(batched.length).toBeGreaterThan(0);
        expect(batched.every((title) => single.includes(title))).toBe(true);

        // 무료 등급(분당 5회)을 다 쓴 경우: 묶음 속 글은 다시 묻지 않고 알립니다.
        const full = withGallery(many);
        await full.run({...gallery, screenUnmatched: false});
        expect(decided(full.calls)).toHaveLength(5);
        expect(logged(full.logger, "묶어 판단한 결과라")).toBe(true);
    });
});

describe("Engine 기준 글과 본문 요청 상한", () => {
    it("키워드가 비어 있어도 본문 요청 상한을 지키고, 넘는 글은 제목으로만 판단한다", async () => {
        const {run, reads, calls} = withGallery({2: {title: "a", body: ""}, 3: {title: "b", body: ""}, 4: {title: "c", body: ""}, 5: {title: "d", body: ""}});
        await run({...gallery, keywords: [], bodyReadLimit: 2});
        expect(reads).toEqual([4, 5]);
        expect(decided(calls).flat().sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("감시 중에 다시 시작해도 기준 글을 유지해 그사이 올라온 글을 건너뛰지 않는다", async () => {
        const {check, list, engine, calls} = withGallery({2: {title: "나눔 2", body: ""}});
        await check(gallery, []);
        list([2]);
        engine.start();
        await vi.waitFor(() => expect(decided(calls)).toEqual([["나눔 2"]]));
        engine.stop();
    });
});
