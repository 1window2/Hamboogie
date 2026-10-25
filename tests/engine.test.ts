import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {defaultSettings, newGallery, nextAutoStopAt, normalizeSettings} from "@shared/settings";
import type {GalleryConfig, HistoryEntry, Settings} from "@shared/types";
import {AuthExpiredError, CaptchaRequiredError} from "@green-1052/dcinside.js";
import {CommentNotPostedError} from "../src/main/dc/accounts";
import {LlmQuotaExhaustedError} from "../src/main/llm/providers";
import {LlmUsage} from "../src/main/llm/usage";
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

describe("Engine dcinside.js 2.0.2 오류 대응", () => {
    it("보안 코드가 걸린 갤러리면 다음 계정으로 넘어가지 않고 알린다", async () => {
        const tried: string[] = [];
        const {engine, written, recorded} = setup({
            write: async (accountId) => {
                tried.push(accountId);
                throw new CaptchaRequiredError("코드가 설정된 갤러리입니다.", null);
            }
        });
        await engine.dispatch(gallery, {no: 50, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
        expect(tried).toEqual(["a"]);
        expect(written).toEqual([]);
        expect(recorded[0]).toMatchObject({outcome: "failure", detail: expect.stringContaining("보안 코드")});
    });

    it("글을 읽던 계정의 로그인이 풀리면 그 클라이언트의 계정을 처리하고, 내려놓았을 때만 알린다", async () => {
        const client = {articles: {list: async () => {
            throw new AuthExpiredError("login", "로그인이 필요합니다.", null);
        }}};
        const run = async (outcome: "recovered" | "expired" | "none") => {
            const env = setup();
            const calls: unknown[] = [];
            const deps = (env.engine as unknown as {deps: EngineDeps}).deps;
            Object.assign(deps, {
                reader: () => client,
                onReaderLoginExpired: async (which: unknown) => {
                    calls.push(which);
                    return outcome;
                }
            });
            await (env.engine as unknown as {tick(configId: string, runId: number): Promise<void>}).tick(gallery.id, 0);
            env.engine.stop();
            return {calls, logger: env.logger};
        };
        const expired = await run("expired");
        expect(expired.calls).toEqual([client]);
        expect(logged(expired.logger, "다음 계정으로 읽습니다")).toBe(true);
        // 웹훅이 없어 알림 대신 남는 경고로 알림 시도를 확인합니다.
        expect(logged(expired.logger, "Discord 웹훅이 설정되지 않아")).toBe(true);

        const anonymous = await run("none");
        expect(logged(anonymous.logger, "Discord 웹훅이 설정되지 않아")).toBe(false);
        const recovered = await run("recovered");
        expect(logged(recovered.logger, "OTP 토큰으로 다시 로그인")).toBe(true);
    });
});

describe("Engine 로그인 필수", () => {
    it("로그인된 계정이 없으면 디시에 요청하지 않고, 한 번만 알린다", async () => {
        const {engine, logger} = setup();
        const deps = (engine as unknown as {deps: EngineDeps}).deps;
        Object.assign(deps, {reader: () => null});
        const tick = (engine as unknown as {tick(configId: string, runId: number): Promise<void>}).tick.bind(engine);
        await tick(gallery.id, 0);
        await tick(gallery.id, 0);
        engine.stop();
        const warnings = logger.recent().filter((entry) => entry.message.includes("로그인된 계정이 없어 디시에 요청하지 않고"));
        expect(warnings).toHaveLength(1);
    });

    it("대기 계정이 아직 로그인하는 중이면 알리지 않고 다음 확인을 기다린다", async () => {
        const {engine, logger} = setup();
        const deps = (engine as unknown as {deps: EngineDeps}).deps;
        Object.assign(deps, {reader: () => null});
        Object.assign(deps.accounts, {status: () => ({state: "logging_in"})});
        await (engine as unknown as {tick(configId: string, runId: number): Promise<void>}).tick(gallery.id, 0);
        engine.stop();
        expect(logged(logger, "로그인된 계정이 없어 디시에 요청하지 않고")).toBe(false);
    });

    it("글을 읽는 도중 로그인된 계정이 없어지면 남은 글은 읽지 않고 다음 확인 때 다시 본다", async () => {
        const {run, reads, engine} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "피자 나눔", body: ""}});
        const deps = (engine as unknown as {deps: EngineDeps}).deps;
        const original = deps.reader;
        let calls = 0;
        // 목록(첫 확인, 두 번째 확인)과 첫 글 읽기까지는 로그인돼 있다가 그 뒤로 로그인이 사라진 상황입니다.
        deps.reader = (target) => (++calls <= 3 ? original(target) : null);
        await run({...gallery, keywords: ["나눔"]});
        expect(reads).toEqual([2]);
    });
});

