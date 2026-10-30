import {ipcMain, type IpcMainInvokeEvent, type WebContents} from "electron";
import type {HamboogieApi, InvokeChannel, PushEvents} from "@shared/types";

/**
 * 앱 화면의 요청을 처리할 함수를 등록합니다. 채널 이름과 인자, 돌려줄 값의 형식은 `HamboogieApi`를 따릅니다.
 * 인자는 화면에서 그대로 넘어오므로 형식이 맞는다고 믿지 말고 값을 확인해야 합니다.
 */
export type TrustedHandle = <K extends InvokeChannel>(
    channel: K,
    listener: (event: IpcMainInvokeEvent, ...args: Parameters<HamboogieApi[K]>) => Awaited<ReturnType<HamboogieApi[K]>> | ReturnType<HamboogieApi[K]>
) => void;

/** `fromApp`이 통과시킨 화면(앱 화면)에서 온 요청만 받는 등록 함수를 만듭니다. */
export function trustedHandle(fromApp: (event: IpcMainInvokeEvent) => boolean): TrustedHandle {
    return (channel, listener) => {
        ipcMain.handle(channel, (event, ...args) => {
            if (!fromApp(event)) throw new Error("허용되지 않은 화면에서 온 요청입니다.");
            return listener(event, ...(args as Parameters<HamboogieApi[typeof channel]>));
        });
    };
}

/** 화면에 상태, 로그, 기록을 보냅니다. 채널 이름과 값의 형식은 `PushEvents`를 따릅니다. */
export function push<K extends keyof PushEvents>(contents: WebContents | undefined, channel: K, value: PushEvents[K]): void {
    contents?.send(channel, value);
}
