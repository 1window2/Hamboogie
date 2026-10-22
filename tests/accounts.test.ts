import {describe, expect, it} from "vitest";
import {AuthExpiredError, DCInsideError, OtpRequiredError, type DCInside, type DeviceCredentials, type LoginOptions} from "@green-1052/dcinside.js";
import {AccountManager} from "../src/main/dc/accounts";
import type {AccountConfig} from "@shared/types";

const ACCOUNT: AccountConfig = {id: "acc1", loginId: "tester", memberTypeOverride: "auto"};

/** 메모리에만 저장하는 비밀 정보 저장소입니다. */
function memorySecrets(initial: Record<string, string> = {}) {
    const data = {...initial};
    return {
        data,
        get: (key: string) => data[key] ?? null,
        set: async (key: string, value: string) => {
            if (value) data[key] = value;
            else delete data[key];
        },
        removeByPrefix: async (prefix: string) => {
            for (const key of Object.keys(data)) if (key.startsWith(prefix)) delete data[key];
        }
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
                result: true, user_id: "tester", name: "너구리국밥", is_gonick: 1,
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
        expect(status).toMatchObject({state: "logged_in", nickname: "너구리국밥", memberType: "gonick", dcconCount: 1});
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

describe("AccountManager app_id 거절 복구", () => {
    it("로그인 후 app_id가 거절되면 기기 정보를 새로 받아 OTP 없이 다시 로그인한다", async () => {
        const {server, secrets, manager} = setup({"otp:acc1": "token-abc", "device:acc1": JSON.stringify({androidId: "old"})});
        server.savedDeviceBroken = true;
        const status = await manager.login(ACCOUNT);
        expect(status).toMatchObject({state: "logged_in", dcconCount: 1});
        expect(status.state === "logged_in" && status.dcconError).toBeUndefined();
        expect(server.clientsCreated).toBe(2);
        expect(server.loginCalls).toEqual([{otpToken: "token-abc"}, {otpToken: "token-abc"}]);
        expect(secrets.data["device:acc1"]).toBe(JSON.stringify({androidId: "1"}));
    });

    it("댓글 작성 중 app_id가 거절되면 기기 정보를 새로 받아 다시 로그인한 뒤 한 번 더 시도한다", async () => {
        const {server, manager} = setup({"otp:acc1": "token-abc", "device:acc1": JSON.stringify({androidId: "old"})});
        await manager.login(ACCOUNT);
        // 로그인 때는 멀쩡하던 기기 정보가 나중에(11시간 뒤 재발급 등) 거절되는 상황입니다.
        const sessionClient = (manager as unknown as {sessions: Map<string, {client: DCInside}>}).sessions.get("acc1")!.client;
        (sessionClient.comments as unknown as {write: () => Promise<never>}).write = async () => {
            throw APP_ID_REFUSED();
        };
        await manager.writeComment("acc1", "asgeir", 1, {type: "text", text: "줄"});
        expect(server.written).toEqual(["줄"]);
        expect(server.clientsCreated).toBe(2);
    });
});
