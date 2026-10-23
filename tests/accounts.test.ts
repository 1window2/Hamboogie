import {describe, expect, it} from "vitest";
import {APP, AuthExpiredError, DCInsideError, OtpRequiredError, type DCInside, type DeviceCredentials, type LoginOptions} from "@green-1052/dcinside.js";
import {AccountManager} from "../src/main/dc/accounts";
import {applyDcAppVersion, DC_APP_VERSION} from "../src/main/dc/app-version";
import {AppIdBackoff} from "../src/main/dc/app-id-backoff";
import type {AccountConfig} from "@shared/types";

const ACCOUNT: AccountConfig = {id: "acc1", loginId: "tester", memberTypeOverride: "auto"};

/** 메모리에만 저장하는 비밀 정보 저장소입니다. */
function memorySecrets(initial: Record<string, string> = {}) {
    const data = {...initial};
    return {
        data,
        get: (key: string) => data[key] ?? null,
        has: (key: string) => key in data,
        set: async (key: string, value: string) => {
            if (value) data[key] = value;
            else delete data[key];
        },
    };
}

interface FakeServer {
    /** 이 토큰이면 OTP 없이 통과합니다. */
    validOtpToken: string;
    loginCalls: LoginOptions[];
    /** 댓글 작성이 이 횟수만큼 세션 만료로 실패합니다. */
    expireWrites: number;
    written: string[];
    clientsCreated: number;
    /** true면 저장된 기기 정보로 만든 클라이언트는 app_id 발급을 거절당합니다. */
    savedDeviceBroken: boolean;
}

const APP_ID_REFUSED = () => new DCInsideError('app_id 발급 실패: {"result":false,"cause":"2114 DC Error Description :service id mismatched."}');

function fakeClientFactory(server: FakeServer) {
    return (credentials?: DeviceCredentials) => (server.clientsCreated++, {
        async login(_id: string, _password: string, options: LoginOptions = {}) {
            server.loginCalls.push(options);
            const viaToken = options.otpToken === server.validOtpToken;
            if (!viaToken && options.otp !== "123456") throw new OtpRequiredError("OTP가 필요합니다.", null);
            return {type: "login", id: _id, password: _password, userId: "tester", result: {
                result: true, user_id: "tester", name: "테스트닉", is_gonick: 1,
                otp_token: options.otp ? server.validOtpToken : undefined
            }};
        },
        auth: {exportCredentials: () => ({androidId: "1"})},
        dccons: {
            async list() {
                if (credentials && server.savedDeviceBroken) throw APP_ID_REFUSED();
                return {tab: [{title: "음식콘"}], list: [[{package_idx: 1, detail_idx: 11, title: "햄버거"}]]};
            },
            insert: async () => ({img_tag: "<img>"})
        },
        comments: {
            async write(_gallery: string, _no: number, content: unknown) {
                if (credentials && server.savedDeviceBroken) throw APP_ID_REFUSED();
                if (server.expireWrites > 0) {
                    server.expireWrites--;
                    throw new AuthExpiredError("login", "세션 만료");
                }
                server.written.push(String(content));
                return {result: "true"};
            }
        }
    }) as unknown as DCInside;
}

function setup(secretsInit: Record<string, string> = {}) {
    const server: FakeServer = {validOtpToken: "token-abc", loginCalls: [], expireWrites: 0, written: [], clientsCreated: 0, savedDeviceBroken: false};
    const secrets = memorySecrets({"account:acc1": "pw", ...secretsInit});
    const manager = new AccountManager(secrets, fakeClientFactory(server));
    return {server, secrets, manager};
}

