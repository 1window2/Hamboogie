import {contextBridge, ipcRenderer, type IpcRendererEvent} from "electron";
import type {AppState, HamboogieApi, LogEntry} from "@shared/types";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
    const handler = (_event: IpcRendererEvent, value: T) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

type Invokable = Exclude<keyof HamboogieApi, "onLog" | "onState">;

/** 인자를 빠짐없이 그대로 main으로 넘깁니다. 인자를 손으로 나열하다 하나를 빠뜨리는 실수를 막습니다. */
function invoker<K extends Invokable>(channel: K): HamboogieApi[K] {
    return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as HamboogieApi[K];
}

const api: HamboogieApi = {
    getState: invoker("getState"),
    saveSettings: invoker("saveSettings"),
    setSecret: invoker("setSecret"),
    login: invoker("login"),
    start: invoker("start"),
    stop: invoker("stop"),
    testWebhook: invoker("testWebhook"),
    getLogs: invoker("getLogs"),
    onLog: (listener) => subscribe<LogEntry>("log", listener),
    onState: (listener) => subscribe<AppState>("state", listener)
};

contextBridge.exposeInMainWorld("hamboogie", api);
