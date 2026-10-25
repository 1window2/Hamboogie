import {AUTO_STOP_MAX_MINUTES} from "@shared/settings";
import type {AutoStop} from "@shared/types";
import {NumberInput} from "./NumberInput";

interface Props {
    autoStop: AutoStop;
    onChange(autoStop: AutoStop): void;
    /** 감시 중일 때 실제로 멈출 시각입니다. */
    stopAt: number | null;
}

/** 감시 자동 중지 설정입니다. 직접 인증하기 어려운 시간(잘 때 등)에 감시가 돌지 않게 합니다. */
export function AutoStopCard({autoStop, onChange, stopAt}: Props) {
    const outOfRange = autoStop.afterMinutes < 1 || autoStop.afterMinutes > AUTO_STOP_MAX_MINUTES;
    return (
        <section className="card">
            <h2>감시 자동 중지</h2>
            <p className="muted">
                인증이 필요한 나눔은 직접 깨어 있어야 받을 수 있습니다. 잘 시간처럼 확인할 수 없을 때는 감시가 저절로 멈추게 해 두세요.
                감시 중에 바꿔도 저장하면 바로 반영됩니다.
            </p>
            <div className="row wrap">
                <select value={autoStop.mode} onChange={(event) => onChange({...autoStop, mode: event.target.value as AutoStop["mode"]})}>
                    <option value="off">자동으로 멈추지 않음</option>
                    <option value="after">감시 시작 후 정한 시간이 지나면</option>
                    <option value="at">정한 시각이 되면</option>
                </select>
                {autoStop.mode === "after" && (
                    <>
                        <NumberInput className="short" value={autoStop.afterMinutes} min={1} onChange={(afterMinutes) => onChange({...autoStop, afterMinutes})}/>
                        <span>분 후</span>
                    </>
                )}
                {autoStop.mode === "at" && (
                    <input type="time" className="short" value={autoStop.at} required
                           onChange={(event) => {
                               if (event.target.value) onChange({...autoStop, at: event.target.value});
                           }}/>
                )}
            </div>
            {autoStop.mode === "after" && (
                <small className={outOfRange ? "error-text" : "muted"}>
                    감시를 시작한 때부터 셉니다. 1분부터 {AUTO_STOP_MAX_MINUTES / 60}시간까지 정할 수 있습니다.
                </small>
            )}
            {autoStop.mode === "at" && <small className="muted">이 컴퓨터 시간 기준입니다. 이미 지난 시각이면 다음 날 그 시각에 멈춥니다.</small>}
            {stopAt !== null && <small className="muted">지금 감시는 {stopAtText(stopAt)}에 멈춥니다.</small>}
        </section>
    );
}

/** 오늘이면 시각만, 아니면 "내일"을 붙여 씁니다. */
export function stopAtText(stopAt: number): string {
    const date = new Date(stopAt);
    const time = date.toLocaleTimeString("ko-KR", {hour: "2-digit", minute: "2-digit", hour12: false});
    return date.toDateString() === new Date().toDateString() ? time : `내일 ${time}`;
}
