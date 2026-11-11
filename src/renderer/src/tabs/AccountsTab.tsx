import {useRef, useState} from "react";
import type {AccountConfig, AccountStatus, AccountView} from "@shared/types";
import type {SettingsTabProps} from "../App";
import {isCommitEnter} from "../components/keys";
import {DefaultDccons} from "../components/DefaultDccons";
import {RoleBadge} from "../components/RoleBadge";
import {SecretField} from "../components/SecretField";
import {useConfirm} from "../components/ConfirmDialog";
import {applyAccountChange, draftAfterAccountChange, type AccountChange} from "../components/account-change";

type Props = SettingsTabProps;

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
    const [confirm, confirmDialog] = useConfirm();
    // 계정 추가·삭제 저장이 끝나기 전에 또 누르면, 앞 변경이 빠진 설정으로 덮어써 방금 추가한 계정이 지워집니다. 하나씩 처리합니다.
    const changing = useRef(false);
    const [busy, setBusy] = useState(false);

    function update(id: string, patch: Partial<AccountConfig>) {
        setDraft((prev) => ({...prev, accounts: prev.accounts.map((account) => account.id === id ? {...account, ...patch} : account)}));
    }

    // 비밀번호와 로그인은 저장된 계정에만 쓸 수 있으므로, 계정 추가와 삭제는 바로 저장합니다. 이때 마지막으로 저장된 설정에
    // 이 변경만 더해 저장하고, 초안에도 같은 변경만 적용합니다. 다른 탭에서 고치던 내용은 함께 저장되지도, 사라지지도 않습니다.
    async function saveAccountChange(change: AccountChange) {
        if (changing.current) return;
        changing.current = true;
        setBusy(true);
        try {
            await run(() => window.hamboogie.saveSettings(applyAccountChange(state.settings, change)),
                (prev, saved) => draftAfterAccountChange(prev, saved, change));
        } finally {
            changing.current = false;
            setBusy(false);
        }
    }

    function addAccount() {
        void saveAccountChange({kind: "add", account: {id: crypto.randomUUID(), loginId: "", memberTypeOverride: "auto", defaultDccons: []}});
    }

    async function removeAccount(account: AccountConfig) {
        if (changing.current) return;
        const confirmed = await confirm({
            title: "이 계정을 삭제할까요?",
            message: <p>{account.loginId ? `${account.loginId} 계정과 ` : ""}저장된 비밀번호를 함께 지웁니다. 갤러리의 대기 계정에서도 빠집니다.</p>,
            confirmLabel: "삭제",
            danger: true
        });
        if (confirmed) void saveAccountChange({kind: "remove", id: account.id});
    }

    return (
        <div className="stack">
            <p className="muted">비밀번호와 OTP 토큰은 이 컴퓨터의 OS 보안 저장소로 암호화해 보관하며, 화면에 다시 표시하지 않습니다. 비밀번호가 저장된 계정은 앱을 켤 때 자동으로 로그인합니다.</p>
            {draft.accounts.map((account) => {
                const view = state.accounts.find((item) => item.id === account.id);
                return view && (
                    <AccountCard key={account.id} account={account} view={view} onChange={(patch) => update(account.id, patch)}
                                 run={run} onRemove={() => void removeAccount(account)} removing={busy}
                                 saved={JSON.stringify(state.settings.accounts.find((item) => item.id === account.id)) === JSON.stringify(account)}/>
                );
            })}
            <button className="button add" onClick={addAccount} disabled={busy}>+ 계정 추가</button>
            {confirmDialog}
        </div>
    );
}

function AccountCard({account, view, onChange, run, onRemove, removing, saved}: {
    account: AccountConfig;
    view: AccountView;
    onChange(patch: Partial<AccountConfig>): void;
    run: Props["run"];
    onRemove(): void;
    /** 계정 추가·삭제를 저장하는 중이라 지금은 삭제할 수 없는지입니다. */
    removing: boolean;
    saved: boolean;
}) {
    const [otp, setOtp] = useState("");
    const status = view.status;
    const otpValid = /^\d{6}$/.test(otp);

    function submitOtp() {
        if (!otpValid) return;
        void run(() => window.hamboogie.login(account.id, otp), true).then((ok) => ok && setOtp(""));
    }

    return (
        <section className="card">
            <div className="grid">
                <label className="field">
                    <span>디시 아이디</span>
                    <input value={account.loginId} autoComplete="off" onChange={(event) => onChange({loginId: event.target.value})}/>
                </label>
                <SecretField label="비밀번호" saved={view.hasPassword} autoComplete="new-password"
                             onSave={(password) => run(() => window.hamboogie.setSecret(`account:${account.id}`, password), true)}/>
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
            {status.state === "logged_in" && status.dcconCount > 0 && (
                <DefaultDccons accountId={account.id} selected={account.defaultDccons} onChange={(defaultDccons) => onChange({defaultDccons})}/>
            )}
            <div className="row">
                <span className={status.state === "error" || status.state === "otp_required" ? "error-text" : status.state === "logged_in" ? "ok-text" : "muted"}>
                    {statusText(status)}
                </span>
                {status.state === "otp_required" && (
                    <>
                        <input className="otp-input" aria-label="OTP 6자리" value={otp} inputMode="numeric" maxLength={6} placeholder="OTP 6자리" autoFocus
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
                <button className="button danger small" onClick={onRemove} disabled={removing}>삭제</button>
            </div>
            {status.state === "logged_in" && (
                <div className="managed-galleries">
                    <span className="muted">매니저·부매니저인 갤러리</span>
                    {!status.managedGalleries ? <span className="muted">{status.managedError}</span>
                        : status.managedGalleries.length === 0 ? <span className="muted">없음</span>
                        : (
                            <ul>
                                {status.managedGalleries.map((gallery) => (
                                    <li key={gallery.galleryId}><RoleBadge role={gallery.role}/> {gallery.name} <span className="muted">({gallery.galleryId})</span></li>
                                ))}
                            </ul>
                        )}
                </div>
            )}
        </section>
    );
}
