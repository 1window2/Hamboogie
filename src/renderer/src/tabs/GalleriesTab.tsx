import {useState} from "react";
import {INTERVAL_MAX_SEC, INTERVAL_MIN_SEC, KEYWORD_MAX, newGallery} from "@shared/settings";
import type {AccountView, GalleryConfig, Settings} from "@shared/types";
import {NumberInput} from "../components/NumberInput";

interface Props {
    draft: Settings;
    setDraft(settings: Settings): void;
    accounts: AccountView[];
}

export function GalleriesTab({draft, setDraft, accounts}: Props) {
    function update(id: string, patch: Partial<GalleryConfig>) {
        setDraft({...draft, galleries: draft.galleries.map((gallery) => gallery.id === id ? {...gallery, ...patch} : gallery)});
    }

    return (
        <div className="stack">
            {draft.galleries.length === 0 && <p className="muted">감시할 갤러리를 추가하세요.</p>}
            {draft.galleries.map((gallery) => (
                <GalleryCard key={gallery.id} gallery={gallery} accounts={accounts} onChange={(patch) => update(gallery.id, patch)}
                             onRemove={() => setDraft({...draft, galleries: draft.galleries.filter((item) => item.id !== gallery.id)})}/>
            ))}
            <button className="button add" onClick={() => setDraft({...draft, galleries: [...draft.galleries, newGallery(crypto.randomUUID())]})}>
                + 갤러리 추가
            </button>
        </div>
    );
}

function GalleryCard({gallery, accounts, onChange, onRemove}: {
    gallery: GalleryConfig;
    accounts: AccountView[];
    onChange(patch: Partial<GalleryConfig>): void;
    onRemove(): void;
}) {
    const [keywordInput, setKeywordInput] = useState("");
    const keywordsFull = gallery.keywords.length >= KEYWORD_MAX;

    function addKeywords() {
        const added = keywordInput.split(/[,\n]/).map((keyword) => keyword.trim()).filter(Boolean);
        const merged = [...new Set([...gallery.keywords, ...added])].slice(0, KEYWORD_MAX);
        onChange({keywords: merged});
        setKeywordInput("");
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
                <label className="check">
                    <input type="checkbox" checked={gallery.isMinor} onChange={(event) => onChange({isMinor: event.target.checked})}/>
                    마이너 갤러리
                </label>
                <label className="check">
                    <input type="checkbox" checked={gallery.enabled} onChange={(event) => onChange({enabled: event.target.checked})}/>
                    감시 사용
                </label>
                <button className="button danger small push-right" onClick={onRemove}>삭제</button>
            </div>

            <div className="grid">
                <IntervalField value={gallery.intervalSec} onChange={(intervalSec) => onChange({intervalSec})}/>

                <label className="field">
                    <span>줄 서기 지연 (초)</span>
                    <NumberInput value={gallery.delaySec} onChange={(delaySec) => onChange({delaySec})}/>
                    <small className="muted">나눔 글을 감지한 뒤 기다릴 시간입니다. 0이면 즉시 줄을 섭니다.</small>
                </label>

                <fieldset className="field">
                    <span>나눔 종류</span>
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

            <div className="field">
                <span>제목 키워드 ({gallery.keywords.length}/{KEYWORD_MAX})</span>
                {gallery.keywords.length === 0 && (
                    <div className="banner danger">
                        ⚠ 키워드가 비어 있습니다. 갤러리의 모든 새 글이 LLM으로 전송되어, API 토큰이 매우 빠르게 소모되고 요금이 크게 나올 수 있습니다.
                        나눔 글에 자주 쓰이는 키워드를 설정하는 것을 강력히 권장합니다.
                    </div>
                )}
                <div className="chips">
                    {gallery.keywords.map((keyword) => (
                        <span key={keyword} className="chip">
                            {keyword}
                            <button aria-label={`${keyword} 삭제`} onClick={() => onChange({keywords: gallery.keywords.filter((item) => item !== keyword)})}>×</button>
                        </span>
                    ))}
                </div>
                <div className="row">
                    <input value={keywordInput} disabled={keywordsFull} placeholder={keywordsFull ? "키워드는 최대 30개입니다" : "키워드 입력 (쉼표로 여러 개)"}
                           onChange={(event) => setKeywordInput(event.target.value)}
                           onKeyDown={(event) => event.key === "Enter" && addKeywords()}/>
                    <button className="button small" disabled={keywordsFull || !keywordInput.trim()} onClick={addKeywords}>추가</button>
                </div>
            </div>

            <div className="field">
                <span>대기 계정 (위에 있을수록 먼저 줄을 섭니다)</span>
                {accounts.length === 0 && <small className="muted">계정 탭에서 계정을 먼저 추가하세요.</small>}
                <ol className="account-order">
                    {gallery.accountIds.map((id, index) => (
                        <li key={id}>
                            <span>{index + 1}. {accountLabel(id)}</span>
                            <button className="button small" disabled={index === 0} onClick={() => moveAccount(index, -1)}>▲</button>
                            <button className="button small" disabled={index === gallery.accountIds.length - 1} onClick={() => moveAccount(index, 1)}>▼</button>
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
