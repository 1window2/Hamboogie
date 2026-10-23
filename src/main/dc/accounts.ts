import {ApiError, AuthExpiredError, CaptchaRequiredError, DCInside, OtpRequiredError, type DeviceCredentials} from "@green-1052/dcinside.js";
import type {AccountConfig, AccountStatus, MemberType} from "@shared/types";
import type {SecretStore} from "../store";
import {AppIdBackoff} from "./app-id-backoff";
import {isOutdatedAppError, OUTDATED_APP_MESSAGE} from "./app-version";
import type {CandidateAccount, CommentContent, OwnedDccon} from "../pipeline/planner";

interface LoggedIn {
    /** 세션 만료 시 다시 로그인할 때 씁니다. */
    account: AccountConfig;
    client: DCInside;
    nickname: string;
    /** 로그인 응답으로 판별한 계정 종류입니다. 알 수 없으면 null입니다. */
    detectedMemberType: MemberType | null;
    dccons: OwnedDccon[];
    /** 보유 디시콘을 아직 못 불러왔으면 그 이유입니다. */
    dcconError?: string;
    /** app_id가 필요한 요청이 마지막으로 성공한 시각입니다. 이때 받은 app_id는 한동안 다시 발급받지 않고 씁니다. */
    appIdOkAt?: number;
}

/** 받아 둔 app_id를 다시 발급받지 않고 쓸 수 있다고 보는 시간입니다(라이브러리의 갱신 주기 11시간보다 짧게). */
const APP_ID_FRESH_MS = 10 * 60 * 60 * 1000;

/**
 * 댓글을 보내기 전에 실패해서 댓글이 달리지 않은 것이 확실한 오류입니다.
 * 이런 오류일 때만 다음 순위 계정으로 넘어갑니다.
 */
export class CommentNotPostedError extends Error {}

/**
 * 댓글이 달리지 않은 것이 확실한 실패인지 확인합니다. 서버가 명시적으로 거절했거나(ApiError 계열) 보내기 전에 실패한 경우입니다.
 * 응답 시간 초과, 네트워크 오류, 서버 오류(5xx)는 서버가 댓글을 저장했을 수도 있어 확실하지 않습니다.
 */
export function isDefiniteCommentFailure(error: unknown): boolean {
    return error instanceof ApiError || error instanceof CommentNotPostedError || isAppIdFailure(error);
}

const APP_ID_REFUSED_MESSAGE = "디시 앱 인증(app_id) 발급이 일시적으로 거절되었습니다. 같은 IP에서 짧은 시간에 여러 번 발급받으면 한동안 막히며, 잠시 후 다시 시도합니다.";

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
 * `app_id` 발급이 거절된 오류인지 확인합니다. 같은 IP에서 짧은 시간에 여러 번 발급받으면
 * 서버가 한동안 `service id mismatched`로 거절합니다. 대응 규칙은 `AppIdBackoff`에 있습니다.
 */
export function isAppIdFailure(error: unknown): boolean {
    if (error instanceof AuthExpiredError && error.kind === "appId") return true;
    return error instanceof Error && /app_id 발급 실패/.test(error.message);
}

/** 글 읽기 전용 클라이언트를 만듭니다. 로그인하지 않으며 디바이스 인증 정보만 재사용합니다. */
export function createReader(secrets: SecretStore, freshDevice = false): DCInside {
    return new DCInside({credentials: freshDevice ? undefined : loadDevice(secrets, "device:reader")});
}

/**
 * 읽기용 기기 정보를 저장합니다. 인증 정보 발급은 첫 요청 때 일어나므로 요청이 성공한 뒤에 부릅니다.
 * 내용이 바뀌었을 때(새 app_id를 받았을 때 등)만 저장합니다.
 */
export async function persistReader(secrets: SecretStore, client: DCInside): Promise<void> {
    const credentials = JSON.stringify(client.auth.exportCredentials());
    if (secrets.get("device:reader") !== credentials) await secrets.set("device:reader", credentials);
}

/** 등록된 계정의 로그인 상태와 세션을 관리합니다. */
export class AccountManager {
    private readonly sessions = new Map<string, LoggedIn>();
    private readonly statuses = new Map<string, AccountStatus>();
    /** OTP를 요구받은 클라이언트입니다. OTP는 요구받은 클라이언트(같은 기기 정보)로 보내야 합니다. */
    private readonly awaitingOtp = new Map<string, DCInside>();
    /** 삭제된 계정입니다. 재로그인 도중 삭제되면 로그인 결과를 버립니다. */
    private readonly removed = new Set<string>();
    /** 진행 중인 로그인입니다. 같은 계정의 재로그인이 겹치면 하나만 하고 결과를 함께 씁니다. */
    private readonly pendingLogins = new Map<string, Promise<AccountStatus>>();

