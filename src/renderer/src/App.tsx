import {useEffect, useState} from "react";
import type {AppState, Settings} from "@shared/types";
import {GalleriesTab} from "./tabs/GalleriesTab";
import {AccountsTab} from "./tabs/AccountsTab";
import {LlmTab} from "./tabs/LlmTab";
import {LogsTab} from "./tabs/LogsTab";
import {HistoryTab} from "./tabs/HistoryTab";
import {DevTestTab} from "./tabs/DevTestTab";
import iconUrl from "./assets/icon.svg";
import {errorMessage} from "@shared/errors";

/** 설정 초안 갱신 함수입니다. 값이나, 이전 초안을 받아 새 초안을 돌려주는 함수를 받습니다. */
export type DraftSetter = (next: Settings | ((prev: Settings) => Settings)) => void;

type TabId = "galleries" | "accounts" | "llm" | "history" | "logs" | "devTest";

const TABS: {id: TabId; label: string}[] = [
    {id: "galleries", label: "갤러리"},
    {id: "accounts", label: "계정"},
    {id: "llm", label: "LLM · 알림"},
    {id: "history", label: "기록"},
    {id: "logs", label: "로그"},
    // 개발 모드에서만 보입니다.
    ...(import.meta.env.DEV ? [{id: "devTest" as const, label: "테스트"}] : [])
];

export function App() {
    const [state, setState] = useState<AppState | null>(null);
    const [draft, setDraft] = useState<Settings | null>(null);
    const [tab, setTab] = useState<TabId>("galleries");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void window.hamboogie.getState().then((next) => {
            setState(next);
            setDraft(next.settings);
        });
        return window.hamboogie.onState(setState);
    }, []);

    if (!state || !draft) return <div className="loading">불러오는 중…</div>;

    // 탭에는 항상 최신 초안을 기준으로 고치도록 함수형 갱신을 넘깁니다. 비동기 작업(갤러리 확인 등)이 끝난 뒤
    // 그사이 고친 내용을 옛 초안으로 덮어쓰지 않게 하기 위해서입니다.
    const updateDraft: DraftSetter = (next) => setDraft((prev) => prev && (typeof next === "function" ? next(prev) : next));

    const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);

    async function run(action: () => Promise<AppState>, keepDraft = false) {
        setError(null);
        try {
            const next = await action();
            setState(next);
            if (!keepDraft) setDraft(next.settings);
        } catch (caught) {
            setError(errorMessage(caught));
        }
    }

    const save = () => run(() => window.hamboogie.saveSettings(draft));

    return (
        <div className="app">
            <header className="header">
                <h1 className="brand"><img src={iconUrl} alt="" width={26} height={26}/>Hamboogie<small className="version">v{state.version}</small></h1>
                {state.offline && <span className="badge failure" title="디시 대신 가짜 글과 가짜 계정을 씁니다">오프라인 모드</span>}
                <nav className="tabs">
                    {TABS.map((item) => (
                        <button key={item.id} className={tab === item.id ? "tab active" : "tab"} onClick={() => setTab(item.id)}>
                            {item.label}
                        </button>
                    ))}
                </nav>
                <div className="header-actions">
                    <span className={state.running ? "badge running" : "badge"}>
                        {state.running ? `감시 중 · 갤러리 ${state.watching}개` : "멈춤"}
                    </span>
                    {state.running
                        ? <button className="button" onClick={() => run(() => window.hamboogie.stop(), true)}>감시 멈추기</button>
                        : <button className="button primary" disabled={dirty} title={dirty ? "설정을 먼저 저장하세요" : undefined}
                                  onClick={() => run(() => window.hamboogie.start(), true)}>감시 시작</button>}
                </div>
            </header>

            {state.update.state === "ready" && (
                <div className="banner info">
                    새 버전 {state.update.version}을 받아 두었습니다. 지금 다시 시작하거나, 앱을 종료할 때 자동으로 설치됩니다.
                    <button className="button primary small" onClick={() => void window.hamboogie.installUpdate()}>다시 시작해서 업데이트</button>
                </div>
            )}
            {state.update.state === "downloading" && (
                <div className="banner info">새 버전 {state.update.version}을 받는 중입니다… {state.update.percent}%</div>
            )}
            {state.update.state === "available" && (
                <div className="banner info">
                    새 버전 {state.update.version}이 나왔습니다.
                    <a className="button primary small" href={state.update.url} target="_blank" rel="noreferrer">다운로드 페이지 열기</a>
                </div>
            )}
            {error && <div className="banner error">{error}</div>}
            {dirty && !["history", "logs", "devTest"].includes(tab) && (
                <div className="banner unsaved">
                    저장하지 않은 변경 사항이 있습니다.
                    <button className="button primary small" onClick={save}>설정 저장</button>
                    <button className="button small" onClick={() => setDraft(state.settings)}>되돌리기</button>
                </div>
            )}
            {state.running && dirty && (
                <div className="banner info">감시 중에 갤러리를 추가하거나 켜고 끈 경우, 저장한 뒤 감시를 다시 시작해야 반영됩니다.</div>
            )}

            <main className="content">
                {tab === "galleries" && <GalleriesTab draft={draft} setDraft={updateDraft} accounts={state.accounts} status={state.galleryStatus}/>}
                {tab === "accounts" && <AccountsTab draft={draft} setDraft={updateDraft} state={state} run={run}/>}
                {tab === "llm" && <LlmTab draft={draft} setDraft={updateDraft} state={state} run={run}/>}
                {tab === "history" && <HistoryTab/>}
                {tab === "logs" && <LogsTab/>}
                {import.meta.env.DEV && tab === "devTest" && <DevTestTab/>}
            </main>
        </div>
    );
}