describe("AccountManager OTP 로그인", () => {
    it("OTP 토큰이 없으면 OTP 입력을 요구하고, OTP로 로그인하면 토큰을 저장한다", async () => {
        const {secrets, manager} = setup();
        expect((await manager.login(ACCOUNT)).state).toBe("otp_required");

        const status = await manager.login(ACCOUNT, "123456");
        expect(status).toMatchObject({state: "logged_in", nickname: "테스트닉", memberType: "gonick", dcconCount: 1});
        expect(secrets.data["otp:acc1"]).toBe("token-abc");
    });

    it("OTP는 OTP를 요구받은 클라이언트(같은 기기 정보)로 보낸다", async () => {
        const {server, manager} = setup();
        await manager.login(ACCOUNT);
        await manager.login(ACCOUNT, "123456");
        expect(server.clientsCreated).toBe(1);
        expect(server.loginCalls).toEqual([{otpToken: undefined}, {otp: "123456"}]);
    });

    it("저장된 OTP 토큰이 있으면 OTP 없이 로그인한다", async () => {
        const {server, manager} = setup({"otp:acc1": "token-abc"});
        expect((await manager.login(ACCOUNT)).state).toBe("logged_in");
        expect(server.loginCalls[0]).toEqual({otpToken: "token-abc"});
    });

    it("만료된 OTP 토큰은 지우고 OTP 입력을 요구한다", async () => {
        const {secrets, manager} = setup({"otp:acc1": "old-token"});
        expect((await manager.login(ACCOUNT)).state).toBe("otp_required");
        expect(secrets.data["otp:acc1"]).toBeUndefined();
    });

    it("틀린 OTP는 실패 메시지와 함께 다시 OTP를 요구한다", async () => {
        const {manager} = setup();
        expect(await manager.login(ACCOUNT, "000000")).toMatchObject({state: "otp_required", message: expect.stringContaining("OTP 인증 실패")});
    });
});

