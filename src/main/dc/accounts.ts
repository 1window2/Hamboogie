import {DCInside, OtpRequiredError, CaptchaRequiredError, type DeviceCredentials} from "@green-1052/dcinside.js";
import type {AccountConfig, AccountStatus, MemberType} from "@shared/types";
import type {SecretStore} from "../store";
import type {CandidateAccount, CommentContent, OwnedDccon} from "../pipeline/planner";

interface LoggedIn {
    client: DCInside;
    nickname: string;
    /** 로그인 응답으로 판별한 계정 종류입니다. 알 수 없으면 null입니다. */
    detectedMemberType: MemberType | null;
    dccons: OwnedDccon[];
}

async function loadDevice(secrets: SecretStore, key: `device:${string}`): Promise<DeviceCredentials | undefined> {
    const saved = secrets.get(key);
    if (!saved) return undefined;
    try {
        return JSON.parse(saved) as DeviceCredentials;
    } catch {
        return undefined;
    }
}

async function saveDevice(secrets: SecretStore, key: `device:${string}`, client: DCInside): Promise<void> {
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

    constructor(private readonly secrets: SecretStore) {}

    status(accountId: string): AccountStatus {
        return this.statuses.get(accountId) ?? {state: "logged_out"};
    }

    async login(account: AccountConfig): Promise<AccountStatus> {
        const password = this.secrets.get(`account:${account.id}`);
        if (!account.loginId || !password) {
            const status: AccountStatus = {state: "error", message: "아이디와 비밀번호를 먼저 입력하세요."};
            this.statuses.set(account.id, status);
            return status;
        }
        this.statuses.set(account.id, {state: "logging_in"});
        const deviceKey = `device:${account.id}` as const;
        const client = new DCInside({credentials: await loadDevice(this.secrets, deviceKey)});
        try {
            const session = await client.login(account.loginId, password);
            await saveDevice(this.secrets, deviceKey, client);
            const isGonick = session.result.is_gonick;
            const loggedIn: LoggedIn = {
                client,
                nickname: session.result.name ?? account.loginId,
                detectedMemberType: isGonick === 1 ? "gonick" : isGonick === 0 ? "semi" : null,
                dccons: await this.loadDccons(client)
            };
            this.sessions.set(account.id, loggedIn);
            const status: AccountStatus = {
                state: "logged_in",
                nickname: loggedIn.nickname,
                memberType: this.memberType(account, loggedIn),
                dcconCount: loggedIn.dccons.length
            };
            this.statuses.set(account.id, status);
            return status;
        } catch (error) {
            this.sessions.delete(account.id);
            const message = error instanceof OtpRequiredError
                ? "OTP 인증이 필요한 계정입니다. (OTP 입력은 아직 지원하지 않습니다)"
                : error instanceof CaptchaRequiredError
                    ? "로그인에 캡차 입력이 필요합니다. 디시 앱이나 웹에서 한 번 로그인한 뒤 다시 시도하세요."
                    : `로그인 실패: ${error instanceof Error ? error.message : String(error)}`;
            const status: AccountStatus = {state: "error", message};
            this.statuses.set(account.id, status);
            return status;
        }
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

    async writeComment(accountId: string, galleryId: string, postNo: number, content: CommentContent): Promise<void> {
        const loggedIn = this.sessions.get(accountId);
        if (!loggedIn) throw new Error("로그인되지 않은 계정입니다.");
        const {client} = loggedIn;
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
    }
}
