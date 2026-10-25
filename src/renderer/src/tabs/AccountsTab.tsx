import {useState} from "react";
import type {AccountConfig, AccountStatus, AccountView, AppState, Settings} from "@shared/types";
import type {DraftSetter} from "../App";
import {isCommitEnter} from "../components/keys";

interface Props {
    draft: Settings;
    setDraft: DraftSetter;
    state: AppState;
    run(action: () => Promise<AppState>, keepDraft?: boolean): Promise<void>;
}

function statusText(status: AccountStatus): string {
    switch (status.state) {
        case "logged_out":
            return "로그인 안 됨";
        case "logging_in":
            return "로그인 중…";
        case "logged_in": {
            const type = status.memberType === "gonick" ? "고닉" : status.memberType === "semi" ? "반고닉" : "종류 알 수 없음";
            const dccon = status.dcconError ? "디시콘 불러오기 실패" : `디시콘 ${status.dcconCount}개`;
            return `로그인됨 · ${status.nickname} · ${type} · ${dccon}`;
        }
        case "otp_required":
        case "error":
            return status.message;
    }
}

export function AccountsTab({draft, setDraft, state, run}: Props) {
    function update(id: string, patch: Partial<AccountConfig>) {
        setDraft({...draft, accounts: draft.accounts.map((account) => account.id === id ? {...account, ...patch} : account)});
    }

    // 비밀번호와 로그인은 저장된 계정에만 쓸 수 있으므로, 계정 추가와 삭제는 다른 변경 사항과 함께 바로 저장합니다.
    function addAccount() {
        const account: AccountConfig = {id: crypto.randomUUID(), loginId: "", memberTypeOverride: "auto"};
        void run(() => window.hamboogie.saveSettings({...draft, accounts: [...draft.accounts, account]}));
    }

    function removeAccount(id: string) {
        if (!confirm("이 계정을 삭제할까요? 저장된 비밀번호도 함께 지워집니다.")) return;
        void run(() => window.hamboogie.saveSettings({
            ...draft,
            accounts: draft.accounts.filter((account) => account.id !== id),
            galleries: draft.galleries.map((gallery) => ({...gallery, accountIds: gallery.accountIds.filter((item) => item !== id)}))
        }));
    }

    return (
        <div className="stack">
            <p className="muted">비밀번호와 OTP 토큰은 이 컴퓨터의 OS 보안 저장소로 암호화해 보관하며, 화면에 다시 표시하지 않습니다. 비밀번호가 저장된 계정은 앱을 켤 때 자동으로 로그인합니다.</p>
            {draft.accounts.map((account) => {
                const view = state.accounts.find((item) => item.id === account.id);
                return view && (
                    <AccountCard key={account.id} account={account} view={view} onChange={(patch) => update(account.id, patch)}
                                 run={run} onRemove={() => removeAccount(account.id)}
                                 saved={JSON.stringify(state.settings.accounts.find((item) => item.id === account.id)) === JSON.stringify(account)}/>
                );
            })}
            <button className="button add" onClick={addAccount}>+ 계정 추가</button>
        </div>
    );
}

function AccountCard({account, view, onChange, run, onRemove, saved}: {
    account: AccountConfig;
    view: AccountView;
    onChange(patch: Partial<AccountConfig>): void;
    run: Props["run"];
    onRemove(): void;
    saved: boolean;
}) {
    const [password, setPassword] = useState("");
    const [otp, setOtp] = useState("");
    const status = view.status;
    const otpValid = /^\d{6}$/.test(otp);

    function submitOtp() {
        if (!otpValid) return;
        void run(() => window.hamboogie.login(account.id, otp), true).then(() => setOtp(""));
    }

    return (
        <section className="card">
            <div className="grid">
                <label className="field">
                    <span>디시 아이디</span>
                    <input value={account.loginId} autoComplete="off" onChange={(event) => onChange({loginId: event.target.value})}/>
                </label>
                <label className="field">
                    <span>비밀번호 {view.hasPassword && <em className="ok-text">(저장됨)</em>}</span>
                    <div className="row">
                        <input type="password" value={password} autoComplete="new-password" placeholder={view.hasPassword ? "바꾸려면 새로 입력" : ""}
                               onChange={(event) => setPassword(event.target.value)}/>
                        <button className="button small" disabled={!password}
                                onClick={() => run(() => window.hamboogie.setSecret(`account:${account.id}`, password), true).then(() => setPassword(""))}>
                            저장
                        </button>
                    </div>
                </label>
                <label className="field">
                    <span>계정 종류</span>
                    <select value={account.memberTypeOverride}
                            onChange={(event) => onChange({memberTypeOverride: event.target.value as AccountConfig["memberTypeOverride"]})}>
                        <option value="auto">자동 판별</option>
                        <option value="gonick">고정닉</option>
                        <option value="semi">반고정닉</option>
                    </select>
                    <small className="muted">자동 판별이 틀리면 직접 지정하세요. "고닉만" 같은 줄 조건에 쓰입니다.</small>
                </label>
            </div>
            <div className="row">
                <span className={status.state === "error" || status.state === "otp_required" ? "error-text" : status.state === "logged_in" ? "ok-text" : "muted"}>
                    {statusText(status)}
                </span>
                {status.state === "otp_required" && (
                    <>
                        <input className="otp-input" value={otp} inputMode="numeric" maxLength={6} placeholder="OTP 6자리" autoFocus
                               onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                               onKeyDown={(event) => isCommitEnter(event) && submitOtp()}/>
                        <button className="button primary small" disabled={!otpValid} onClick={submitOtp}>OTP 확인</button>
                    </>
                )}
                <button className="button small push-right" disabled={!saved || !account.loginId || !view.hasPassword || status.state === "logging_in"}
                        title={!saved ? "설정을 먼저 저장하세요" : undefined}
                        onClick={() => run(() => window.hamboogie.login(account.id), true)}>
                    {status.state === "logged_in" ? "다시 로그인" : "로그인"}
                </button>
                <button className="button danger small" onClick={onRemove}>삭제</button>
            </div>
        </section>
    );
}
