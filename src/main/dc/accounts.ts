import {AuthExpiredError, CaptchaRequiredError, DCInside, OtpRequiredError, type DeviceCredentials} from "@green-1052/dcinside.js";
import type {AccountConfig, AccountStatus, MemberType} from "@shared/types";
import type {SecretStore} from "../store";
import type {CandidateAccount, CommentContent, OwnedDccon} from "../pipeline/planner";

interface LoggedIn {
    /** 세션 만료 시 다시 로그인할 때 씁니다. */
    account: AccountConfig;
    client: DCInside;
    nickname: string;
    /** 로그인 응답으로 판별한 계정 종류입니다. 알 수 없으면 null입니다. */
    detectedMemberType: MemberType | null;
    dccons: OwnedDccon[];
}

function describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function loadDevice(secrets: Pick<SecretStore, "get">, key: `device:${string}`): DeviceCredentials | undefined {
    const saved = secrets.get(key);
    if (!saved) return undefined;
    try {
        return JSON.parse(saved) as DeviceCredentials;
    } catch {
        return undefined;
    }
}

async function saveDevice(secrets: Pick<SecretStore, "set">, key: `device:${string}`, client: DCInside): Promise<void> {
    await secrets.set(key, JSON.stringify(client.auth.exportCredentials()));
}

/**
 * `app_id` 발급이 거절된 오류인지 확인합니다. 같은 기기 정보(client_token)로 `app_id`를 반복 발급하면
 * 서버가 `service id mismatched`로 거절하므로, 이때는 기기 정보를 새로 받아야 합니다.
 */
export function isAppIdFailure(error: unknown): boolean {
    if (error instanceof AuthExpiredError && error.kind === "appId") return true;
    return error instanceof Error && /app_id 발급 실패/.test(error.message);
}

/** 글 읽기 전용 클라이언트를 만듭니다. 로그인하지 않으며 디바이스 인증 정보만 재사용합니다. */
export function createReader(secrets: SecretStore, freshDevice = false): DCInside {
    return new DCInside({credentials: freshDevice ? undefined : loadDevice(secrets, "device:reader")});
}

/** 인증 정보 발급은 첫 요청 때 일어나므로, 첫 요청이 성공한 뒤에 호출합니다. */
export async function persistReader(secrets: SecretStore, client: DCInside): Promise<void> {
    await saveDevice(secrets, "device:reader", client);
}

/** 등록된 계정의 로그인 상태와 세션을 관리합니다. */
export class AccountManager {
    private readonly sessions = new Map<string, LoggedIn>();
    private readonly statuses = new Map<string, AccountStatus>();
    /** OTP를 요구받은 클라이언트입니다. OTP는 요구받은 클라이언트(같은 기기 정보)로 보내야 합니다. */
    private readonly awaitingOtp = new Map<string, DCInside>();
    /** 진행 중인 로그인입니다. 같은 계정의 재로그인이 겹치면 하나만 하고 결과를 함께 씁니다. */
    private readonly pendingLogins = new Map<string, Promise<AccountStatus>>();

    constructor(
        private readonly secrets: Pick<SecretStore, "get" | "has" | "set" | "removeByPrefix">,
        private readonly createClient: (credentials?: DeviceCredentials) => DCInside = (credentials) => new DCInside({credentials})
    ) {}

    status(accountId: string): AccountStatus {
        return this.statuses.get(accountId) ?? {state: "logged_out"};
    }

