import {existsSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {HistoryStore, Ledger, SettingsStore} from "../src/main/store";

describe("Ledger", () => {
    it("빠르게 연달아 기록해도 파일이 깨지지 않고, 다시 열면 모두 남아 있다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-ledger-"));
        const ledger = new Ledger(dir);
        for (let no = 1; no <= 300; no++) expect(ledger.claim("gf2", no)).toBe(true);
        expect(ledger.claim("gf2", 1)).toBe(false);
        await ledger.flush();

        const saved = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as string[];
        expect(saved).toHaveLength(300);
        const reopened = new Ledger(dir);
        expect(reopened.has("gf2", 300)).toBe(true);
        expect(reopened.claim("gf2", 150)).toBe(false);
    });

    it("목록이 아니거나 깨진 파일은 남겨 두고 빈 목록으로 시작한다", () => {
        for (const content of ["{}", "null", "[\"gf2:1\""]) {
            const dir = mkdtempSync(join(tmpdir(), "hamboogie-ledger-"));
            writeFileSync(join(dir, "ledger.json"), content);
            const ledger = new Ledger(dir);
            expect(ledger.claim("gf2", 1), content).toBe(true);
            expect(existsSync(join(dir, "ledger.json.broken")), content).toBe(true);
        }
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-history-"));
        writeFileSync(join(dir, "history.json"), JSON.stringify([null, 5, {time: 1, galleryId: "gf2", postNo: 5, title: "", outcome: "success", detail: ""}]));
        expect(new HistoryStore(dir).all().map((entry) => entry.postNo)).toEqual([5]);
    });
});

describe("HistoryStore", () => {
    it("기록을 파일에 남기고 다시 열면 그대로 읽으며, 새 기록을 구독자에게 알린다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-history-"));
        const store = new HistoryStore(dir);
        const seen: number[] = [];
        store.subscribe((entry) => seen.push(entry.postNo));
        store.add({time: 1, galleryId: "gf2", postNo: 5, title: "햄버거 나눔", outcome: "success", detail: "테스터 계정으로 \"줄\""});
        store.add({time: 2, galleryId: "gf2", postNo: 6, title: "치킨 나눔", outcome: "failure", detail: "테스터: 오류"});
        await store.flush();
        expect(seen).toEqual([5, 6]);
        expect(new HistoryStore(dir).all().map((entry) => entry.outcome)).toEqual(["success", "failure"]);
    });
});

describe("SettingsStore", () => {
    const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

    it("손으로 고치다 망가진 설정 파일도 쓸 수 있는 값으로 맞춰 연다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        writeFileSync(join(dir, "settings.json"), JSON.stringify({
            accounts: [{id: ACCOUNT_ID}, null, {id: 5}],
            galleries: [{id: "g", galleryId: "gf2", keywords: "나눔", accountIds: null}, {galleryId: "no-id"}],
            llm: null,
            discordWebhookUrl: 5
        }));
        const settings = new SettingsStore(dir).get();
        expect(settings.accounts).toEqual([expect.objectContaining({id: ACCOUNT_ID, loginId: "", memberTypeOverride: "auto", defaultDccons: []})]);
        expect(settings.galleries).toHaveLength(1);
        expect(settings.galleries[0]).toMatchObject({id: "g", galleryId: "gf2", keywords: [], accountIds: [], enabled: false});
        expect(settings.llm.provider).toBe("gemini");
        expect(settings.discordWebhookUrl).toBe("5");
    });
});
