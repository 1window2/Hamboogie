import {useEffect, useState} from "react";
import type {AppState, Settings} from "@shared/types";
import {GalleriesTab} from "./tabs/GalleriesTab";
import {AccountsTab} from "./tabs/AccountsTab";
import {LlmTab} from "./tabs/LlmTab";
import {LogsTab} from "./tabs/LogsTab";

type TabId = "galleries" | "accounts" | "llm" | "logs";

const TABS: {id: TabId; label: string}[] = [
    {id: "galleries", label: "갤러리"},
    {id: "accounts", label: "계정"},
    {id: "llm", label: "LLM · 알림"},
    {id: "logs", label: "로그"}
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

    const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);

    async function run(action: () => Promise<AppState>, keepDraft = false) {
        setError(null);
        try {
            const next = await action();
            setState(next);
            if (!keepDraft) setDraft(next.settings);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }

    const save = () => run(() => window.hamboogie.saveSettings(draft));

    return (
        <div className="app">
            <header className="header">
                <h1>Hamboogie</h1>
                <nav className="tabs">
                    {TABS.map((item) => (
                        <button key={item.id} className={tab === item.id ? "tab active" : "tab"} onClick={() => setTab(item.id)}>
                            {item.label}
                        </button>
                    ))}
                </nav>
                <div className="header-actions">
                    <span className={state.running ? "badge running" : "badge"}>{state.running ? "감시 중" : "멈춤"}</span>
                    {state.running
                        ? <button className="button" onClick={() => run(() => window.hamboogie.stop(), true)}>감시 멈추기</button>
                        : <button className="button primary" disabled={dirty} title={dirty ? "설정을 먼저 저장하세요" : undefined}
                                  onClick={() => run(() => window.hamboogie.start(), true)}>감시 시작</button>}
                </div>
            </header>

            {error && <div className="banner error">{error}</div>}
            {dirty && tab !== "logs" && (
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
                {tab === "galleries" && <GalleriesTab draft={draft} setDraft={setDraft} accounts={state.accounts}/>}
                {tab === "accounts" && <AccountsTab draft={draft} setDraft={setDraft} state={state} run={run}/>}
                {tab === "llm" && <LlmTab draft={draft} setDraft={setDraft} state={state} run={run}/>}
                {tab === "logs" && <LogsTab/>}
            </main>
        </div>
    );
}
