// 개발 모드(npm run dev) 전용 화면입니다. 배포 빌드에서는 탭이 보이지 않습니다.
import {useEffect, useState} from "react";
import {errorMessage} from "@shared/errors";
import type {DevApiCheckStep, DevTestResult, LogEntry} from "@shared/types";

function clock(offsetMinutes: number): string {
    const date = new Date(Date.now() + offsetMinutes * 60 * 1000);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface Preset {
    label: string;
    expect: string;
    make(): {title: string; body: string};
}

const PRESETS: Preset[] = [
    {label: "기본 줄", expect: "\"줄\" 댓글", make: () => ({title: "햄버거 3개 뿌림 선착순", body: "댓글로 줄 서셈"})},
    {label: "문구 지정", expect: "\"치킨 먹고싶다\" 댓글", make: () => ({title: "치킨 기프티콘 나눔", body: "댓글에 '치킨 먹고싶다'라고 써야 줄 인정함"})},
    {label: "디시콘", expect: "수오미콘 댓글", make: () => ({title: "커피 기프티콘 뿌림", body: "수오미콘으로 줄 서라. 텍스트 댓글은 무효"})},
    {label: "고닉 전용", expect: "고닉 계정만 줄", make: () => ({title: "피자 나눔 (고닉만)", body: "반고닉, 유동은 무효"})},
    {label: "시작 시각", expect: "2분 뒤 줄", make: () => ({title: `${clock(2)}부터 떡볶이 나눔`, body: "그 전에 단 댓글은 무효"})},
    {label: "마감 지남", expect: "넘어감", make: () => ({title: `${clock(-30)}까지 라면 뿌림`, body: "댓글 줄"})},
    {label: "제목만", expect: "\"줄\" 댓글", make: () => ({title: "10분까지 아이스크림 뿌림", body: ""})},
    {label: "나눔 아님", expect: "넘어감", make: () => ({title: "오늘 업데이트 별거 없네", body: "다들 뭐함"})},
    {label: "음식 아님", expect: "음식만이면 넘어감", make: () => ({title: "게임 쿠폰 나눔", body: "댓글로 줄"})},
    {label: "개인정보 요구", expect: "Discord 알림", make: () => ({title: "케이크 기프티콘 나눔", body: "댓글에 전화번호 남기면 보내드림"})}
];

const PLAN_LABELS: Record<DevTestResult["plan"]["kind"], string> = {
    comment: "줄 서기",
    skip: "넘어감",
    notify: "Discord 알림"
};

export function DevTestTab() {
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [act, setAct] = useState(true);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<DevTestResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);

    useEffect(() => window.hamboogie.onLog((entry) => {
        if (entry.message.startsWith("[테스트]")) setLogs((current) => [...current.slice(-49), entry]);
    }), []);

    async function runTest() {
        setRunning(true);
        setError(null);
        setResult(null);
        try {
            setResult(await window.hamboogie.devTestRun({title, body, act}));
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setRunning(false);
        }
    }

    return (
        <div className="stack">
            <ApiCheck/>
            <section className="card">
                <h2>가짜 글 테스트 <span className="badge">개발 모드 전용</span></h2>
                <p className="muted">
                    입력한 제목과 본문을 asgeir 갤러리 1번 글의 내용인 것처럼 판단합니다. 디시에는 글을 쓰지 않고,
                    댓글은 asgeir 1번 글에만 달립니다. 갤러리 탭의 asgeir 설정(대기 계정, 나눔 종류, 지연 시간)을 그대로 씁니다.
                </p>
                <div className="row wrap">
                    {PRESETS.map((preset) => (
                        <button key={preset.label} className="button small" title={`예상: ${preset.expect}`}
                                onClick={() => {
                                    const next = preset.make();
                                    setTitle(next.title);
                                    setBody(next.body);
                                }}>
                            {preset.label}
                        </button>
                    ))}
                </div>
                <label className="field">
                    <span>제목</span>
                    <input value={title} onChange={(event) => setTitle(event.target.value)}/>
                </label>
                <label className="field">
                    <span>본문</span>
                    <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)}/>
                </label>
                <div className="row">
                    <label className="check">
                        <input type="checkbox" checked={act} onChange={(event) => setAct(event.target.checked)}/>
                        실제로 실행 (asgeir 1번 글에 댓글, 필요하면 Discord 알림)
                    </label>
                    <button className="button primary push-right" disabled={running || !title.trim()} onClick={runTest}>
                        {running ? "판단 중…" : "실행"}
                    </button>
                </div>
            </section>

            {error && <div className="banner error">{error}</div>}

            {result && (
                <section className="card">
                    <h2>결과: {PLAN_LABELS[result.plan.kind]} <span className="muted">({(result.elapsedMs / 1000).toFixed(1)}초)</span></h2>
                    {result.plan.kind === "comment" ? (
                        <ol className="account-order">
                            {result.plan.attempts.map((attempt) => (
                                <li key={attempt.account}>{attempt.account} 계정으로 {attempt.content}</li>
                            ))}
                            {result.plan.waitSec > 0 && <li className="muted">{result.plan.waitSec}초 뒤에 실행</li>}
                        </ol>
                    ) : (
                        <p>{result.plan.reason}</p>
                    )}
                    <details>
                        <summary className="muted">LLM 판단 원문</summary>
                        <pre className="json">{JSON.stringify(result.decision, null, 2)}</pre>
                    </details>
                </section>
            )}

            {logs.length > 0 && (
                <ul className="logs">
                    {[...logs].reverse().map((entry, index) => (
                        <li key={`${entry.time}-${index}`} className={`log ${entry.level}`}>
                            <time>{new Date(entry.time).toLocaleTimeString("ko-KR", {hour12: false})}</time>
                            <span className="message">{entry.message}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** 실제 디시 API를 asgeir 1번 글에서 차례로 점검합니다. 단 댓글은 바로 지웁니다. */
function ApiCheck() {
    const [running, setRunning] = useState(false);
    const [steps, setSteps] = useState<DevApiCheckStep[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function check() {
        setRunning(true);
        setError(null);
        try {
            setSteps(await window.hamboogie.devApiCheck());
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setRunning(false);
        }
    }

    return (
        <section className="card">
            <h2>실제 API 점검 <span className="badge">개발 모드 전용</span></h2>
            <p className="muted">
                로그인된 계정으로 asgeir 갤러리 확인, 글 목록, 1번 글 읽기, 텍스트 댓글과 디시콘 댓글 달기를 차례로 해 보고,
                단 댓글은 바로 지웁니다. 디시 요청이 10여 번 나갑니다.
            </p>
            <div className="row">
                <button className="button" disabled={running} onClick={() => void check()}>{running ? "점검 중…" : "점검하기"}</button>
                {error && <span className="error-text">{error}</span>}
            </div>
            {steps && (
                <ul className="logs">
                    {steps.map((item) => (
                        <li key={item.name} className={`log ${item.ok ? "success" : "error"}`}>
                            <span className="message">{item.ok ? "✓" : "✗"} {item.name}: {item.detail} ({item.elapsedMs}ms)</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
