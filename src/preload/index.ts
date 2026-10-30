import {contextBridge, ipcRenderer, type IpcRendererEvent} from "electron";
import type {HamboogieApi, InvokeChannel, PushEvents} from "@shared/types";

function subscribe<K extends keyof PushEvents>(channel: K, listener: (value: PushEvents[K]) => void): () => void {
    const handler = (_event: IpcRendererEvent, value: PushEvents[K]) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

/** 인자를 빠짐없이 그대로 main으로 넘깁니다. 인자를 손으로 나열하다 하나를 빠뜨리는 실수를 막습니다. */
function invoker<K extends InvokeChannel>(channel: K): HamboogieApi[K] {
    return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as HamboogieApi[K];
}

/** 개발 모드 전용 호출입니다. 배포 빌드에는 main에 그 채널이 없으므로 보내지 않고 바로 실패합니다. */
function devOnly<K extends InvokeChannel>(channel: K): HamboogieApi[K] {
    return import.meta.env.DEV ? invoker(channel) : (() => Promise.reject(new Error("개발 모드 전용 기능입니다."))) as HamboogieApi[K];
}

const api: HamboogieApi = {
    getState: invoker("getState"),
    saveSettings: invoker("saveSettings"),
    setSecret: invoker("setSecret"),
    login: invoker("login"),
    getDccons: invoker("getDccons"),
    getDcconImages: invoker("getDcconImages"),
    checkGallery: invoker("checkGallery"),
    start: invoker("start"),
    stop: invoker("stop"),
    testWebhook: invoker("testWebhook"),
    getLogs: invoker("getLogs"),
    getHistory: invoker("getHistory"),
    installUpdate: invoker("installUpdate"),
    devTestRun: devOnly("devTestRun"),
    devProbe: devOnly("devProbe"),
    devSimulateSleep: devOnly("devSimulateSleep"),
    devAddFreeDccon: devOnly("devAddFreeDccon"),
    devOwnedDccons: devOnly("devOwnedDccons"),
    devBatchTest: devOnly("devBatchTest"),
    devDeleteMyComments: devOnly("devDeleteMyComments"),
    devWatchUntilFirstSuccess: devOnly("devWatchUntilFirstSuccess"),
    devApiCheck: devOnly("devApiCheck"),
    onLog: (listener) => subscribe("log", listener),
    onState: (listener) => subscribe("state", listener),
    onHistory: (listener) => subscribe("history", listener)
};

contextBridge.exposeInMainWorld("hamboogie", api);
