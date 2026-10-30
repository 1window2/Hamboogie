import {useEffect, useState} from "react";
import {HISTORY_LIMIT} from "@shared/settings";
import type {HistoryEntry} from "@shared/types";
import {dateTimeText, postUrl} from "@shared/time";

export function HistoryTab() {
    const [entries, setEntries] = useState<HistoryEntry[]>([]);
    const [onlySuccess, setOnlySuccess] = useState(false);

    useEffect(() => {
        void window.hamboogie.getHistory().then(setEntries);
        return window.hamboogie.onHistory((entry) => setEntries((current) => [...current, entry]));
    }, []);

    const visible = (onlySuccess ? entries.filter((entry) => entry.outcome === "success") : entries).toReversed();
    const successCount = entries.filter((entry) => entry.outcome === "success" && !entry.test).length;

    return (
        <div className="stack">
            <div className="row">
                <label className="check">
                    <input type="checkbox" checked={onlySuccess} onChange={(event) => setOnlySuccess(event.target.checked)}/>
                    성공만 보기
                </label>
                <span className="muted push-right">줄 서기 성공 {successCount}건 · 최근 {HISTORY_LIMIT}건까지 보관</span>
            </div>
            {visible.length === 0
                ? <p className="muted">아직 줄 서기 기록이 없습니다.</p>
                : (
                    <ul className="history">
                        {visible.map((entry, index) => (
                            <li key={`${entry.time}-${index}`}>
                                <div className="history-head">
                                    <span className={entry.outcome === "success" ? "badge running" : "badge failure"}>
                                        {entry.outcome === "success" ? "성공" : "실패"}
                                    </span>
                                    {entry.test && <span className="badge">테스트</span>}
                                    <a href={postUrl(entry.galleryId, entry.postNo)} target="_blank" rel="noreferrer">{entry.title || `#${entry.postNo}`}</a>
                                    <span className="muted push-right">{entry.galleryId} · {dateTimeText(entry.time)}</span>
                                </div>
                                <div className="history-detail">{entry.detail}</div>
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    );
}