describe("Engine LLM 한도 소진", () => {
    it("한도를 다 썼다는 오류가 오면 초기화될 때까지 LLM에 묻지 않고, 한 번만 알린다", async () => {
        const env = setup();
        const engine = env.engine as unknown as {llm: () => unknown; provider: unknown; deps: EngineDeps};
        let calls = 0;
        const quota = new LlmQuotaExhaustedError("Gemini 요청 한도를 다 썼습니다.", Date.now() + 60_000);
        // 실제 llm()이 감싸는 경로를 타도록, 만든 클라이언트 자리에 가짜를 넣습니다.
        Object.assign(engine.deps, {secrets: {get: () => "key"}});
        const realLlm = (engine.llm as () => unknown).bind(env.engine);
        realLlm();
        const wrap = (env.engine as unknown as {watchQuota(provider: unknown): unknown}).watchQuota.bind(env.engine);
        (engine.provider as {instance: unknown}).instance = wrap({
            decide: async () => {
                calls++;
                throw quota;
            }
        });
        const analyze = () => env.engine.analyze(gallery, "나눔", "", Date.now());
        expect((await analyze()).plan).toMatchObject({kind: "notify", reason: expect.stringContaining("한도를 다 썼습니다")});
        expect((await analyze()).plan).toMatchObject({kind: "notify"});
        expect(calls).toBe(1);
        expect(env.logger.recent().filter((entry) => entry.message.includes("LLM 판단을 멈춥니다"))).toHaveLength(1);
    });
});

