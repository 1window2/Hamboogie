import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {AuthExpiredError, OtpRequiredError, type DCInside, type DeviceCredentials} from "@green-1052/dcinside.js";
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

function world(network: {online: () => boolean} = {online: () => true}) {
    let now = Date.UTC(2026, 9, 26, 3, 0);
    const notices: string[] = [];
    const server = {online: true, loginWorks: true, valid: new Set<number>(), lists: 0, logins: 0, started: 0, otp: false, loginHold: null as Promise<void> | null, hold: null as Promise<void> | null};
    let nextClient = 0;
    const factory = (_credentials?: DeviceCredentials) => {
        const id = ++nextClient;
        const offline = () => new TypeError("fetch failed");
        return {
            async login(userId: string, password: string) {
                server.logins++;
                if (server.loginHold) await server.loginHold;
                if (server.otp) throw new OtpRequiredError("OTP가 필요합니다.", null);
                if (!server.online || !server.loginWorks) throw offline();
                server.valid.add(id);
                return {type: "login", id: userId, password, userId, result: {result: true, user_id: userId, name: "깡계", is_gonick: 0}};
            },
            auth: {exportCredentials: () => ({androidId: String(id)}), appId: async () => "app-id"},
            dccons: {list: async () => ({tab: [], list: []})},
            articles: {
                async list() {
                    server.started++;
                    if (server.hold) await server.hold;
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
        now: clock,
        checkNetwork: async () => network.online(),
        desktopNotice: (title) => notices.push(title),
        // 기다리는 동안 시계만 그만큼 흐르게 합니다.
        sleep: async (ms) => void (now += ms)
    });
    const internals = engine as unknown as {runId: number; tick(configId: string, runId: number): Promise<void>; schedule(configId: string, runId: number, delayMs: number): void};
    const tick = () => internals.tick(gallery.id, internals.runId);
    const logs = (text: string) => logger.recent().filter((entry) => entry.message.includes(text)).length;
    return {server, accounts, engine, internals, gallery, settings, tick, logs, notices, advance: (ms: number) => (now += ms), sleep: () => server.valid.clear()};
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

describe("잠자기 동안 멈추고 깨어나면 네트워크를 확인한 뒤 이어가기", () => {
    it("잠든 동안에는 확인하지 않고, 짧게 잤으면 깨어나 네트워크가 붙은 뒤 기준 글을 그대로 두고 이어간다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        await w.tick();
        const lists = w.server.lists;
        w.engine.suspend();
        await w.tick();
        expect(w.server.lists).toBe(lists);
        w.advance(2 * MINUTE);
        await w.engine.resume();
        expect(w.logs("네트워크가 연결되어 감시를 이어갑니다")).toBe(1);
        expect(w.logs("그사이 글은 건너뛰고")).toBe(0);
        await w.tick();
        expect(w.server.lists).toBe(lists + 1);
        expect(w.logs("감시 시작. 기준 글")).toBe(1);
        w.engine.stop();
    });

    it("5분 넘게 잤으면 그사이 글은 버리고 기준 글을 새로 잡는다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        await w.tick();
        w.engine.suspend();
        w.advance(6 * MINUTE);
        await w.engine.resume();
        expect(w.logs("그사이 글은 건너뛰고 기준 글을 새로 잡습니다")).toBe(1);
        await w.tick();
        expect(w.logs("감시 시작. 기준 글")).toBe(2);
        w.engine.stop();
    });

    it("깨어난 뒤 네트워크가 늦게 붙으면 붙을 때까지 기다렸다가 이어간다", async () => {
        let checks = 0;
        const w = world({online: () => ++checks >= 4});
        await w.accounts.login(ACCOUNT);
        await w.tick();
        w.engine.suspend();
        await w.engine.resume();
        expect(checks).toBe(4);
        expect(w.engine.running).toBe(true);
        expect(w.logs("네트워크가 연결되어 감시를 이어갑니다")).toBe(1);
        w.engine.stop();
    });

    it("깨어난 뒤 1분이 지나도 네트워크가 없으면 감시를 멈추고 컴퓨터 알림으로 알린다", async () => {
        const w = world({online: () => false});
        await w.accounts.login(ACCOUNT);
        await w.tick();
        w.engine.suspend();
        await w.engine.resume();
        expect(w.engine.running).toBe(false);
        expect(w.logs("1분이 지나도 인터넷에 연결되지 않아 감시를 멈췄습니다")).toBe(1);
        expect(w.notices).toEqual(["Hamboogie 감시 중지"]);
    });

    it("깨어나 네트워크를 기다리는 사이 사용자가 감시를 멈추면 다시 시작하지 않는다", async () => {
        const w = world({online: () => false});
        await w.accounts.login(ACCOUNT);
        await w.tick();
        w.engine.suspend();
        const waiting = w.engine.resume();
        w.engine.stop();
        await waiting;
        expect(w.engine.running).toBe(false);
        expect(w.notices).toEqual([]);
    });
});

describe("감시 중 설정 반영과 확인 겹침 방지", () => {
    afterEach(() => vi.useRealTimers());

    it("감시 중에 저장한 갤러리 설정을 바로 반영한다: 끄면 빼고, 새로 켜면 더한다", async () => {
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        const w = world();
        await w.accounts.login(ACCOUNT);
        w.engine.start();
        expect(w.engine.running).toBe(true);
        const second: GalleryConfig = {...w.gallery, id: "g2", galleryId: "asgeir", checkedId: "asgeir", enabled: false};
        w.settings.galleries.push(second);
        w.engine.syncGalleries();
        expect(w.logs("감시에 추가했습니다")).toBe(0);
        second.enabled = true;
        w.engine.syncGalleries();
        expect(w.logs("감시에 추가했습니다")).toBe(1);
        w.gallery.enabled = false;
        second.enabled = false;
        w.engine.syncGalleries();
        expect(w.engine.running).toBe(false);
        expect(w.logs("감시하는 갤러리가 없어 감시를 멈췄습니다")).toBe(1);
    });

    it("갤러리 ID 확인이 필요해 감시에서 뺀 갤러리도, 고친 뒤 다시 시작하면 확인한다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        w.gallery.checkedId = "other";
        await w.tick();
        expect(w.logs("감시를 멈춤: 갤러리 탭에서 갤러리 ID를 확인해야 합니다.")).toBe(1);
        w.gallery.checkedId = w.gallery.galleryId;
        const lists = w.server.lists;
        await w.tick();
        expect(w.server.lists).toBe(lists + 1);
        w.engine.stop();
    });

    it("확인하는 도중 다시 예약돼도(깨어남 등) 확인이 두 줄로 겹쳐 돌지 않는다", async () => {
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        const w = world();
        await w.accounts.login(ACCOUNT);
        let release = () => {};
        w.server.hold = new Promise<void>((resolve) => (release = resolve));
        w.engine.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(w.server.started).toBe(1);
        // 첫 확인이 응답을 기다리는 사이 같은 갤러리가 다시 예약돼도, 앞선 확인이 끝날 때까지 디시에 또 요청하지 않습니다.
        w.internals.schedule(w.gallery.id, w.internals.runId, 0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(w.server.started).toBe(1);
        w.server.hold = null;
        release();
        await vi.advanceTimersByTimeAsync(5 * MINUTE);
        // 1분 간격이면 5분 동안 여섯 번 안팎입니다. 두 줄로 돌면 그 두 배가 됩니다.
        expect(w.server.lists).toBeLessThanOrEqual(7);
        expect(w.server.lists).toBeGreaterThanOrEqual(5);
        w.engine.stop();
    });
});

describe("다시 로그인 겹침", () => {
    it("같은 계정의 다시 로그인이 동시에 요청되면 한 번만 로그인하고 둘 다 성공으로 본다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        const logins = w.server.logins;
        w.sleep();
        const results = await Promise.all([w.accounts.recoverLogin("acc1", "세션 만료"), w.accounts.recoverLogin("acc1", "세션 만료")]);
        expect(results).toEqual([true, true]);
        expect(w.server.logins - logins).toBe(1);
    });
});

