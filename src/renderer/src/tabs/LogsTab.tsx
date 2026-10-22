import {useEffect, useState} from "react";
import type {LogEntry} from "@shared/types";

const LEVEL_LABELS: Record<LogEntry["level"], string> = {
    info: "정보",
    success: "성공",
    warn: "주의",
    error: "오류"
};

function formatTime(time: number): string {
    return new Date(time).toLocaleString("ko-KR", {hour12: false});
}

export function LogsTab() {
    const [entries, setEntries] = useState<LogEntry[]>([]);

    useEffect(() => {
        void window.hamboogie.getLogs().then(setEntries);
        return window.hamboogie.onLog((entry) => setEntries((current) => [...current.slice(-999), entry]));
    }, []);

    if (entries.length === 0) return <p className="muted">아직 기록이 없습니다.</p>;

    return (
        <ul className="logs">
            {[...entries].reverse().map((entry, index) => (
                <li key={`${entry.time}-${index}`} className={`log ${entry.level}`}>
                    <time>{formatTime(entry.time)}</time>
                    <span className="level">{LEVEL_LABELS[entry.level]}</span>
                    {entry.galleryId && <span className="where">{entry.galleryId}{entry.postNo ? ` #${entry.postNo}` : ""}</span>}
                    <span className="message">{entry.message}</span>
                </li>
            ))}
        </ul>
    );
}
