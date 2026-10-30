import {ApiError, AuthExpiredError, CaptchaRequiredError, DCInside, OtpRequiredError, type DeviceCredentials} from "@green-1052/dcinside.js";
import type {AccountConfig, AccountStatus, MemberType} from "@shared/types";
import type {SecretStore} from "../store";
import {AppIdBackoff} from "./app-id-backoff";
import {DC_APP_VERSION_CODE, isOutdatedAppError, OUTDATED_APP_MESSAGE, OUTDATED_PAUSE_MS} from "./app-version";
import type {CandidateAccount, CommentContent, OwnedDccon} from "../pipeline/planner";
import {errorMessage} from "@shared/errors";

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
    /** 보유 디시콘을 다시 불러와도 되는 시각입니다. app_id 거절이 아닌 오류로 실패했을 때 매 확인마다 다시 요청하지 않게 합니다. */
    dcconRetryAt?: number;
}

/** 받아 둔 app_id를 다시 발급받지 않고 쓸 수 있다고 보는 시간입니다(라이브러리의 갱신 주기 11시간보다 짧게). */
const APP_ID_FRESH_MS = 10 * 60 * 60 * 1000;

/** app_id 거절이 아닌 오류로 보유 디시콘을 못 불러왔을 때 다시 시도하기까지 기다리는 시간입니다. */
const DCCON_RETRY_MS = 10 * 60 * 1000;

/**
 * 댓글을 보내기 전에 실패해서 댓글이 달리지 않은 것이 확실한 오류입니다.
 * 이런 오류일 때만 다음 순위 계정으로 넘어갑니다.
 */
export class CommentNotPostedError extends Error {}

/**
 * 댓글이 달리지 않은 것이 확실한 실패인지 확인합니다. 서버가 명시적으로 거절했거나(ApiError 계열),
 * 댓글 요청을 보내기 전 단계(앱 인증, 디시콘 준비 등)에서 실패해 `CommentNotPostedError`로 바꾼 경우입니다.
 * 댓글 요청 중의 응답 시간 초과, 네트워크 오류, 서버 오류(5xx)는 서버가 댓글을 저장했을 수도 있어 확실하지 않습니다.
 */
export function isDefiniteCommentFailure(error: unknown): boolean {
    return error instanceof ApiError || error instanceof CommentNotPostedError || isAppIdFailure(error);
}

const APP_ID_REFUSED_MESSAGE = "디시 앱 인증(app_id) 발급이 일시적으로 거절되었습니다. 같은 IP에서 짧은 시간에 여러 번 발급받으면 한동안 막히며, 잠시 후 다시 시도합니다.";

function describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 저장한 기기 정보에 함께 적는, 그때 쓰던 앱 버전 코드입니다. */
type SavedDevice = DeviceCredentials & {appVersion?: string};

/**
 * 저장된 기기 정보를 읽습니다. 받아 둔 app_id는 발급받을 때의 앱 버전에 묶여 있어, 디시가 강제 업데이트를 걸면
 * 옛 버전으로 받은 app_id는 거절됩니다. 그래서 다른 앱 버전으로 저장한 정보면 app_id만 버리고 새로 받게 합니다.
 */
function loadDevice(secrets: Pick<SecretStore, "get">, key: `device:${string}`): DeviceCredentials | undefined {
    const saved = secrets.get(key);
    if (!saved) return undefined;
    try {
        const {appVersion, ...credentials} = JSON.parse(saved) as SavedDevice;
        return appVersion === DC_APP_VERSION_CODE ? credentials : {...credentials, appId: null, appIdIssuedAt: null};
    } catch {
        return undefined;
    }
}

function serializeDevice(client: DCInside): string {
    const credentials = client.auth.exportCredentials();
    return JSON.stringify(credentials ? {...credentials, appVersion: DC_APP_VERSION_CODE} satisfies SavedDevice : null);
}

async function saveDevice(secrets: Pick<SecretStore, "set">, key: `device:${string}`, client: DCInside): Promise<void> {
    await secrets.set(key, serializeDevice(client));
}

/**
 * `app_id` 발급이 거절된 오류인지 확인합니다. 같은 IP에서 짧은 시간에 여러 번 발급받으면
 * 서버가 한동안 `service id mismatched`로 거절합니다. 대응 규칙은 `AppIdBackoff`에 있습니다.
 * 앱 버전이 낮다는 거절은 발급 단계뿐 아니라 이미 받아 둔 app_id로 보낸 일반 요청에서도 오므로 함께 봅니다.
 */