describe("AccountManager 댓글 작성", () => {
    it("세션이 만료되면 저장된 토큰으로 다시 로그인한 뒤 한 번 더 시도한다", async () => {
        const {server, manager} = setup({"otp:acc1": "token-abc"});
        await manager.login(ACCOUNT);
        server.expireWrites = 1;
        await manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"});
        expect(server.written).toEqual(["줄"]);
        expect(server.loginCalls).toHaveLength(2);
    });

    it("다시 로그인해도 실패하면 오류를 던진다", async () => {
        const {server, secrets, manager} = setup({"otp:acc1": "token-abc"});
        await manager.login(ACCOUNT);
        server.expireWrites = 1;
        server.validOtpToken = "rotated";
        await expect(manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"})).rejects.toThrow("다시 로그인했지만 실패");
        expect(server.written).toEqual([]);
        expect(secrets.data["otp:acc1"]).toBeUndefined();
    });

    it("계정을 지우면 비밀번호, 디바이스 정보, OTP 토큰을 모두 지운다", async () => {
        const {secrets, manager} = setup({"otp:acc1": "token-abc"});
        await manager.login(ACCOUNT);
        await manager.remove("acc1");
        expect(Object.keys(secrets.data)).toEqual([]);
    });
});

describe("AccountManager app_id 거절 대응", () => {
    function setupWithClock(secretsInit: Record<string, string>) {
        let now = 1_000_000;
        const server: FakeServer = {validOtpToken: "token-abc", loginCalls: [], expireWrites: 0, written: [], clientsCreated: 0, savedDeviceBroken: false};
        const secrets = memorySecrets({"account:acc1": "pw", ...secretsInit});
        const clock = () => now;
        const manager = new AccountManager(secrets, fakeClientFactory(server), new AppIdBackoff(clock), clock);
        return {server, secrets, manager, advance: (ms: number) => (now += ms)};
    }
    const MINUTE = 60 * 1000;

    it("로그인 직후 app_id가 거절돼도 로그인은 유지하고 기기 정보를 새로 받지 않는다. 쉬고 나면 디시콘을 다시 불러온다", async () => {
        const {server, manager, advance} = setupWithClock({"otp:acc1": "token-abc", "device:acc1": JSON.stringify({androidId: "old"})});
        server.savedDeviceBroken = true;
        const status = await manager.login(ACCOUNT);
        expect(status).toMatchObject({state: "logged_in", dcconCount: 0, dcconError: expect.stringContaining("일시적으로 거절")});
        expect(server.clientsCreated).toBe(1);

        // 쉬는 동안에는 다시 시도하지 않습니다.
        server.savedDeviceBroken = false;
        expect(await manager.maintain([ACCOUNT])).toBe(false);
        advance(5 * MINUTE);
        expect(await manager.maintain([ACCOUNT])).toBe(true);
        expect(manager.status("acc1")).toMatchObject({state: "logged_in", dcconCount: 1});
        expect(server.clientsCreated).toBe(1);
    });

    it("댓글 작성 중 app_id가 거절되면 바로 실패로 처리하고, 30분 넘게 이어질 때만 기기 정보를 새로 받아 다시 시도한다", async () => {
        const {server, manager, advance} = setupWithClock({"otp:acc1": "token-abc", "device:acc1": JSON.stringify({androidId: "old"})});
        await manager.login(ACCOUNT);
        const refuse = () => {
            const client = (manager as unknown as {sessions: Map<string, {client: DCInside}>}).sessions.get("acc1")!.client;
            (client.comments as unknown as {write: () => Promise<never>}).write = async () => {
                throw APP_ID_REFUSED();
            };
        };
        refuse();
        await expect(manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"})).rejects.toThrow("일시적으로 거절");
        expect(server.clientsCreated).toBe(1);

        advance(31 * MINUTE);
        await manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"});
        expect(server.written).toEqual(["줄"]);
        expect(server.clientsCreated).toBe(2);
    });
    it("앱 버전이 낮아 거절되면 30분이 지나도 기기 정보를 새로 받지 않고 업데이트가 필요하다고 알린다", async () => {
        const {server, manager, advance} = setupWithClock({"otp:acc1": "token-abc", "device:acc1": JSON.stringify({androidId: "old"})});
        await manager.login(ACCOUNT);
        const client = (manager as unknown as {sessions: Map<string, {client: DCInside}>}).sessions.get("acc1")!.client;
        (client.comments as unknown as {write: () => Promise<never>}).write = async () => {
            throw new DCInsideError('app_id 발급 실패: {"result":false,"cause":"앱을 계속 이용하시려면 스토어에서 최신 버전으로 업데이트해 주세요."}');
        };
        await expect(manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"})).rejects.toThrow("업데이트");
        advance(31 * MINUTE);
        await expect(manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"})).rejects.toThrow("업데이트");
        expect(server.clientsCreated).toBe(1);
    });
});

describe("디시 앱 버전", () => {
    it("다른 앱 버전으로 저장한 기기 정보는 받아 둔 app_id만 버리고, 같은 버전이면 그대로 쓴다", async () => {
        const used: (DeviceCredentials | undefined)[] = [];
        const device = {androidId: "old", securityToken: "s", fid: "f", refreshToken: "r", clientToken: "c", appId: "old-app-id", appIdIssuedAt: 1};
        for (const appVersion of [undefined, "100175", DC_APP_VERSION.code]) {
            const server: FakeServer = {validOtpToken: "token-abc", loginCalls: [], expireWrites: 0, written: [], clientsCreated: 0, savedDeviceBroken: false};
            const secrets = memorySecrets({"account:acc1": "pw", "otp:acc1": "token-abc", "device:acc1": JSON.stringify({...device, appVersion})});
            const factory = fakeClientFactory(server);
            await new AccountManager(secrets, (credentials) => (used.push(credentials), factory(credentials)), new AppIdBackoff()).login(ACCOUNT);
        }
        expect(used.map((credentials) => credentials?.appId)).toEqual([null, null, "old-app-id"]);
        expect(used.every((credentials) => credentials?.androidId === "old")).toBe(true);
    });

    it("클라이언트를 만들기 전에 디시가 요구하는 버전으로 맞춘다", () => {
        applyDcAppVersion();
        expect(APP.versionName).toBe(DC_APP_VERSION.name);
        expect(APP.versionCode).toBe(DC_APP_VERSION.code);
    });
});

describe("AccountManager 계정 삭제", () => {
    it("앞부분이 같은 다른 키는 지우지 않는다", async () => {
        const {secrets, manager} = setup({"otp:acc1": "token-abc", "account:acc10": "other", "device:reader": "r"});
        await manager.login(ACCOUNT);
        await manager.remove("acc1");
        expect(Object.keys(secrets.data).sort()).toEqual(["account:acc10", "device:reader"]);
    });
});

describe("AccountManager 글 읽기 계정", () => {
    it("계정 목록 순서에서 처음으로 로그인된 계정의 클라이언트로 읽고, 없으면 null", async () => {
        const {manager} = setup({"otp:acc1": "token-abc"});
        const other: AccountConfig = {id: "acc0", loginId: "other", memberTypeOverride: "auto"};
        expect(manager.readingClient([other, ACCOUNT])).toBeNull();
        await manager.login(ACCOUNT);
        expect(manager.readingClient([other, ACCOUNT])?.accountId).toBe("acc1");
    });
});