    /**
     * 로그인합니다. 저장된 OTP 토큰이 있으면 OTP 없이 통과하고, 없거나 만료됐으면 `otp_required` 상태가 됩니다.
     *
     * 로그인 직후 보유 디시콘을 불러오며 `app_id`를 받아 두고, 발급이 거절되면 기기 정보를 새로 받아 한 번 다시 로그인합니다.
     *
     * @param otp 사용자가 입력한 OTP 6자리입니다.
     * @param freshDevice 저장된 기기 정보를 버리고 새로 받습니다.
     */
    async login(account: AccountConfig, otp?: string, freshDevice = false): Promise<AccountStatus> {
        // OTP를 넣은 로그인은 사용자가 직접 한 것이라 겹치지 않습니다. 자동 재로그인만 합칩니다.
        const pending = otp ? undefined : this.pendingLogins.get(account.id);
        if (pending) return pending;
        const attempt = this.doLogin(account, otp, freshDevice);
        if (!otp) this.pendingLogins.set(account.id, attempt);
        try {
            return await attempt;
        } finally {
            if (this.pendingLogins.get(account.id) === attempt) this.pendingLogins.delete(account.id);
        }
    }

    private async doLogin(account: AccountConfig, otp: string | undefined, freshDevice: boolean): Promise<AccountStatus> {
        const password = this.secrets.get(`account:${account.id}`);
        if (!account.loginId || !password) {
            const message = account.loginId && this.secrets.has(`account:${account.id}`)
                ? "저장된 비밀번호를 읽지 못했습니다. 비밀번호를 다시 저장하세요."
                : "아이디와 비밀번호를 먼저 입력하세요.";
            return this.setStatus(account.id, {state: "error", message});
        }

        this.statuses.set(account.id, {state: "logging_in"});
        const deviceKey = `device:${account.id}` as const;
        const otpKey = `otp:${account.id}` as const;
        const otpToken = otp ? undefined : this.secrets.get(otpKey) ?? undefined;
        const client = (otp && this.awaitingOtp.get(account.id))
            || this.createClient(freshDevice ? undefined : loadDevice(this.secrets, deviceKey));
        this.awaitingOtp.delete(account.id);
        try {
            const session = await client.login(account.loginId, password, otp ? {otp} : {otpToken});
            // OTP로 로그인하면 다음부터 OTP 없이 통과할 수 있는 토큰을 줍니다.
            if (session.result.otp_token) await this.secrets.set(otpKey, session.result.otp_token);
            const isGonick = session.result.is_gonick;
            const loggedIn: LoggedIn = {
                account,
                client,
                nickname: session.result.name ?? account.loginId,
                detectedMemberType: isGonick === 1 ? "gonick" : isGonick === 0 ? "semi" : null,
                dccons: []
            };
            const dccons = await this.loadDccons(client);
            // OTP를 썼더라도 위에서 OTP 토큰을 저장했으므로, 다시 로그인할 때는 OTP를 묻지 않습니다.
            if (dccons.error !== undefined && isAppIdFailure(dccons.error) && !freshDevice) return this.doLogin(account, undefined, true);
            // app_id를 받은 뒤에 저장해야 앱을 다시 켰을 때 app_id를 또 발급받지 않습니다.
            await saveDevice(this.secrets, deviceKey, client);
            loggedIn.dccons = dccons.items;
            this.sessions.set(account.id, loggedIn);
            return this.setStatus(account.id, {
                state: "logged_in",
                nickname: loggedIn.nickname,
                memberType: this.memberType(account, loggedIn),
                dcconCount: loggedIn.dccons.length,
                ...(dccons.error !== undefined ? {dcconError: describe(dccons.error)} : {})
            });
        } catch (error) {
            this.sessions.delete(account.id);
            if (error instanceof OtpRequiredError) {
                this.awaitingOtp.set(account.id, client);
                await saveDevice(this.secrets, deviceKey, client);
                // 저장된 토큰으로 실패했다면 만료된 것이므로 지웁니다.
                if (otpToken) await this.secrets.set(otpKey, "");
                return this.setStatus(account.id, {
                    state: "otp_required",
                    message: otp ? `OTP 인증 실패: ${error.message}` : "OTP 번호를 입력하세요."
                });
            }
            const message = error instanceof CaptchaRequiredError
                ? "로그인에 캡차 입력이 필요합니다. 디시 앱이나 웹에서 한 번 로그인한 뒤 다시 시도하세요."
                : `로그인 실패: ${error instanceof Error ? error.message : String(error)}`;
            return this.setStatus(account.id, {state: "error", message});
        }
    }