describe("Engine 성공 알림", () => {
    it("성공 알림에 줄을 서기로 한 LLM의 근거를 함께 보낸다", async () => {
        const env = setup({notifyOnSuccess: true});
        const sent: string[] = [];
        (env.engine as unknown as {alert: (title: string, description: string) => Promise<void>}).alert = async (_title, description) => {
            sent.push(description);
        };
        await env.engine.dispatch(gallery, {no: 22, title: "나눔"}, plan(0, {basis: "햄버거 기프티콘 선착 나눔"}), LIVE);
        await vi.waitFor(() => expect(sent).toEqual(["계정a 계정으로 \"줄\"\n판단 근거: 햄버거 기프티콘 선착 나눔"]));
    });

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
const NOT_GIVEAWAY = {...GIVEAWAY, is_giveaway: false, reason: "잡담"};

interface GalleryOptions {
    /** 묶음 판단에서 나눔으로 볼 글입니다. 기본은 제목이나 본문에 "나눔"이 있는 글입니다. */
    giveaway?: (post: {title: string; body: string}) => boolean;
    /** 2차 확인(글 하나로 다시 묻기)에서 나눔으로 볼 글입니다. 기본은 `giveaway`와 같습니다. */
    confirm?: (post: {title: string; body: string}) => boolean;
    /** 유료 요금제의 분당 요청 수입니다. 없으면 무료 등급입니다. */
    paidRpm?: number;
    /** 묶음 판단을 실패시킵니다. */
    batchFails?: boolean;
    /** 줄을 설 수 있는 로그인된 계정이 있게 합니다. */
    loggedIn?: boolean;
    usage?: LlmUsage;
}

/** 목록, 본문, LLM을 가짜로 바꾼 감시를 돌립니다. 첫 확인으로 기준점을 잡은 뒤 `articles`의 글이 새로 올라온 것으로 봅니다. */
function withGallery(articles: Record<number, {title: string; body: string}>, options: GalleryOptions = {}) {
    const reads: number[] = [];
    /** LLM 요청입니다. 묶음은 ["묶음", 제목...], 글 하나는 ["단독", 제목]입니다. */
    const calls: string[][] = [];
    const env = setup();
    if (options.paidRpm !== undefined) env.update({llm: {...defaultSettings().llm, paidPlan: true, requestsPerMinute: options.paidRpm}});
    let listed: number[] = [];
    const engine = env.engine as unknown as {deps: EngineDeps; readGapMs: number; usage: LlmUsage; llm: () => unknown; idle(): Promise<void>; checkGallery(gallery: GalleryConfig, runId: number): Promise<void>};
    engine.readGapMs = 0;
    if (options.usage) engine.usage = options.usage;
    const giveaway = options.giveaway ?? ((post) => `${post.title}${post.body}`.includes("나눔"));
    const confirm = options.confirm ?? giveaway;
    Object.assign(engine.deps, {
        reader: () => ({
            articles: {
                list: async () => ({gall_list: listed.map((no) => ({no, subject: articles[no]?.title ?? "기존 글"})).reverse()}),
                read: async (_gallery: string, no: number) => {
                    reads.push(no);
                    return {view_info: {subject: articles[no]!.title}, view_main: {memo: articles[no]!.body}};
                }
            }
        })
    });
    if (options.loggedIn) Object.assign(engine.deps.accounts, {candidates: () => [{id: "a", memberType: "gonick", dccons: []}]});
    engine.llm = () => ({
        decide: async (post: {title: string; body: string}) => {
            calls.push(["단독", post.title]);
            return confirm(post) ? GIVEAWAY : NOT_GIVEAWAY;
        },
        decideMany: async (posts: {title: string; body: string}[]) => {
            calls.push(["묶음", ...posts.map((post) => post.title)]);
            if (options.batchFails) throw new Error("응답 시간 초과");
            return posts.map((post) => (giveaway(post) ? GIVEAWAY : NOT_GIVEAWAY));
        }
    });
    /** 목록에 이 글들이 보이는 상태로 한 번 확인합니다. */
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

const batches = (calls: string[][]) => calls.filter((call) => call[0] === "묶음").map((call) => call.slice(1));
const singles = (calls: string[][]) => calls.filter((call) => call[0] === "단독").map((call) => call[1]);

describe("Engine 새 글 묶음 판단", () => {
    it("키워드와 상관없이 새 글 전부를 LLM 요청 한 번으로 판단한다", async () => {
        const {run, calls} = withGallery({2: {title: "잡담", body: "오늘 날씨"}, 3: {title: "질문", body: "육성 재료"}, 4: {title: "테스트", body: "햄버거 선착 뿌림"}});
        await run({...gallery, keywords: ["나눔"]});
        expect(batches(calls)).toEqual([["잡담", "질문", "테스트"]]);
    });

    it("나눔으로 나온 글만 그 글 하나로 다시 확인하고, 다시 확인해서도 나눔이면 줄을 선다", async () => {
        const {run, calls, written} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "잡담", body: ""}}, {loggedIn: true});
        await run(gallery);
        expect(singles(calls)).toEqual(["치킨 나눔"]);
        await vi.waitFor(() => expect(written).toEqual([["a", 2]]));
    });

    it("다시 확인해서 나눔이 아니라고 하면 줄을 서지 않는다", async () => {
        const {run, written, logger} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "잡담", body: ""}}, {loggedIn: true, confirm: () => false});
        await run(gallery);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(written).toEqual([]);
        expect(logged(logger, "따로 다시 판단하니 나눔 글이 아님")).toBe(true);
    });

    it("새 글이 하나면 묶을 다른 글이 없으므로 다시 확인하지 않는다", async () => {
        const {run, calls, written} = withGallery({2: {title: "치킨 나눔", body: ""}}, {loggedIn: true});
        await run(gallery);
        expect(calls).toEqual([["단독", "치킨 나눔"]]);
        await vi.waitFor(() => expect(written).toEqual([["a", 2]]));
    });

    it("다시 확인할 요청 자리가 없으면 기다리지 않고 알림으로 넘긴다", async () => {
        const {run, written, logger} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "잡담", body: ""}}, {loggedIn: true, paidRpm: 1});
        await run(gallery);
        expect(written).toEqual([]);
        expect(logged(logger, "묶어 판단한 결과라")).toBe(true);
    });

    it(`한 번에 ${40}개까지 묶고, 넘으면 나눠 보낸다`, async () => {
        const posts = Object.fromEntries(Array.from({length: 45}, (_, i) => [i + 2, {title: `잡담 ${i + 2}`, body: ""}]));
        const {run, calls} = withGallery(posts);
        await run({...gallery, scanBody: false});
        expect(batches(calls).map((batch) => batch.length)).toEqual([40, 5]);
    });

    it("판단에 실패하면 키워드에 걸린 글만 알린다", async () => {
        const {run, ledger} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "잡담", body: ""}}, {batchFails: true});
        await run({...gallery, keywords: ["나눔"]});
        expect(ledger.has("gf2", 2)).toBe(true);
        expect(ledger.has("gf2", 3)).toBe(false);
    });
});