    constructor(
        private readonly secrets: Pick<SecretStore, "get" | "has" | "set">,
        private readonly createClient: (credentials?: DeviceCredentials) => DCInside = (credentials) => new DCInside({credentials}),
        /** app_id 발급 거절 대기 규칙입니다. 거절은 IP 단위라 읽기용 클라이언트와 함께 씁니다. */
        private readonly appId: AppIdBackoff = new AppIdBackoff(),
        private readonly now: () => number = Date.now
    ) {}

    status(accountId: string): AccountStatus {
        return this.statuses.get(accountId) ?? {state: "logged_out"};
    }

    /**
     * 로그인합니다. 저장된 OTP 토큰이 있으면 OTP 없이 통과하고, 없거나 만료됐으면 `otp_required` 상태가 됩니다.
     *
     * 로그인 직후 보유 디시콘을 불러오며 `app_id`를 받아 둡니다. 발급이 거절돼도 로그인은 유지하고 디시콘은 나중에 다시 불러옵니다.
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
            // 보유 디시콘을 불러오면서 app_id도 받아 둡니다. 거절되면 로그인은 그대로 두고 디시콘만 나중에 다시 불러옵니다.
            await this.loadDccons(loggedIn);
            // 로그인하는 사이 계정이 삭제됐으면 결과를 버립니다(기기 정보를 다시 저장하지 않습니다).
            if (this.removed.has(account.id)) return {state: "logged_out"};
            // app_id를 받은 뒤에 저장해야 앱을 다시 켰을 때 app_id를 또 발급받지 않습니다.
            await saveDevice(this.secrets, deviceKey, client);
            this.sessions.set(account.id, loggedIn);
            return this.setStatus(account.id, this.loggedInStatus(account, loggedIn));
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

    private loggedInStatus(account: AccountConfig, loggedIn: LoggedIn): AccountStatus {
        return {
            state: "logged_in",
            nickname: loggedIn.nickname,
            memberType: this.memberType(account, loggedIn),
            dcconCount: loggedIn.dccons.length,
            ...(loggedIn.dcconError ? {dcconError: loggedIn.dcconError} : {})
        };
    }

    private async loadDccons(loggedIn: LoggedIn): Promise<void> {
        try {
            const response = await loggedIn.client.dccons.list();
            const tabs = response.tab ?? [];
            loggedIn.dccons = (response.list ?? []).flatMap((list, index) => list.flatMap((item) =>
                item.package_idx !== undefined && item.detail_idx !== undefined
                    ? [{
                        packageIdx: item.package_idx,
                        detailIdx: item.detail_idx,
                        title: item.title ?? "",
                        packageTitle: tabs[index]?.title ?? ""
                    }]
                    : []));
            loggedIn.dcconError = undefined;
            loggedIn.appIdOkAt = this.now();
            this.appId.succeed();
        } catch (error) {
            if (isAppIdFailure(error)) {
                this.appId.fail();
                loggedIn.dcconError = isOutdatedAppError(error) ? OUTDATED_APP_MESSAGE : APP_ID_REFUSED_MESSAGE;
            } else {
                loggedIn.dcconError = describe(error);
            }
        }
    }

    /**
     * 보유 디시콘을 못 불러온 계정은 잠시 쉰 뒤 다시 불러옵니다. 감시 중에 주기적으로 부릅니다.
     * 상태가 바뀐 계정이 있으면 true를 돌려줍니다.
     */
    async maintain(accounts: AccountConfig[]): Promise<boolean> {
        let changed = false;
        for (const [id, loggedIn] of this.sessions) {
            if (!loggedIn.dcconError || !this.appId.canTry()) continue;
            await this.loadDccons(loggedIn);
            const account = accounts.find((item) => item.id === id) ?? loggedIn.account;
            this.setStatus(id, this.loggedInStatus(account, loggedIn));
            changed = true;
        }
        return changed;
    }

    private memberType(account: AccountConfig, loggedIn: LoggedIn): MemberType | null {
        return account.memberTypeOverride === "auto" ? loggedIn.detectedMemberType : account.memberTypeOverride;
    }

