import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {Ledger} from "../src/main/store";

describe("Ledger", () => {
    it("빠르게 연달아 기록해도 파일이 깨지지 않고, 다시 열면 모두 남아 있다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-ledger-"));
        const ledger = new Ledger(dir);
        for (let no = 1; no <= 300; no++) expect(ledger.claim("gf2", no)).toBe(true);
        expect(ledger.claim("gf2", 1)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const saved = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as string[];
        expect(saved).toHaveLength(300);
        const reopened = new Ledger(dir);
        expect(reopened.has("gf2", 300)).toBe(true);
        expect(reopened.claim("gf2", 150)).toBe(false);
    });
});

describe("Ledger.release", () => {
    it("되돌린 기록은 다시 기록할 수 있고, 다시 열어도 빠져 있다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-ledger-"));
        const ledger = new Ledger(dir);
        ledger.claim("gf2", 1);
        ledger.claim("gf2", 2);
        ledger.release("gf2", 1);
        expect(ledger.has("gf2", 1)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(new Ledger(dir).has("gf2", 1)).toBe(false);
        expect(new Ledger(dir).has("gf2", 2)).toBe(true);
        expect(ledger.claim("gf2", 1)).toBe(true);
    });
});

describe("HistoryStore", () => {
    it("기록을 파일에 남기고 다시 열면 그대로 읽으며, 새 기록을 구독자에게 알린다", async () => {
        const {HistoryStore} = await import("../src/main/store");
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-history-"));
        const store = new HistoryStore(dir);
        const seen: number[] = [];
        store.subscribe((entry) => seen.push(entry.postNo));
        store.add({time: 1, galleryId: "gf2", postNo: 5, title: "햄버거 나눔", outcome: "success", detail: "테스터 계정으로 \"줄\""});
        store.add({time: 2, galleryId: "gf2", postNo: 6, title: "치킨 나눔", outcome: "failure", detail: "테스터: 오류"});
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(seen).toEqual([5, 6]);
        expect(new HistoryStore(dir).all().map((entry) => entry.outcome)).toEqual(["success", "failure"]);
    });
});
