import {useEffect, useState} from "react";
import type {LogEntry, LogLevel} from "@shared/types";

const LEVEL_LABELS: Record<LogLevel, string> = {
    info: "정보",
    success: "성공",
    warn: "주의",
    error: "오류"
};

const FILTERS: {id: "all" | LogLevel; label: string}[] = [
    {id: "all", label: "전체"},
    {id: "success", label: "성공"},
    {id: "warn", label: "주의"},
    {id: "error", label: "오류"}
];

const pad = (value: number) => String(value).padStart(2, "0");

function formatTime(time: number): string {
    const date = new Date(time);
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function LogsTab() {
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<"all" | LogLevel>("all");

    useEffect(() => {
        void window.hamboogie.getLogs().then(setEntries);
        return window.hamboogie.onLog((entry) => setEntries((current) => [...current.slice(-999), entry]));
    }, []);

    const visible = (filter === "all" ? entries : entries.filter((entry) => entry.level === filter)).toReversed();

    return (
        <div className="stack">
            <div className="row">
                {FILTERS.map((item) => (
                    <button key={item.id} className={filter === item.id ? "button small selected" : "button small"} onClick={() => setFilter(item.id)}>
                        {item.label}
                    </button>
                ))}
                <span className="muted push-right">최근 {entries.length}건</span>
            </div>
            {visible.length === 0
                ? <p className="muted">아직 기록이 없습니다.</p>
                : (
                    <ul className="logs">
                        {visible.map((entry, index) => (
                            <li key={`${entry.time}-${index}`} className={`log ${entry.level}`}>
                                <time>{formatTime(entry.time)}</time>
                                <span className="level">{LEVEL_LABELS[entry.level]}</span>
                                {entry.galleryId && <span className="where">{entry.galleryId}{entry.postNo ? ` #${entry.postNo}` : ""}</span>}
                                <span className="message">{entry.message}</span>
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    );
}