    private setStatus(accountId: string, status: AccountStatus): AccountStatus {
        this.statuses.set(accountId, status);
        return status;
    }

    private async loadDccons(client: DCInside): Promise<{items: OwnedDccon[]; error?: unknown}> {
        try {
            const response = await client.dccons.list();
            const tabs = response.tab ?? [];
            const items = (response.list ?? []).flatMap((list, index) => list.flatMap((item) =>
                item.package_idx !== undefined && item.detail_idx !== undefined
                    ? [{
                        packageIdx: item.package_idx,
                        detailIdx: item.detail_idx,
                        title: item.title ?? "",
                        packageTitle: tabs[index]?.title ?? ""
                    }]
                    : []));
            return {items};
        } catch (error) {
            return {items: [], error};
        }
    }

    private memberType(account: AccountConfig, loggedIn: LoggedIn): MemberType | null {
        return account.memberTypeOverride === "auto" ? loggedIn.detectedMemberType : account.memberTypeOverride;
    }

    /** 대기 계정 중 로그인된 계정만 우선순위 순서대로 돌려줍니다. */
    candidates(accounts: AccountConfig[], accountIds: string[]): CandidateAccount[] {
        return accountIds.flatMap((id) => {
            const account = accounts.find((item) => item.id === id);
            const loggedIn = this.sessions.get(id);
            if (!account || !loggedIn) return [];
            return [{id, memberType: this.memberType(account, loggedIn), dccons: loggedIn.dccons}];
        });
    }

    /**
     * 댓글을 답니다. 로그인 세션이 만료됐거나 `app_id` 발급이 거절되면 다시 로그인한 뒤 한 번 더 시도합니다.
     * `app_id` 문제일 때는 기기 정보도 새로 받습니다.
     */
    async writeComment(accountId: string, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        const loggedIn = this.sessions.get(accountId);
        if (!loggedIn) throw new Error("로그인되지 않은 계정입니다.");
        try {
            await this.write(loggedIn.client, galleryId, postNo, content);
        } catch (error) {
            const appIdFailure = isAppIdFailure(error);
            if (!(error instanceof AuthExpiredError) && !appIdFailure) throw error;
            const status = await this.login(loggedIn.account, undefined, appIdFailure);
            const renewed = this.sessions.get(accountId);
            if (status.state !== "logged_in" || !renewed) {
                throw new Error(`${appIdFailure ? "앱 인증(app_id)이 거절되어" : "세션이 만료되어"} 다시 로그인했지만 실패했습니다: ${"message" in status ? status.message : status.state}`);
            }
            await this.write(renewed.client, galleryId, postNo, content);
        }
    }

    private async write(client: DCInside, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        if (content.type === "text") {
            await client.comments.write(galleryId, postNo, content.text);
            return;
        }
        const inserted = await client.dccons.insert({package_idx: content.dccon.packageIdx, detail_idx: content.dccon.detailIdx});
        if (!inserted.img_tag) throw new Error("디시콘 태그를 받지 못했습니다.");
        await client.comments.write(galleryId, postNo, {dccons: [{tag: inserted.img_tag, detailIdx: content.dccon.detailIdx}]});
    }

    nickname(accountId: string): string {
        return this.sessions.get(accountId)?.nickname ?? accountId;
    }

    async remove(accountId: string): Promise<void> {
        this.sessions.delete(accountId);
        this.awaitingOtp.delete(accountId);
        this.statuses.delete(accountId);
        await this.secrets.removeByPrefix(`account:${accountId}`);
        await this.secrets.removeByPrefix(`device:${accountId}`);
        await this.secrets.removeByPrefix(`otp:${accountId}`);
    }
}
