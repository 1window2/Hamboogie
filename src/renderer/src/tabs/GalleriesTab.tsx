import {useEffect, useState} from "react";
import {BODY_READ_LIMIT_SAFE, estimatedWatchHours, FREE_DAILY_LLM_REQUESTS, INTERVAL_MAX_SEC, INTERVAL_MIN_SEC, newGallery} from "@shared/settings";
import type {AccountView, GalleryConfig, GalleryStatus, Settings} from "@shared/types";
import type {DraftSetter} from "../App";
import {NumberInput} from "../components/NumberInput";
import {KeywordEditor} from "../components/KeywordEditor";
import {AutoStopCard} from "../components/AutoStopCard";

interface Props {
    draft: Settings;
    setDraft: DraftSetter;
    accounts: AccountView[];
    status: Record<string, GalleryStatus>;
    autoStopAt: number | null;
}

export function GalleriesTab({draft, setDraft, accounts, status, autoStopAt}: Props) {
    /** `when`이 있으면 그 시점의 최신 갤러리 설정이 조건에 맞을 때만 고칩니다. */
    function update(id: string, patch: Partial<GalleryConfig>, when?: (current: GalleryConfig) => boolean) {
        setDraft((prev) => ({
            ...prev,
            galleries: prev.galleries.map((gallery) => gallery.id === id && (!when || when(gallery)) ? {...gallery, ...patch} : gallery)
        }));
    }

    return (
        <div className="stack">
            {draft.galleries.length === 0 && <p className="muted">감시할 갤러리를 추가하세요.</p>}
            {!draft.llm.paidPlan && draft.galleries.some((gallery) => gallery.enabled) && (
                <p className="muted note">
                    무료 등급은 LLM 요청을 하루 {FREE_DAILY_LLM_REQUESTS}회까지 씁니다. 확인할 때마다 새 글을 묶어 요청 한 번으로 판단하므로,
                    지금 감시 설정(켜진 갤러리 {draft.galleries.filter((gallery) => gallery.enabled).length}개)이면 {watchTimeText(estimatedWatchHours(draft.galleries.filter((gallery) => gallery.enabled).map((gallery) => gallery.intervalSec)))}.
                    감시 간격을 늘리면 더 오래 감시합니다. 새 글이 없는 확인은 요청을 쓰지 않아 실제로는 더 깁니다.
                </p>
            )}
            {draft.galleries.map((gallery) => (
                <GalleryCard key={gallery.id} gallery={gallery} accounts={accounts} status={status[gallery.id]} onChange={(patch, when) => update(gallery.id, patch, when)}
                             onRemove={() => setDraft((prev) => ({...prev, galleries: prev.galleries.filter((item) => item.id !== gallery.id)}))}/>
            ))}
            <button className="button add" onClick={() => setDraft((prev) => ({...prev, galleries: [...prev.galleries, newGallery(crypto.randomUUID())]}))}>
                + 갤러리 추가
            </button>
            <AutoStopCard autoStop={draft.autoStop} stopAt={autoStopAt} onChange={(autoStop) => setDraft((prev) => ({...prev, autoStop}))}/>
        </div>
    );
}

function galleryUrl(gallery: GalleryConfig): string {
    const kind = gallery.isMinor ? "mgallery/" : "";
    return `https://gall.dcinside.com/${kind}board/lists/?id=${encodeURIComponent(gallery.galleryId)}`;
}

/** 하루에 감시할 수 있는 시간을 문장으로 씁니다. */
function watchTimeText(hours: number): string {
    if (hours >= 24) return "하루 종일 감시할 수 있습니다";
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    return `하루 약 ${minutes === 0 ? `${whole}시간` : `${whole}시간 ${minutes}분`} 감시할 수 있습니다`;
}

