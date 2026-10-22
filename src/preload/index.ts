import {contextBridge, ipcRenderer, type IpcRendererEvent} from "electron";
import type {AppState, HamboogieApi, LogEntry} from "@shared/types";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
    const handler = (_event: IpcRendererEvent, value: T) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

const api: HamboogieApi = {
    getState: () => ipcRenderer.invoke("getState"),
    saveSettings: (settings) => ipcRenderer.invoke("saveSettings", settings),
    setSecret: (key, value) => ipcRenderer.invoke("setSecret", key, value),
    login: (accountId) => ipcRenderer.invoke("login", accountId),
    start: () => ipcRenderer.invoke("start"),
    stop: () => ipcRenderer.invoke("stop"),
    testWebhook: () => ipcRenderer.invoke("testWebhook"),
    getLogs: () => ipcRenderer.invoke("getLogs"),
    onLog: (listener) => subscribe<LogEntry>("log", listener),
    onState: (listener) => subscribe<AppState>("state", listener)
};

contextBridge.exposeInMainWorld("hamboogie", api);
