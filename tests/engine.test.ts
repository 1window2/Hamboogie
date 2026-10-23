import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {defaultSettings, newGallery} from "@shared/settings";
import {Engine, type EngineDeps} from "../src/main/pipeline/engine";
import {Logger} from "../src/main/logger";
import {Ledger} from "../src/main/store";

function setup(notifyOnSuccess = false) {
    const dir = mkdtempSync(join(tmpdir(), "hamboogie-engine-"));
    const ledger = new Ledger(dir);
    const logger = new Logger(join(dir, "test.log"));
    const written: number[] = [];
    const recorded: unknown[] = [];
    const deps = {
        ledger,
        history: {add: (entry: unknown) => recorded.push(entry)},
        logger,
        settings: () => ({...defaultSettings(), notifyOnSuccess}),
        accounts: {
            candidates: () => [],
            maintain: async () => false,
            nickname: () => "테스터",
            writeComment: async (_accountId: string, _galleryId: string, postNo: number) => {
                written.push(postNo);
            }
        }
    } as unknown as EngineDeps;
    return {engine: new Engine(deps), ledger, logger, written, recorded};
}

describe("Engine 예약된 줄 서기", () => {
    const gallery = {...newGallery("g"), galleryId: "gf2"};
    const plan = (delayMs: number) => ({
        kind: "comment" as const,
        notBefore: Date.now() + delayMs,
        attempts: [{accountId: "a", content: {type: "text" as const, text: "줄"}}]
    });

    it("감시를 멈춰 예약이 취소되면 처리 기록을 되돌린다", async () => {
        const {engine, ledger, written, logger} = setup();
        await engine.dispatch(gallery, {no: 10, title: "3시부터 나눔"}, plan(60_000));
        expect(ledger.has("gf2", 10)).toBe(true);
        engine.stop();
        expect(ledger.has("gf2", 10)).toBe(false);
        expect(written).toEqual([]);
        expect(logger.recent().some((entry) => entry.message.includes("예약된 줄 서기를 취소"))).toBe(true);
    });

    it("시각이 되면 줄을 서고 처리 기록과 줄 서기 기록이 남는다", async () => {
        const {engine, ledger, written, recorded} = setup();
        await engine.dispatch(gallery, {no: 11, title: "나눔"}, plan(0));
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
        expect(written).toEqual([11]);
        expect(recorded).toEqual([expect.objectContaining({galleryId: "gf2", postNo: 11, title: "나눔", outcome: "success", detail: "테스터 계정으로 \"줄\""})]);
        engine.stop();
        expect(ledger.has("gf2", 11)).toBe(true);
    });
});

describe("Engine 성공 알림", () => {
    const gallery = {...newGallery("g"), galleryId: "gf2"};
    const plan = {kind: "comment" as const, notBefore: Date.now(), attempts: [{accountId: "a", content: {type: "text" as const, text: "줄"}}]};
    const triedToNotify = (logger: Logger) => logger.recent().some((entry) => entry.message.includes("Discord 웹훅이 설정되지 않아"));

    it("기본값(꺼짐)이면 성공해도 알리지 않는다", async () => {
        const {engine, logger, recorded} = setup(false);
        await engine.dispatch(gallery, {no: 20, title: "나눔"}, plan);
        // 줄 서기가 끝난 것(기록이 남은 것)을 확인한 뒤 알림 시도가 없었는지 봅니다.
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
        expect(triedToNotify(logger)).toBe(false);
    });

    it("켜면 성공했을 때도 알린다", async () => {
        const {engine, logger} = setup(true);
        await engine.dispatch(gallery, {no: 21, title: "나눔"}, plan);
        await vi.waitFor(() => expect(triedToNotify(logger)).toBe(true));
    });
});

describe("Engine 마감 재확인", () => {
    it("예약해 둔 사이 마감이 지났으면 댓글을 달지 않고 실패로 기록한다", async () => {
        const {engine, written, recorded} = setup();
        const gallery = {...newGallery("g"), galleryId: "gf2"};
        const plan = {kind: "comment" as const, notBefore: Date.now() + 30, deadline: Date.now() + 10, attempts: [{accountId: "a", content: {type: "text" as const, text: "줄"}}]};
        await engine.dispatch(gallery, {no: 30, title: "3시까지 나눔"}, plan);
        await vi.waitFor(() => expect(recorded).toEqual([expect.objectContaining({postNo: 30, outcome: "failure"})]));
        expect(written).toEqual([]);
    });
});