describe("OTP가 필요해지면 자동 재로그인을 멈춤", () => {
    it("네트워크 오류로 다시 로그인을 기다리다 OTP를 요구받으면, 더는 비밀번호 로그인을 보내지 않는다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        await w.tick();
        w.sleep();
        w.server.loginWorks = false;
        await w.tick();
        expect(w.accounts.isRetrying("acc1")).toBe(true);
        w.server.otp = true;
        w.advance(MINUTE);
        await w.tick();
        expect(w.accounts.status("acc1").state).toBe("otp_required");
        expect(w.accounts.isRetrying("acc1")).toBe(false);
        const logins = w.server.logins;
        for (let i = 0; i < 10; i++) {
            w.advance(5 * MINUTE);
            await w.tick();
        }
        expect(w.server.logins).toBe(logins);
        w.engine.stop();
    });

    it("다시 로그인하는 도중 로그인을 내려놓으면(아이디 변경) 끝난 로그인 결과를 버린다", async () => {
        const w = world();
        await w.accounts.login(ACCOUNT);
        w.sleep();
        let release = () => {};
        w.server.loginHold = new Promise<void>((resolve) => (release = resolve));
        const recovering = w.accounts.recoverLogin("acc1", "세션 만료");
        await Promise.resolve();
        w.accounts.logout("acc1");
        w.server.loginHold = null;
        release();
        await recovering;
        expect(w.accounts.status("acc1").state).toBe("logged_out");
        expect(w.accounts.readingClient([ACCOUNT], ["acc1"])).toBeNull();
    });
});