describe("Engine 본문 읽기", () => {
    it("켜져 있으면 키워드 없는 글도 본문을 읽어 함께 보낸다(제목에 티를 안 내는 나눔도 잡는다)", async () => {
        const {run, reads, calls, ledger} = withGallery({8: {title: "테스트", body: "햄버거 선착 3명 나눔"}, 9: {title: "잡담", body: "오늘 날씨 좋다"}});
        await run({...gallery, scanBody: true});
        expect(reads).toEqual([8, 9]);
        expect(batches(calls)).toEqual([["테스트", "잡담"]]);
        // 나눔으로 판단돼 처리한 글로 남습니다(로그인된 계정이 없어 알림).
        expect(ledger.has("gf2", 8)).toBe(true);
    });

    it("꺼져 있으면 키워드에 걸린 글만 본문을 읽고, 나머지는 제목만 보낸다", async () => {
        const {run, reads, calls} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "테스트", body: "햄버거 뿌림"}});
        await run({...gallery, keywords: ["나눔"], scanBody: false});
        expect(reads).toEqual([2]);
        expect(batches(calls)).toEqual([["치킨 나눔", "테스트"]]);
    });

    it("제목이나 본문에 제외 키워드가 있으면 보내지 않는다", async () => {
        const {run, calls} = withGallery({2: {title: "치킨 나눔", body: "구매 인증한 사람만"}, 3: {title: "인증 이벤트", body: ""}, 4: {title: "잡담", body: ""}});
        await run({...gallery, excludeKeywords: ["인증"]});
        expect(calls).toEqual([["단독", "잡담"]]);
    });

    it("본문 요청 상한을 넘으면 최근 글만 열고, 제목에 키워드가 있는 글은 상한과 상관없이 연다", async () => {
        const {run, reads, logger} = withGallery({
            2: {title: "잡담1", body: ""}, 3: {title: "잡담2", body: ""}, 4: {title: "치킨 나눔", body: ""}, 5: {title: "잡담3", body: ""}, 6: {title: "잡담4", body: ""}
        });
        await run({...gallery, keywords: ["나눔"], scanBody: true, bodyReadLimit: 2});
        expect(reads).toEqual([4, 5, 6]);
        expect(logged(logger, "최근 2개만 본문을 읽고")).toBe(true);
    });

    it("상한이 0이면 모두 연다", async () => {
        const {run, reads} = withGallery({2: {title: "a", body: ""}, 3: {title: "b", body: ""}, 4: {title: "c", body: ""}});
        await run({...gallery, scanBody: true, bodyReadLimit: 0});
        expect(reads).toEqual([2, 3, 4]);
    });

    it("키워드가 비어 있어도 본문 요청 상한을 지키고, 넘는 글은 제목만 보낸다", async () => {
        const {run, reads, calls} = withGallery({2: {title: "a", body: ""}, 3: {title: "b", body: ""}, 4: {title: "c", body: ""}, 5: {title: "d", body: ""}});
        await run({...gallery, keywords: [], bodyReadLimit: 2});
        expect(reads).toEqual([4, 5]);
        expect(batches(calls)).toEqual([["a", "b", "c", "d"]]);
    });

    it("본문을 읽지 못한 글은 줄 서라는 판단이 나와도 알림으로 넘긴다", async () => {
        const {run, written, logger} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "피자 나눔", body: ""}}, {loggedIn: true});
        await run({...gallery, keywords: [], bodyReadLimit: 1});
        // 본문을 읽은 3번 글만 줄을 서고, 상한을 넘어 읽지 못한 2번 글은 알림으로 넘깁니다.
        await vi.waitFor(() => expect(written).toEqual([["a", 3]]));
        expect(logged(logger, "본문을 확인하지 못했습니다")).toBe(true);
    });
});