    /**
     * 글을 읽을 때 쓸 로그인된 계정의 클라이언트입니다. 계정 목록 순서에서 처음으로 로그인된 계정을 씁니다.
     * 읽기용 기기를 따로 두지 않으면 앱 인증(app_id)을 하나만 받으면 됩니다. 로그인된 계정이 없으면 null입니다.
     */
    readingClient(accounts: AccountConfig[]): {accountId: string; client: DCInside} | null {
        for (const account of accounts) {
            const loggedIn = this.sessions.get(account.id);
            if (loggedIn) return {accountId: account.id, client: loggedIn.client};
        }
        return null;
    }

    /** 글 읽기에 쓴 계정의 요청이 성공했음을 기록합니다. 그 계정의 app_id가 유효하다는 뜻입니다. */
    markAppIdOk(accountId: string): void {
        const loggedIn = this.sessions.get(accountId);
        if (loggedIn) loggedIn.appIdOkAt = this.now();
    }

    /** app_id 거절이 오래 이어질 때 그 계정의 기기 정보를 새로 받아 다시 로그인합니다. */
    async refreshDevice(accountId: string): Promise<void> {
        const loggedIn = this.sessions.get(accountId);
        if (loggedIn) await this.login(loggedIn.account, undefined, true);
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
     * 댓글을 답니다. 로그인 세션이 만료됐으면 다시 로그인한 뒤 한 번 더 시도합니다.
     * app_id 발급이 거절된 상태면 발급 요청을 늘리지 않도록 바로 실패로 처리하고, 거절이 오래 이어졌을 때만
     * 기기 정보를 새로 받아 다시 로그인한 뒤 한 번 더 시도합니다.
     *
     * 댓글이 달리지 않은 것이 확실한 실패는 `isDefiniteCommentFailure`가 true인 오류로 던집니다.
     */
    async writeComment(accountId: string, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        const loggedIn = this.sessions.get(accountId);
        if (!loggedIn) throw new CommentNotPostedError("로그인되지 않은 계정입니다.");
        // 받아 둔 app_id가 아직 유효하면 대기 중이어도 씁니다(발급 요청이 나가지 않습니다).
        const hasFreshAppId = loggedIn.appIdOkAt !== undefined && this.now() - loggedIn.appIdOkAt < APP_ID_FRESH_MS;
        if (!hasFreshAppId && !this.appId.canTry()) throw new CommentNotPostedError(APP_ID_REFUSED_MESSAGE);
        try {
            await this.write(loggedIn.client, galleryId, postNo, content);
            loggedIn.appIdOkAt = this.now();
            this.appId.succeed();
            return;
        } catch (error) {
            if (isAppIdFailure(error)) {
                const needsFreshDevice = this.appId.fail();
                // 앱 버전이 낮아 거절된 것이면 기기 정보를 새로 받아도 풀리지 않습니다.
                if (isOutdatedAppError(error)) throw new CommentNotPostedError(OUTDATED_APP_MESSAGE);
                if (!needsFreshDevice) throw new CommentNotPostedError(APP_ID_REFUSED_MESSAGE);
            } else if (!(error instanceof AuthExpiredError)) {
                throw error;
            }
            const freshDevice = isAppIdFailure(error);
            const status = await this.login(loggedIn.account, undefined, freshDevice);
            const renewed = this.sessions.get(accountId);
            if (status.state !== "logged_in" || !renewed) {
                throw new CommentNotPostedError(`${freshDevice ? "앱 인증(app_id) 거절이 계속되어" : "세션이 만료되어"} 다시 로그인했지만 실패했습니다: ${"message" in status ? status.message : status.state}`);
            }
            await this.write(renewed.client, galleryId, postNo, content);
            renewed.appIdOkAt = this.now();
        }
    }

    private async write(client: DCInside, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        if (content.type === "text") {
            await client.comments.write(galleryId, postNo, content.text);
            return;
        }
        const inserted = await client.dccons.insert({package_idx: content.dccon.packageIdx, detail_idx: content.dccon.detailIdx});
        if (!inserted.img_tag) throw new CommentNotPostedError("디시콘 태그를 받지 못했습니다.");
        await client.comments.write(galleryId, postNo, {dccons: [{tag: inserted.img_tag, detailIdx: content.dccon.detailIdx}]});
    }

    nickname(accountId: string): string {
        return this.sessions.get(accountId)?.nickname ?? accountId;
    }

    async remove(accountId: string): Promise<void> {
        this.removed.add(accountId);
        this.sessions.delete(accountId);
        this.awaitingOtp.delete(accountId);
        this.statuses.delete(accountId);
        // 앞부분이 같은 다른 키까지 지우지 않도록 정확한 키만 지웁니다.
        await this.secrets.set(`account:${accountId}`, "");
        await this.secrets.set(`device:${accountId}`, "");
        await this.secrets.set(`otp:${accountId}`, "");
    }
}