export function isAppIdFailure(error: unknown): boolean {
    if (error instanceof AuthExpiredError && error.kind === "appId") return true;
    return error instanceof Error && (/app_id 발급 실패/.test(error.message) || isOutdatedAppError(error));
}

/** 로그인 세션이 만료됐고 라이브러리의 자동 재로그인도 실패한 오류입니다(비밀번호 변경 등). */
export function isLoginExpired(error: unknown): boolean {
    return error instanceof AuthExpiredError && error.kind === "login";
}

/**
 * 갤러리에 보안 코드(캡차)가 걸려 있어 댓글을 자동으로 달 수 없는 오류입니다.
 * 계정을 바꿔도 같으므로 다음 계정으로 넘어가지 않습니다.
 */
export function isCaptchaFailure(error: unknown): boolean {
    return error instanceof CaptchaRequiredError;
}

/** 로그인 만료로 다시 로그인을 시도하는 최소 간격입니다(계정마다). */
const LOGIN_RECOVERY_GAP_MS = 30 * 60 * 1000;
/** 일시적인 오류로 로그인하지 못했을 때 다시 시도하는 간격입니다. 실패할 때마다 두 배로 늘립니다. */
const LOGIN_RETRY_FIRST_MS = 60 * 1000;
const LOGIN_RETRY_MAX_MS = 30 * 60 * 1000;

/**
 * 다시 시도하면 풀릴 수 있는 로그인 실패인지입니다. 디시가 응답으로 거절한 것(비밀번호 불일치, OTP·캡차 필요 등)은
 * 다시 시도하면 계정이 잠길 수 있어 제외하고, 네트워크 오류·시간 초과·서버 오류와 app_id 거절만 다시 시도합니다.
 * 컴퓨터가 잠들었다 깨어난 직후처럼 네트워크가 아직 붙지 않았을 때가 대표적입니다.
 */
export function isTransientLoginFailure(error: unknown): boolean {
    return !(error instanceof ApiError) || isAppIdFailure(error);
}