function formatClock(time: number): string {
    return new Date(time).toLocaleTimeString("ko-KR", {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
}

function GalleryCard({gallery, accounts, status, onChange, onRemove}: {
    gallery: GalleryConfig;
    accounts: AccountView[];
    status: GalleryStatus | undefined;
    onChange(patch: Partial<GalleryConfig>, when?: (current: GalleryConfig) => boolean): void;
    onRemove(): void;
}) {
    const [checking, setChecking] = useState(false);
    const [checkError, setCheckError] = useState<string | null>(null);
    const checked = Boolean(gallery.galleryId) && gallery.checkedId === gallery.galleryId;
    useEffect(() => setCheckError(null), [gallery.galleryId]);

    async function check() {
        const id = gallery.galleryId.trim();
        setChecking(true);
        setCheckError(null);
        try {
            const result = await window.hamboogie.checkGallery(id, gallery.accountIds);
            // 확인하는 사이 ID를 또 바꿨으면 이 결과는 버립니다.
            onChange({galleryId: id, checkedId: id, title: result.title, isMinor: result.isMinor}, (current) => current.galleryId.trim() === id);
        } catch (caught) {
            setCheckError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '\w+': (Error: )?/, "") : String(caught));
        } finally {
            setChecking(false);
        }
    }


    function toggleAccount(accountId: string, checked: boolean) {
        onChange({accountIds: checked ? [...gallery.accountIds, accountId] : gallery.accountIds.filter((id) => id !== accountId)});
    }

    function moveAccount(index: number, offset: -1 | 1) {
        const ids = [...gallery.accountIds];
        const target = index + offset;
        if (target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target]!, ids[index]!];
        onChange({accountIds: ids});
    }

    const accountLabel = (id: string) => {
        const account = accounts.find((item) => item.id === id);
        if (!account) return id;
        return account.status.state === "logged_in" ? `${account.status.nickname} (${account.loginId})` : account.loginId || "(아이디 없음)";
    };

    return (
        <section className="card">
            <div className="card-head">
                <label className="field inline">
                    <span>갤러리 ID</span>
                    <input value={gallery.galleryId} placeholder="예: gf2" onChange={(event) => onChange({galleryId: event.target.value})}/>
                </label>
                <button className="button small" disabled={checking || !gallery.galleryId.trim() || checked} onClick={check}>
                    {checking ? "확인 중…" : "확인"}
                </button>

                <label className="check">
                    <input type="checkbox" checked={gallery.enabled} onChange={(event) => onChange({enabled: event.target.checked})}/>
                    감시 사용
                </label>
                {gallery.galleryId && (
                    <a className="button small push-right" href={galleryUrl(gallery)} target="_blank" rel="noreferrer">갤러리 열기</a>
                )}
                <button className={gallery.galleryId ? "button danger small" : "button danger small push-right"} onClick={onRemove}>삭제</button>
            </div>
            {checked
                ? <small className="ok-text check-status">✓ {gallery.title}{gallery.isMinor ? " (마이너 갤러리)" : ""}</small>
                : checkError ? <small className="error-text check-status">{checkError}</small>
                    : gallery.galleryId.trim() && <small className="error-text check-status">갤러리 ID를 확인해야 감시할 수 있습니다.</small>}
            {status && (
                <small className="muted check-status">
                    마지막 확인 {formatClock(status.lastCheckedAt)} · 새 글 {status.newPosts}개 · 나눔 판단 {status.matched}개
                </small>
            )}

            <div className="grid">
                <IntervalField value={gallery.intervalSec} onChange={(intervalSec) => onChange({intervalSec})}/>

                <label className="field">
                    <span>줄 서기 지연 (초)</span>
                    <NumberInput value={gallery.delaySec} onChange={(delaySec) => onChange({delaySec})}/>
                    <small className="muted">나눔 글을 감지한 뒤 기다릴 시간입니다. 0이면 즉시 줄을 섭니다.</small>
                </label>

                <fieldset className="field">
                    <legend>나눔 종류</legend>
                    <div className="row">
                        <label className="check">
                            <input type="radio" name={`category-${gallery.id}`} checked={gallery.category === "food"} onChange={() => onChange({category: "food"})}/>
                            음식만
                        </label>
                        <label className="check">
                            <input type="radio" name={`category-${gallery.id}`} checked={gallery.category === "all"} onChange={() => onChange({category: "all"})}/>
                            모두
                        </label>
                    </div>
                </fieldset>
            </div>

            <KeywordEditor label="우선 키워드" keywords={gallery.keywords} onChange={(keywords) => onChange({keywords})}
                           placeholder="키워드 입력 (쉼표로 여러 개)"
                           notice={<small className="muted">
                               키워드와 상관없이 새 글은 전부 LLM이 판단합니다. 제목에 키워드가 있는 글은 본문 요청 상한과 상관없이 본문을 먼저 읽고,
                               판단에 실패하면 알림으로 보냅니다.
                           </small>}/>

            <div className="field">
                <label className="check">
                    <input type="checkbox" checked={gallery.scanBody} onChange={(event) => onChange({scanBody: event.target.checked})}/>
                    키워드 없는 글도 본문 읽기
                </label>
                <small className="muted">
                    새 글마다 본문을 열어 제목과 함께 LLM에 보냅니다. 제목에 티를 안 내는 나눔 글도 잡지만 새 글마다 디시 요청이 하나씩 늘어납니다.
                    끄면 키워드에 걸린 글만 본문을 읽고, 나머지는 제목만 보냅니다.
                </small>
                {gallery.scanBody && (
                    <label className="field">
                        <span>본문 요청 상한 (한 번 확인할 때)</span>
                        <NumberInput value={gallery.bodyReadLimit} min={0} onChange={(bodyReadLimit) => onChange({bodyReadLimit})}/>
                        <small className="muted">
                            제목에 키워드가 없는 새 글은 최근 글부터 이 개수까지만 본문을 엽니다. 나머지는 제목만 보내고,
                            제목만 본 글은 나눔으로 판단돼도 자동으로 줄 서지 않고 알립니다. 0이면 제한하지 않습니다.
                        </small>
                        <small className={gallery.bodyReadLimit === 0 || gallery.bodyReadLimit > BODY_READ_LIMIT_SAFE ? "error-text" : "muted"}>
                            주의: 분당 글이 수십개씩 올라오는 초대형 갤러리에서는 본문 요청 상한을 제거하거나 {BODY_READ_LIMIT_SAFE}개보다 크게 둘 시 IP 차단의 사유가 될 수도 있습니다.
                        </small>
                    </label>
                )}
            </div>

            <KeywordEditor label="제외 키워드" keywords={gallery.excludeKeywords} onChange={(excludeKeywords) => onChange({excludeKeywords})}
                           placeholder="제목이나 본문에 있으면 넘길 단어 (쉼표로 여러 개)"
                           notice={<small className="muted">제목이나 본문에 하나라도 있으면 LLM 판단 없이 넘깁니다. 예: 인증, 구매, 이벤트</small>}/>

            <div className="field">
                <span>대기 계정 (위에 있을수록 먼저 줄을 섭니다)</span>
                {accounts.length === 0 && <small className="muted">계정 탭에서 계정을 먼저 추가하세요.</small>}
                <ol className="account-order">
                    {gallery.accountIds.map((id, index) => (
                        <li key={id}>
                            <span>{index + 1}. {accountLabel(id)}</span>
                            <button className="button small" disabled={index === 0} aria-label={`${accountLabel(id)} 우선순위 올리기`} onClick={() => moveAccount(index, -1)}>▲</button>
                            <button className="button small" disabled={index === gallery.accountIds.length - 1} aria-label={`${accountLabel(id)} 우선순위 내리기`} onClick={() => moveAccount(index, 1)}>▼</button>
                            <button className="button small" onClick={() => toggleAccount(id, false)}>빼기</button>
                        </li>
                    ))}
                </ol>
                <div className="row wrap">
                    {accounts.filter((account) => !gallery.accountIds.includes(account.id)).map((account) => (
                        <button key={account.id} className="button small" onClick={() => toggleAccount(account.id, true)}>
                            + {accountLabel(account.id)}
                        </button>
                    ))}
                </div>
                <small className="muted">나눔 글 하나에는 계정 하나만 줄을 섭니다. 1순위 계정이 조건에 맞지 않거나 실패하면 다음 순위 계정이 섭니다.</small>
            </div>
        </section>
    );
}

