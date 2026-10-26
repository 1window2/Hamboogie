import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {AuthExpiredError, type DCInside, type DeviceCredentials} from "@green-1052/dcinside.js";
import {defaultSettings, newGallery} from "@shared/settings";
import type {AccountConfig, GalleryConfig, Settings} from "@shared/types";
import {AccountManager} from "../src/main/dc/accounts";
import {AppIdBackoff} from "../src/main/dc/app-id-backoff";
import {Logger} from "../src/main/logger";
import {Engine, type EngineDeps} from "../src/main/pipeline/engine";
import {Ledger} from "../src/main/store";

/**
 * 컴퓨터가 잠들었다 깨어난 상황을 흉내 냅니다. 엔진과 계정 관리는 실제 코드이고, 디시 서버만 가짜입니다.
 * 잠든 사이 로그인 세션이 만료되고, 깨어난 직후에는 네트워크가 잠시 없을 수 있습니다.
 */
const ACCOUNT: AccountConfig = {id: "acc1", loginId: "tester", memberTypeOverride: "auto", defaultDccons: []};
const MINUTE = 60 * 1000;

function world() {
    let now = Date.UTC(2026, 9, 26, 3, 0);
    const server = {online: true, loginWorks: true, valid: new Set<number>(), lists: 0, logins: 0};
    let nextClient = 0;
    const factory = (_credentials?: DeviceCredentials) => {
        const id = ++nextClient;
        const offline = () => new TypeError("fetch failed");
        return {
            async login(userId: string, password: string) {
                server.logins++;
                if (!server.online || !server.loginWorks) throw offline();
                server.valid.add(id);
                return {type: "login", id: userId, password, userId, result: {result: true, user_id: userId, name: "깡계", is_gonick: 0}};
            },
            auth: {exportCredentials: () => ({androidId: String(id)}), appId: async () => "app-id"},
            dccons: {list: async () => ({tab: [], list: []})},
            articles: {
                async list() {
                    if (!server.online) throw offline();
                    if (!server.valid.has(id)) throw new AuthExpiredError("login", "certification_login");
                    server.lists++;
                    // 새 글 하나와 이미 본 글을 함께 돌려줘, 한 페이지만 보고 멈추게 합니다.
                    return {gall_list: [{no: 1000 + server.lists, subject: "잡담"}, {no: 1000, subject: "잡담"}]};
                },
                read: async () => ({view_info: {subject: "잡담"}, view_main: {memo: ""}})
            }
        } as unknown as DCInside;
    };
    const clock = () => now;
    const secrets = new Map<string, string>([["account:acc1", "pw"]]);
    const appId = new AppIdBackoff(clock);
    const accounts = new AccountManager({
        get: (key: string) => secrets.get(key) ?? null,
        has: (key: string) => secrets.has(key),
        set: async (key: string, value: string) => void (value ? secrets.set(key, value) : secrets.delete(key))
    }, factory, appId, clock);
    // 본문은 읽지 않고(목록만 확인) 판단은 API 키가 없어 건너뜁니다. 여기서 볼 것은 로그인 복구와 목록 확인입니다.
    const gallery: GalleryConfig = {...newGallery("g"), galleryId: "gf2", checkedId: "gf2", accountIds: ["acc1"], intervalSec: 60, keywords: [], scanBody: false};
    const settings: Settings = {...defaultSettings(), accounts: [ACCOUNT], galleries: [gallery]};
    const dir = mkdtempSync(join(tmpdir(), "hamboogie-sleep-"));
    const logger = new Logger(join(dir, "test.log"));
    const engine = new Engine({
        reader: (target) => accounts.readingClient(settings.accounts, target.accountIds)?.client ?? null,
        resetReader: async () => {},
        onReaderLoginExpired: async (client, reason) => {
            const accountId = accounts.accountOf(client);
            if (!accountId) return "none";
            return await accounts.recoverLogin(accountId, reason) ? "recovered" : accounts.isRetrying(accountId) ? "retrying" : "expired";
        },
        appId,
        accounts,
        ledger: new Ledger(dir),
        history: {add: () => {}},
        secrets: {get: () => null} as unknown as EngineDeps["secrets"],
        logger,
        settings: () => settings,
        now: clock
    });
    const tick = () => (engine as unknown as {tick(configId: string, runId: number): Promise<void>}).tick(gallery.id, 0);
    const logs = (text: string) => logger.recent().filter((entry) => entry.message.includes(text)).length;
    return {server, accounts, engine, tick, logs, advance: (ms: number) => (now += ms), sleep: () => server.valid.clear()};
}

describe("잠자기에서 깨어난 뒤 저절로 복구", () => {
    it("깨어난 직후 네트워크가 없다가 붙으면, 만료된 세션은 다시 로그인하고 감시를 이어간다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        await w.tick();
        const before = w.server.lists;
        w.sleep();
        w.server.online = false;
        await w.tick();
        expect(w.logs("연달아 실패해")).toBe(1);
        w.server.online = true;
        await w.tick();
        expect(w.logs("로그인이 풀려 다시 로그인했습니다")).toBe(1);
        await w.tick();
        expect(w.server.lists).toBeGreaterThan(before);
        expect(w.logs("Discord 웹훅이 설정되지 않아")).toBe(0);
        w.engine.stop();
    });

    it("세션 만료를 알아챘을 때 다시 로그인이 네트워크 오류로 실패해도, 알리지 않고 1분 뒤 저절로 다시 로그인해 이어간다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        await w.tick();
        const before = w.server.lists;
        w.sleep();
        w.server.loginWorks = false;
        await w.tick();
        expect(w.logs("잠시 뒤 자동으로 다시 시도합니다")).toBe(1);
        expect(w.accounts.status("acc1")).toMatchObject({state: "error", retryAt: expect.any(Number)});
        // 1분이 안 됐으면 다시 로그인하지 않고, 로그인 필요 알림도 보내지 않습니다.
        w.advance(30 * 1000);
        await w.tick();
        expect(w.accounts.status("acc1").state).toBe("error");
        w.server.loginWorks = true;
        w.advance(31 * 1000);
        await w.tick();
        expect(w.accounts.status("acc1").state).toBe("logged_in");
        expect(w.server.lists).toBeGreaterThan(before);
        expect(w.logs("Discord 웹훅이 설정되지 않아")).toBe(0);
        w.engine.stop();
    });

    it("네트워크가 오래 끊겨 다시 로그인이 계속 실패하면 간격을 늘려 가며 시도하고, 10분이 지나면 한 번 알린다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        await w.tick();
        w.sleep();
        w.server.loginWorks = false;
        await w.tick();
        const logins = w.server.logins;
        // 20분 동안 1분마다 확인합니다. 다시 로그인은 1, 2, 4, 8분 간격으로만 합니다.
        for (let i = 0; i < 20; i++) {
            w.advance(MINUTE);
            await w.tick();
        }
        expect(w.server.logins - logins).toBe(4);
        expect(w.logs("로그인된 계정이 없어 디시에 요청하지 않고")).toBe(1);
        w.server.loginWorks = true;
        for (let i = 0; i < 16; i++) {
            w.advance(MINUTE);
            await w.tick();
        }
        expect(w.accounts.status("acc1").state).toBe("logged_in");
        w.engine.stop();
    });
});