/** 등록된 계정의 로그인 상태와 세션을 관리합니다. */
export class AccountManager {
    /** 로그인 만료로 계정마다 마지막으로 다시 로그인을 시도한 시각입니다. */
    private readonly lastRecovery = new Map<string, number>();
    /** 일시적인 오류로 로그인하지 못해 자동으로 다시 시도할 계정입니다. `maintain`이 때가 되면 로그인합니다. */
    private readonly retries = new Map<string, {account: AccountConfig; at: number; delayMs: number; since: number}>();
    private readonly sessions = new Map<string, LoggedIn>();
    private readonly statuses = new Map<string, AccountStatus>();
    /** OTP를 요구받은 클라이언트입니다. OTP는 요구받은 클라이언트(같은 기기 정보)로 보내야 합니다. */
    private readonly awaitingOtp = new Map<string, DCInside>();
    /** 삭제된 계정입니다. 재로그인 도중 삭제되면 로그인 결과를 버립니다. */
    private readonly removed = new Set<string>();
    /** 로그인을 내려놓을 때마다 늘어납니다. 그 전에 시작한 로그인의 결과는 버립니다. */
    private readonly generations = new Map<string, number>();
    /** 마지막 app_id 거절의 이유입니다. 쉬는 동안 막을 때 같은 이유로 알립니다(앱 버전 거절과 일시적 거절 구분). */
    private refusal = APP_ID_REFUSED_MESSAGE;
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
        // 로그인하는 사이 계정이 삭제됐거나 로그인을 내려놓았으면(아이디 변경) 결과를 버립니다. 비밀 정보도 다시 저장하지 않습니다.
        const generation = this.generations.get(account.id) ?? 0;
        const dropped = () => this.removed.has(account.id) || (this.generations.get(account.id) ?? 0) !== generation;
        const deviceKey = `device:${account.id}` as const;
        const otpKey = `otp:${account.id}` as const;
        const otpToken = otp ? undefined : this.secrets.get(otpKey) ?? undefined;
        const client = (otp && this.awaitingOtp.get(account.id))
            || this.createClient(freshDevice ? undefined : loadDevice(this.secrets, deviceKey));
        this.awaitingOtp.delete(account.id);
        try {
            const session = await client.login(account.loginId, password, otp ? {otp} : {otpToken});
            if (dropped()) return {state: "logged_out"};
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
            // 이미 app_id 거절로 쉬는 중이면(계정 여럿을 이어서 로그인할 때 등) 발급을 또 시도하지 않습니다.
            // 기기 정보를 새로 받는 로그인은 그 자체가 오래 이어진 거절을 풀려는 시도라 예외입니다.
            if (freshDevice || this.appId.canTry()) {
                if (await this.loadDccons(loggedIn) === "login_expired") {
                    if (dropped()) return {state: "logged_out"};
                    return this.setStatus(account.id, {state: "error", message: "로그인 직후 세션이 끊겼습니다. 잠시 뒤 다시 로그인하세요."});
                }
            } else {
                loggedIn.dcconError = this.refusal;
            }
            if (dropped()) return {state: "logged_out"};
            // app_id를 받은 뒤에 저장해야 앱을 다시 켰을 때 app_id를 또 발급받지 않습니다.
            await saveDevice(this.secrets, deviceKey, client);
            this.sessions.set(account.id, loggedIn);
            this.retries.delete(account.id);
            return this.setStatus(account.id, this.loggedInStatus(account, loggedIn));
        } catch (error) {
            if (dropped()) return {state: "logged_out"};
            this.sessions.delete(account.id);
            if (error instanceof OtpRequiredError) {
                // OTP를 직접 넣어야 하므로 자동 재로그인을 그만둡니다(계속 시도하면 확인할 때마다 비밀번호 로그인이 나갑니다).
                this.retries.delete(account.id);
                this.awaitingOtp.set(account.id, client);
                await saveDevice(this.secrets, deviceKey, client);
                // 저장된 토큰으로 실패했다면 만료된 것이므로 지웁니다.
                if (otpToken) await this.secrets.set(otpKey, "");
                return this.setStatus(account.id, {
                    state: "otp_required",
                    message: otp ? `OTP 인증 실패: ${error.message}` : "OTP 번호를 입력하세요."
                });
            }
            if (isTransientLoginFailure(error)) return this.scheduleRetry(account, error);
            this.retries.delete(account.id);
            const message = error instanceof CaptchaRequiredError
                ? "로그인에 캡차 입력이 필요합니다. 디시 앱이나 웹에서 한 번 로그인한 뒤 다시 시도하세요."
                : `로그인 실패: ${errorMessage(error)}`;
            return this.setStatus(account.id, {state: "error", message});
        }
    }

    /** 일시적인 오류로 로그인하지 못한 계정을 1분, 2분, 4분…(최대 30분) 뒤에 자동으로 다시 로그인하도록 잡아 둡니다. */
    private scheduleRetry(account: AccountConfig, error: unknown): AccountStatus {
        if (isAppIdFailure(error)) this.refuseAppId(error);
        const previous = this.retries.get(account.id);
        const delayMs = previous ? Math.min(previous.delayMs * 2, LOGIN_RETRY_MAX_MS) : LOGIN_RETRY_FIRST_MS;
        const since = previous?.since ?? this.now();
        const at = this.now() + delayMs;
        this.retries.set(account.id, {account, at, delayMs, since});
        const minutes = Math.max(1, Math.round(delayMs / 60000));
        return this.setStatus(account.id, {
            state: "error",
            message: `일시적인 오류로 로그인하지 못했습니다. ${minutes}분 뒤 자동으로 다시 로그인합니다. (${errorMessage(error)})`,
            retryAt: at,
            failingSince: since
        });
    }

    /** 이 계정의 로그인 세션과 자동 재로그인 예정을 버립니다. 그 전에 시작한 로그인의 결과도 버려집니다. */
    private forget(accountId: string): void {
        this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
        this.pendingLogins.delete(accountId);
        this.sessions.delete(accountId);
        this.awaitingOtp.delete(accountId);
        this.retries.delete(accountId);
    }

    /** 로그인 세션을 버립니다(설정에서 아이디를 바꾼 경우). 다시 로그인해야 그 아이디로 쓰입니다. */
    logout(accountId: string): void {
        this.forget(accountId);
        this.setStatus(accountId, {state: "logged_out"});
    }

    /** 일시적인 오류로 자동 재로그인을 기다리는 계정인지입니다. */
    isRetrying(accountId: string): boolean {
        return this.retries.has(accountId);
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

    /** app_id 거절을 기록하고 쉽니다. 기기 정보를 새로 받아야 할 만큼 오래 이어졌으면 true입니다. */
    private refuseAppId(error: unknown): boolean {
        const outdated = isOutdatedAppError(error);
        this.refusal = outdated ? OUTDATED_APP_MESSAGE : APP_ID_REFUSED_MESSAGE;
        return this.appId.fail(outdated ? OUTDATED_PAUSE_MS : undefined);
    }

    /** 보유 디시콘을 불러옵니다. 로그인이 풀려 자동 재로그인까지 실패했으면 "login_expired"를 돌려줍니다. */
    private async loadDccons(loggedIn: LoggedIn): Promise<"ok" | "failed" | "login_expired"> {
        try {
            const response = await loggedIn.client.dccons.list();
            const tabs = response.tab ?? [];
            loggedIn.dccons = (response.list ?? []).flatMap((list, index) => list.flatMap((item) =>
                item.package_idx !== undefined && item.detail_idx !== undefined
                    ? [{
                        packageIdx: item.package_idx,
                        detailIdx: item.detail_idx,
                        title: item.title ?? "",
                        packageTitle: tabs[index]?.title ?? "",
                        ...(item.img ? {img: item.img} : {})
                    }]
                    : []));
            loggedIn.dcconError = undefined;
            loggedIn.dcconRetryAt = undefined;
            this.appId.succeed();
            return "ok";
        } catch (error) {
            if (isLoginExpired(error)) return "login_expired";
            if (isAppIdFailure(error)) {
                this.refuseAppId(error);
                loggedIn.dcconError = this.refusal;
            } else {
                loggedIn.dcconError = describe(error);
                loggedIn.dcconRetryAt = this.now() + DCCON_RETRY_MS;
            }
            return "failed";
        }
    }

    /**
     * 보유 디시콘을 못 불러온 계정은 잠시 쉰 뒤 다시 불러옵니다. 감시 중에 주기적으로 부릅니다.
     * 상태가 바뀐 계정이 있으면 true를 돌려줍니다.
     */
    async maintain(accounts: AccountConfig[]): Promise<boolean> {
        let changed = false;
        // 일시적인 오류로 로그인하지 못한 계정은 때가 되면 다시 로그인합니다(잠자기에서 깨어난 직후 네트워크가 없었을 때 등).
        for (const [id, retry] of [...this.retries]) {
            if (this.now() < retry.at || this.sessions.has(id) || !this.appId.canTry()) continue;
            const account = accounts.find((item) => item.id === id);
            if (!account) {
                this.retries.delete(id);
                continue;
            }
            await this.login(account);
            changed = true;
        }
        for (const [id, loggedIn] of this.sessions) {
            if (!loggedIn.dcconError || !this.appId.canTry()) continue;
            if (loggedIn.dcconRetryAt !== undefined && this.now() < loggedIn.dcconRetryAt) continue;
            if (await this.loadDccons(loggedIn) === "login_expired") {
                // 확인할 때마다 로그인을 다시 시도하지 않도록, OTP 토큰으로도 살릴 수 없으면 세션을 내려놓습니다.
                await this.recoverLogin(id, "보유 디시콘을 불러오다 로그인이 풀림");
            } else {
                const account = accounts.find((item) => item.id === id) ?? loggedIn.account;
                this.setStatus(id, this.loggedInStatus(account, loggedIn));
            }
            changed = true;
        }
        return changed;
    }

    private memberType(account: AccountConfig, loggedIn: LoggedIn): MemberType | null {
        return account.memberTypeOverride === "auto" ? loggedIn.detectedMemberType : account.memberTypeOverride;
    }

    /**
     * 글을 읽을 때 쓸 로그인된 계정의 클라이언트입니다. `accountIds`(갤러리의 대기 계정) 가운데 우선순위 순서로
     * 처음 로그인된 계정을 씁니다. 다른 갤러리용 계정으로 대신 읽지 않습니다. 로그인된 계정이 없으면 null입니다.
     */
    readingClient(accounts: AccountConfig[], accountIds: string[]): {accountId: string; client: DCInside} | null {
        for (const id of accountIds) {
            const loggedIn = this.sessions.get(id);
            if (loggedIn && accounts.some((account) => account.id === id)) return {accountId: id, client: loggedIn.client};
        }
        return null;
    }

    /** 이 클라이언트를 쓰는 로그인된 계정의 ID입니다. */
    accountOf(client: DCInside): string | null {
        for (const [id, loggedIn] of this.sessions) if (loggedIn.client === client) return id;
        return null;
    }

    /**
     * 라이브러리의 자동 재로그인까지 실패한 계정을 처리합니다. 로그인 세션은 반나절쯤 지나면 만료되는데, 라이브러리는 같은
     * 클라이언트로 다시 로그인만 하고(OTP 토큰도 넘기지 못함) 그것만으로는 풀리지 않을 때가 있습니다. 그래서 로그인 버튼과
     * 같은 전체 로그인(새 클라이언트, app_id 새로 받기)을 한 번 해 봅니다. 비밀번호가 바뀐 경우처럼 계속 실패할 때 확인할 때마다
     * 로그인을 시도해 계정이 잠기지 않도록, 계정마다 30분에 한 번까지만 합니다. 살리지 못하면 세션을 버려 글 읽기는 다음 계정으로
     * 넘깁니다. 다시 로그인했으면 true, 세션을 버렸으면 false입니다.
     */
    async recoverLogin(accountId: string, reason: string): Promise<boolean> {
        // 다른 갤러리가 이미 이 계정으로 다시 로그인하는 중이면(같은 계정으로 읽는 갤러리 여럿이 함께 만료를 받은 경우) 그 결과를 따릅니다.
        const pending = this.pendingLogins.get(accountId);
        if (pending) return (await pending).state === "logged_in";
        const loggedIn = this.sessions.get(accountId);
        if (!loggedIn) return false;
        const last = this.lastRecovery.get(accountId);
        if (last === undefined || this.now() - last >= LOGIN_RECOVERY_GAP_MS) {
            this.lastRecovery.set(accountId, this.now());
            const status = await this.login(loggedIn.account);
            if (status.state === "logged_in") return true;
            // 로그인하는 사이 계정을 지웠거나 로그인을 내려놓았으면(아이디 변경) 그대로 둡니다.
            if (status.state === "logged_out") return false;
            // OTP를 다시 입력해야 하거나, 일시적인 오류라 자동으로 다시 로그인할 예정이면 그 안내를 그대로 둡니다.
            if (status.state === "otp_required" || this.retries.has(accountId)) return false;
        }
        this.sessions.delete(accountId);
        this.setStatus(accountId, {state: "error", message: `로그인이 풀렸습니다. 계정 탭에서 다시 로그인하세요. (${reason})`});
        return false;
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
            // 기본 디시콘은 지금 가진 것만 씁니다(설정한 뒤 디시콘을 지웠거나 기간이 끝났을 수 있습니다).
            const defaults = (account.defaultDccons ?? []).flatMap((ref) =>
                loggedIn.dccons.filter((dccon) => dccon.packageIdx === ref.packageIdx && dccon.detailIdx === ref.detailIdx).slice(0, 1));
            return [{id, memberType: this.memberType(account, loggedIn), dccons: loggedIn.dccons, defaultDccons: defaults}];
        });
    }

    /**
     * 댓글을 답니다.
     * - app_id 발급이 거절된 상태면 발급 요청을 늘리지 않도록 바로 실패로 처리하고, 거절이 오래 이어졌을 때만
     *   기기 정보를 새로 받아 다시 로그인한 뒤 한 번 더 시도합니다.
     * - 로그인이 풀려 라이브러리의 자동 재로그인까지 실패했으면 `recoverLogin`으로 처리하고, 살렸을 때만 한 번 더 시도합니다.
     *
     * 댓글이 달리지 않은 것이 확실한 실패는 `isDefiniteCommentFailure`가 true인 오류로 던집니다.
     */
    async writeComment(accountId: string, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        const loggedIn = this.sessions.get(accountId);
        if (!loggedIn) throw new CommentNotPostedError("로그인되지 않은 계정입니다.");
        // 받아 둔 app_id가 아직 유효하면 대기 중이어도 씁니다(발급 요청이 나가지 않습니다).
        // 유효 기간은 라이브러리가 app_id를 발급받은 시각부터 셉니다.
        const issuedAt = loggedIn.client.auth.exportCredentials()?.appIdIssuedAt;
        const hasFreshAppId = typeof issuedAt === "number" && Date.now() - issuedAt < APP_ID_FRESH_MS;
        if (!hasFreshAppId && !this.appId.canTry()) throw new CommentNotPostedError(this.refusal);
        try {
            await this.write(loggedIn.client, galleryId, postNo, content);
            this.appId.succeed();
            return;
        } catch (error) {
            let renewed: LoggedIn | undefined;
            if (isAppIdFailure(error)) {
                const needsFreshDevice = this.refuseAppId(error);
                // 앱 버전이 낮아 거절된 것이면 기기 정보를 새로 받아도 풀리지 않습니다.
                if (isOutdatedAppError(error)) throw new CommentNotPostedError(OUTDATED_APP_MESSAGE);
                if (!needsFreshDevice) throw new CommentNotPostedError(APP_ID_REFUSED_MESSAGE);
                const status = await this.login(loggedIn.account, undefined, true);
                renewed = this.sessions.get(accountId);
                if (status.state !== "logged_in" || !renewed) {
                    throw new CommentNotPostedError(`앱 인증(app_id) 거절이 계속되어 다시 로그인했지만 실패했습니다: ${"message" in status ? status.message : status.state}`);
                }
                // 다시 로그인하며 받은 app_id도 거절됐으면 또 발급하지 않습니다.
                if (renewed.dcconError && !this.appId.canTry()) throw new CommentNotPostedError(this.refusal);
            } else if (isLoginExpired(error)) {
                if (!await this.recoverLogin(accountId, "댓글을 달다 로그인이 풀림")) {
                    throw new CommentNotPostedError("로그인이 풀려 댓글을 달지 못했습니다. 계정 탭에서 다시 로그인하세요.");
                }
                renewed = this.sessions.get(accountId);
                if (!renewed) throw new CommentNotPostedError("다시 로그인했지만 세션을 찾지 못했습니다.");
            } else {
                throw error;
            }
            await this.write(renewed.client, galleryId, postNo, content);
        }
    }

    /**
     * 댓글 요청을 보내기 전 단계(앱 인증, 디시콘 준비)는 먼저 마치고, 여기서 난 오류는 댓글이 달리지 않은 것이 확실하므로
     * `CommentNotPostedError`로 바꿉니다. 앱 인증 거절과 로그인 만료는 위에서 따로 처리하도록 그대로 던집니다.
     */
    private async write(client: DCInside, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        let message: string | {dccons: {tag: string; detailIdx: number}[]};
        try {
            await client.auth.appId();
            if (content.type === "text") {
                message = content.text;
            } else {
                const inserted = await client.dccons.insert({package_idx: content.dccon.packageIdx, detail_idx: content.dccon.detailIdx});
                if (!inserted.img_tag) throw new CommentNotPostedError("디시콘 태그를 받지 못했습니다.");
                message = {dccons: [{tag: inserted.img_tag, detailIdx: content.dccon.detailIdx}]};
            }
        } catch (error) {
            if (isAppIdFailure(error) || isLoginExpired(error) || error instanceof CommentNotPostedError) throw error;
            throw new CommentNotPostedError(`댓글을 보내기 전에 실패했습니다: ${errorMessage(error)}`);
        }
        await client.comments.write(galleryId, postNo, message);
    }

    /** 로그인된 계정이 가진 디시콘입니다. 로그인할 때 불러 둔 목록이라 디시에 요청하지 않습니다. */
    ownedDccons(accountId: string): OwnedDccon[] {
        return this.sessions.get(accountId)?.dccons ?? [];
    }

    nickname(accountId: string): string {
        return this.sessions.get(accountId)?.nickname ?? accountId;
    }

    async remove(accountId: string): Promise<void> {
        this.removed.add(accountId);
        this.forget(accountId);
        this.statuses.delete(accountId);
        // 앞부분이 같은 다른 키까지 지우지 않도록 정확한 키만 지웁니다.
        await this.secrets.set(`account:${accountId}`, "");
        await this.secrets.set(`device:${accountId}`, "");
        await this.secrets.set(`otp:${accountId}`, "");
    }
}