function IntervalField({value, onChange}: {value: number; onChange(value: number): void}) {
    const [unit, setUnit] = useState<"sec" | "min">(value % 60 === 0 ? "min" : "sec");
    // 되돌리기처럼 밖에서 값이 바뀌어 분으로 나눠떨어지지 않으면 초 단위로 바꿔 실제 값을 그대로 보여줍니다.
    useEffect(() => {
        if (unit === "min" && value % 60 !== 0) setUnit("sec");
    }, [unit, value]);
    const factor = unit === "min" ? 60 : 1;
    const outOfRange = value < INTERVAL_MIN_SEC || value > INTERVAL_MAX_SEC;
    return (
        <label className="field">
            <span>감시 간격</span>
            <div className="row">
                <NumberInput value={Math.round(value / factor)} min={1} onChange={(amount) => onChange(amount * factor)}/>
                <select value={unit} onChange={(event) => {
                    const next = event.target.value as "sec" | "min";
                    setUnit(next);
                    // 분 단위로 바꾸면 화면에 보이는 값과 실제 값이 같도록 분 단위로 맞춥니다.
                    if (next === "min" && value % 60 !== 0) onChange(Math.max(1, Math.round(value / 60)) * 60);
                }}>
                    <option value="sec">초</option>
                    <option value="min">분</option>
                </select>
            </div>
            <small className={outOfRange ? "error-text" : "muted"}>최소 10초, 최대 1시간입니다. 범위를 벗어나면 저장할 때 맞춰집니다.</small>
        </label>
    );
}
