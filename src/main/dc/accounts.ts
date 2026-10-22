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

async function loadDevice(secrets: Pick<SecretStore, "get">, key: `device:${string}`): Promise<DeviceCredentials | undefined> {
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

/** 글 읽기 전용 클라이언트를 만듭니다. 로그인하지 않으며 디바이스 인증 정보만 재사용합니다. */
export async function createReader(secrets: SecretStore): Promise<DCInside> {
    return new DCInside({credentials: await loadDevice(secrets, "device:reader")});
}

/** 인증 정보 발급은 첫 요청 때 일어나므로, 첫 요청이 성공한 뒤에 호출합니다. */
export async function persistReader(secrets: SecretStore, client: DCInside): Promise<void> {
    await saveDevice(secrets, "device:reader", client);
}

/** 등록된 계정의 로그인 상태와 세션을 관리합니다. */
export class AccountManager {
    private readonly sessions = new Map<string, LoggedIn>();
    private readonly statuses = new Map<string, AccountStatus>();

    constructor(
        private readonly secrets: Pick<SecretStore, "get" | "set" | "removeByPrefix">,
        private readonly createClient: (credentials?: DeviceCredentials) => DCInside = (credentials) => new DCInside({credentials})
    ) {}

    status(accountId: string): AccountStatus {
        return this.statuses.get(accountId) ?? {state: "logged_out"};
    }

    /**
     * 로그인합니다. 저장된 OTP 토큰이 있으면 OTP 없이 통과하고, 없거나 만료됐으면 `otp_required` 상태가 됩니다.
     *
     * @param otp 사용자가 입력한 OTP 6자리입니다.
     */
    async login(account: AccountConfig, otp?: string): Promise<AccountStatus> {
        const password = this.secrets.get(`account:${account.id}`);
        if (!account.loginId || !password) return this.setStatus(account.id, {state: "error", message: "아이디와 비밀번호를 먼저 입력하세요."});

        this.statuses.set(account.id, {state: "logging_in"});
        const deviceKey = `device:${account.id}` as const;
        const otpKey = `otp:${account.id}` as const;
        const otpToken = otp ? undefined : this.secrets.get(otpKey) ?? undefined;
        const client = this.createClient(await loadDevice(this.secrets, deviceKey));
        try {
            const session = await client.login(account.loginId, password, otp ? {otp} : {otpToken});
            await saveDevice(this.secrets, deviceKey, client);
            // OTP로 로그인하면 다음부터 OTP 없이 통과할 수 있는 토큰을 줍니다.
            if (session.result.otp_token) await this.secrets.set(otpKey, session.result.otp_token);
            const isGonick = session.result.is_gonick;
            const loggedIn: LoggedIn = {
                account,
                client,
                nickname: session.result.name ?? account.loginId,
                detectedMemberType: isGonick === 1 ? "gonick" : isGonick === 0 ? "semi" : null,
                dccons: await this.loadDccons(client)
            };
            this.sessions.set(account.id, loggedIn);
            return this.setStatus(account.id, {
                state: "logged_in",
                nickname: loggedIn.nickname,
                memberType: this.memberType(account, loggedIn),
                dcconCount: loggedIn.dccons.length
            });
        } catch (error) {
            this.sessions.delete(account.id);
            if (error instanceof OtpRequiredError) {
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

    private async loadDccons(client: DCInside): Promise<OwnedDccon[]> {
        try {
            const response = await client.dccons.list();
            const tabs = response.tab ?? [];
            return (response.list ?? []).flatMap((items, index) => items.flatMap((item) =>
                item.package_idx !== undefined && item.detail_idx !== undefined
                    ? [{
                        packageIdx: item.package_idx,
                        detailIdx: item.detail_idx,
                        title: item.title ?? "",
                        packageTitle: tabs[index]?.title ?? ""
                    }]
                    : []));
        } catch {
            return [];
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

    /** 댓글을 답니다. 로그인 세션이 만료됐으면 저장된 정보로 다시 로그인한 뒤 한 번 더 시도합니다. */
    async writeComment(accountId: string, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        const loggedIn = this.sessions.get(accountId);
        if (!loggedIn) throw new Error("로그인되지 않은 계정입니다.");
        try {
            await this.write(loggedIn.client, galleryId, postNo, content);
        } catch (error) {
            if (!(error instanceof AuthExpiredError)) throw error;
            const status = await this.login(loggedIn.account);
            const renewed = this.sessions.get(accountId);
            if (status.state !== "logged_in" || !renewed) {
                throw new Error(`세션이 만료되어 다시 로그인했지만 실패했습니다: ${"message" in status ? status.message : status.state}`);
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
        this.statuses.delete(accountId);
        await this.secrets.removeByPrefix(`account:${accountId}`);
        await this.secrets.removeByPrefix(`device:${accountId}`);
        await this.secrets.removeByPrefix(`otp:${accountId}`);
    }
}