describe("Engine 무료 등급 하루 LLM 요청 수", () => {
    const exhausted = () => new LlmUsage(() => ({resetAt: Date.now() + 60 * 60 * 1000, count: 480}), () => {});

    it("다 쓰면 디시에도 요청하지 않고 감시를 쉬며 한 번만 알린다", async () => {
        const {engine, logger} = setup();
        let listCalls = 0;
        Object.assign((engine as unknown as {deps: EngineDeps}).deps, {reader: () => ({articles: {list: async () => (listCalls++, {gall_list: []})}})});
        (engine as unknown as {usage: LlmUsage}).usage = exhausted();
        const tick = (engine as unknown as {tick(configId: string, runId: number): Promise<void>}).tick.bind(engine);
        await tick(gallery.id, 0);
        await tick(gallery.id, 0);
        engine.stop();
        expect(listCalls).toBe(0);
        expect(logger.recent().filter((entry) => entry.message.includes("하루 LLM 요청 수"))).toHaveLength(1);
    });

    it("유료 요금제면 하루 제한이 없다", async () => {
        const {run, calls} = withGallery({2: {title: "잡담", body: ""}}, {paidRpm: 0, usage: exhausted()});
        await run(gallery);
        expect(calls).toHaveLength(1);
    });

    it("묶음 판단과 2차 확인을 모두 오늘 쓴 요청 수에 센다", async () => {
        const usage = new LlmUsage(() => null, () => {});
        const {run} = withGallery({2: {title: "치킨 나눔", body: ""}, 3: {title: "잡담", body: ""}}, {usage, loggedIn: true});
        await run(gallery);
        expect(usage.count).toBe(2);
    });
});

describe("Engine 판단 기록과 테스트용 멈춤", () => {
    it("나눔으로 판단된 묶음과 2차 확인에서 LLM에 보낸 내용과 판단 원문을 남긴다", async () => {
        const records: {kind: string; message: string; posts: {no: number}[]; decisions: unknown[]}[] = [];
        const env = withGallery({2: {title: "치킨 나눔", body: "댓글로 줄"}, 3: {title: "잡담", body: "오늘 날씨"}}, {loggedIn: true});
        Object.assign((env.engine as unknown as {deps: EngineDeps}).deps, {recordJudgment: (record: never) => records.push(record)});
        await env.run(gallery);
        expect(records.map((record) => record.kind)).toEqual(["batch", "confirm"]);
        expect(records[0]!.message).toContain('<post index="1" no="2">');
        expect(records[0]!.message).toContain("댓글로 줄");
        expect(records[0]!.posts.map((post) => post.no)).toEqual([2, 3]);
        expect(records[1]!.posts.map((post) => post.no)).toEqual([2]);
    });

    it("나눔이 없는 묶음은 남기지 않는다", async () => {
        const records: unknown[] = [];
        const env = withGallery({2: {title: "잡담", body: ""}, 3: {title: "질문", body: ""}});
        Object.assign((env.engine as unknown as {deps: EngineDeps}).deps, {recordJudgment: (record: unknown) => records.push(record)});
        await env.run(gallery);
        expect(records).toEqual([]);
    });

    it("테스트 설정을 켜면 처음 줄 서기에 성공하는 즉시 감시를 멈춘다", async () => {
        const {engine, written, logger} = setup();
        engine.stopAfterFirstSuccess = true;
        engine.start();
        await engine.dispatch(gallery, {no: 60, title: "나눔"}, plan(0), LIVE);
        await vi.waitFor(() => expect(written).toEqual([["a", 60]]));
        await vi.waitFor(() => expect(engine.running).toBe(false));
        expect(engine.stopAfterFirstSuccess).toBe(false);
        expect(logged(logger, "첫 줄 서기에 성공해 감시를 멈춥니다")).toBe(true);
    });
});

describe("Engine 기준 글", () => {
    it("감시 중에 다시 시작해도 기준 글을 유지해 그사이 올라온 글을 건너뛰지 않는다", async () => {
        const {check, list, engine, calls} = withGallery({2: {title: "나눔 2", body: ""}});
        await check(gallery, []);
        list([2]);
        engine.start();
        await vi.waitFor(() => expect(calls).toEqual([["단독", "나눔 2"]]));
        engine.stop();
    });
});

