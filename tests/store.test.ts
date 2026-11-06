import {chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {defaultSettings} from "@shared/settings";
import {HistoryStore, Ledger, SecretStore, SettingsStore, UsageStore} from "../src/main/store";

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
            expect(readdirSync(dir).some((name) => name.startsWith("ledger.json.broken")), content).toBe(true);
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

    it("읽으며 버리거나 바로잡은 값을 기록해 둔다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        writeFileSync(join(dir, "settings.json"), JSON.stringify({
            accounts: [{id: ACCOUNT_ID}, {id: "bad"}],
            galleries: [{id: "g", galleryId: "gf2"}],
            llm: {provider: "gemini", models: {gemini: "모델 이름"}}
        }));
        const store = new SettingsStore(dir);
        expect(store.loadNotes).toEqual([
            "설정 파일의 accounts 중 1개는 형식이 맞지 않아 버렸습니다.",
            expect.stringContaining("gemini 모델 이름이 올바르지 않아")
        ]);
        expect(readdirSync(dir)).toEqual(["settings.json"]);
    });

    it("예전 버전에서 저장한 너무 긴 키워드를 버리면 무엇을 버렸는지 기록한다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        const long = "가".repeat(31);
        writeFileSync(join(dir, "settings.json"), JSON.stringify({
            ...defaultSettings(),
            galleries: [{id: "g", galleryId: "gf2", keywords: ["치킨", long], excludeKeywords: ["Ａ"], accountIds: []}]
        }));
        const store = new SettingsStore(dir);
        expect(store.get().galleries[0]).toMatchObject({keywords: ["치킨"], excludeKeywords: ["A"]});
        expect(store.loadNotes).toEqual([`gf2 갤러리의 키워드 중 저장하지 않는 것(너무 길거나, 겹치거나, 개수를 넘음): ${long}`]);
    });

    it("멀쩡한 설정 파일은 아무것도 기록하지 않는다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        writeFileSync(join(dir, "settings.json"), JSON.stringify(defaultSettings()));
        expect(new SettingsStore(dir).loadNotes).toEqual([]);
    });
});

describe("SettingsStore 깨진 설정 파일", () => {
    it("JSON이 아닌 설정 파일은 옆으로 옮겨 두고 기본 설정으로 연다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        writeFileSync(join(dir, "settings.json"), "{\"galleries\": [");
        const settings = new SettingsStore(dir).get();
        expect(settings).toEqual(defaultSettings());
        expect(existsSync(join(dir, "settings.json"))).toBe(false);
        expect(readdirSync(dir).some((name) => name.startsWith("settings.json.broken-"))).toBe(true);
    });

    it("읽을 수 없는 설정 파일(권한 등)은 깨진 것으로 옮기지 않고 시작을 멈춘다", () => {
        if (process.platform === "win32" || process.getuid?.() === 0) return;
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        const path = join(dir, "settings.json");
        writeFileSync(path, JSON.stringify(defaultSettings()));
        chmodSync(path, 0o000);
        try {
            expect(() => new SettingsStore(dir)).toThrow("settings.json 파일을 읽지 못했습니다");
            expect(readdirSync(dir)).toEqual(["settings.json"]);
        } finally {
            chmodSync(path, 0o600);
        }
    });

    it("제대로 된 설정 파일은 갤러리 설정을 그대로 읽고 옮기지 않는다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-settings-"));
        writeFileSync(join(dir, "settings.json"), JSON.stringify({...defaultSettings(), galleries: [{id: "g", galleryId: "gf2", enabled: true, keywords: ["치킨"], accountIds: []}]}));
        const settings = new SettingsStore(dir).get();
        expect(settings.galleries).toEqual([expect.objectContaining({id: "g", galleryId: "gf2", enabled: true, keywords: ["치킨"]})]);
        expect(readdirSync(dir)).toEqual(["settings.json"]);
    });
});

describe("SecretStore 손으로 고친 파일", () => {
    it("문자열이 아닌 값은 버린다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-secrets-"));
        writeFileSync(join(dir, "secrets.json"), JSON.stringify({"account:a": "ZHVtbXk=", "otp:a": 5, "device:a": null, "llm:gemini": {value: "x"}}));
        const secrets = new SecretStore(dir);
        expect(secrets.has("account:a")).toBe(true);
        expect(secrets.has("otp:a")).toBe(false);
        expect(secrets.has("device:a")).toBe(false);
        expect(secrets.has("llm:gemini")).toBe(false);
    });

    it("객체가 아닌 파일은 옆으로 옮겨 두고 빈 상태로 시작한다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-secrets-"));
        writeFileSync(join(dir, "secrets.json"), JSON.stringify(["account:a"]));
        expect(new SecretStore(dir).has("account:a")).toBe(false);
        expect(readdirSync(dir).some((name) => name.startsWith("secrets.json.broken-"))).toBe(true);
    });
});

describe("UsageStore", () => {
    it("음수이거나 정수가 아닌 요청 수는 받지 않는다", () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-usage-"));
        const store = new UsageStore(dir);
        const write = (value: unknown) => writeFileSync(join(dir, "llm-usage.json"), JSON.stringify(value));
        const resetAt = Date.UTC(2026, 10, 7, 8, 0);
        for (const count of [-1, 1.5, "3", null]) {
            write({resetAt, count});
            expect(store.load(), String(count)).toBeNull();
        }
        write({resetAt: "내일", count: 3});
        expect(store.load()).toBeNull();
        write({resetAt, count: 3});
        expect(store.load()).toEqual({resetAt, count: 3});
        write({resetAt, count: 0});
        expect(store.load()).toEqual({resetAt, count: 0});
    });
});
