import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {defaultSettings, newGallery} from "@shared/settings";
import {Engine, type EngineDeps} from "../src/main/pipeline/engine";
import {Logger} from "../src/main/logger";
import {Ledger} from "../src/main/store";

function setup() {
    const dir = mkdtempSync(join(tmpdir(), "hamboogie-engine-"));
    const ledger = new Ledger(dir);
    const logger = new Logger(join(dir, "test.log"));
    const written: number[] = [];
    const deps = {
        ledger,
        logger,
        settings: () => defaultSettings(),
        accounts: {
            candidates: () => [],
            nickname: () => "테스터",
            writeComment: async (_accountId: string, _galleryId: string, postNo: number) => {
                written.push(postNo);
            }
        }
    } as unknown as EngineDeps;
    return {engine: new Engine(deps), ledger, logger, written};
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

    it("시각이 되면 줄을 서고 처리 기록은 남는다", async () => {
        const {engine, ledger, written} = setup();
        await engine.dispatch(gallery, {no: 11, title: "나눔"}, plan(0));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(written).toEqual([11]);
        engine.stop();
        expect(ledger.has("gf2", 11)).toBe(true);
    });
});
