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