describe("감시 자동 중지 시각", () => {
    const at = (hours: number, minutes = 0, day = 25) => new Date(2026, 9, day, hours, minutes).getTime();
    const autoStop = (patch: Partial<Settings["autoStop"]>): Settings["autoStop"] => ({mode: "off", afterMinutes: 120, at: "02:00", ...patch});

    it("'N분 후'는 감시를 시작한 때부터 센다", () => {
        expect(nextAutoStopAt(autoStop({mode: "after", afterMinutes: 90}), at(22), at(23))).toBe(at(23, 30));
    });

    it("'정한 시각'은 아직 안 지났으면 오늘, 지났거나 지금이면 내일이다", () => {
        expect(nextAutoStopAt(autoStop({mode: "at", at: "23:30"}), at(22), at(23))).toBe(at(23, 30));
        expect(nextAutoStopAt(autoStop({mode: "at", at: "02:00"}), at(22), at(23))).toBe(at(2, 0, 26));
        expect(nextAutoStopAt(autoStop({mode: "at", at: "23:00"}), at(22), at(23))).toBe(at(23, 0, 26));
    });

    it("꺼져 있으면 멈추지 않는다", () => {
        expect(nextAutoStopAt(autoStop({mode: "off"}), at(22), at(23))).toBeNull();
    });

    it("이전 버전 설정이나 잘못된 값은 쓸 수 있는 값으로 맞춘다", () => {
        const {autoStop: _removed, ...old} = defaultSettings();
        expect(normalizeSettings(old as Settings).autoStop).toEqual({mode: "off", afterMinutes: 120, at: "02:00"});
        const broken = normalizeSettings({...defaultSettings(), autoStop: {mode: "soon" as "off", afterMinutes: 99999, at: "25:00"}});
        expect(broken.autoStop).toEqual({mode: "off", afterMinutes: 24 * 60, at: "02:00"});
    });
});

describe("Engine 감시 자동 중지", () => {
    function watching(patch: Partial<Settings["autoStop"]>) {
        vi.useFakeTimers({now: new Date(2026, 9, 25, 22, 0)});
        const context = setup();
        context.update({autoStop: {mode: "off", afterMinutes: 120, at: "02:00", ...patch}});
        Object.assign((context.engine as unknown as {deps: EngineDeps}).deps, {reader: () => null});
        context.engine.start();
        return context;
    }

    afterEach(() => vi.useRealTimers());

    it("정한 시간이 지나면 감시를 멈추고, 그 전에는 멈추지 않는다", async () => {
        const {engine, logger} = watching({mode: "after", afterMinutes: 30});
        expect(engine.autoStopAt).toBe(new Date(2026, 9, 25, 22, 30).getTime());
        await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
        expect(engine.running).toBe(true);
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(engine.running).toBe(false);
        expect(engine.autoStopAt).toBeNull();
        expect(logged(logger, "자동으로 멈춥니다")).toBe(true);
    });

    it("감시 중에 다시 시작해도 처음 시작한 때부터 센다", async () => {
        const {engine} = watching({mode: "after", afterMinutes: 30});
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        engine.start();
        expect(engine.autoStopAt).toBe(new Date(2026, 9, 25, 22, 30).getTime());
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(engine.running).toBe(false);
    });

    it("감시 중에 설정을 바꾸면 바로 반영하고, 끄면 멈추지 않는다", async () => {
        const {engine, update} = watching({mode: "after", afterMinutes: 30});
        update({autoStop: {mode: "at", afterMinutes: 30, at: "23:15"}});
        engine.refreshAutoStop();
        expect(engine.autoStopAt).toBe(new Date(2026, 9, 25, 23, 15).getTime());
        update({autoStop: {mode: "off", afterMinutes: 30, at: "23:15"}});
        engine.refreshAutoStop();
        expect(engine.autoStopAt).toBeNull();
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
        expect(engine.running).toBe(true);
        engine.stop();
    });

    it("컴퓨터가 잠들어 타이머가 늦어져도 깬 뒤 1분 안에 멈춘다", async () => {
        const {engine} = watching({mode: "at", at: "23:00"});
        // 타이머는 돌지 않고 시계만 지난 상황(잠자기)입니다.
        vi.setSystemTime(new Date(2026, 9, 25, 23, 40));
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(engine.running).toBe(false);
    });

    it("직접 멈추면 자동 중지 예약도 없어지고, 멈춰 있을 때 설정을 저장해도 예약하지 않는다", () => {
        const {engine} = watching({mode: "after", afterMinutes: 30});
        engine.stop();
        expect(engine.autoStopAt).toBeNull();
        engine.refreshAutoStop();
        expect(engine.autoStopAt).toBeNull();
    });
});
