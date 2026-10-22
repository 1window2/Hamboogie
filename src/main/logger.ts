import {existsSync, renameSync, statSync} from "node:fs";
import {appendFile} from "node:fs/promises";
import type {LogEntry, LogLevel} from "@shared/types";

const MAX_ENTRIES = 1000;
/** 로그 파일이 이보다 크면 앱을 켤 때 `.old`로 넘기고 새로 시작합니다. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 프로그램 내부 로그입니다. 메모리에 최근 기록을 두고 파일에도 덧붙입니다. */
export class Logger {
    private readonly entries: LogEntry[] = [];
    private readonly listeners = new Set<(entry: LogEntry) => void>();

    constructor(private readonly filePath: string) {
        try {
            if (existsSync(filePath) && statSync(filePath).size > MAX_FILE_BYTES) renameSync(filePath, `${filePath}.old`);
        } catch {
            // 로그 파일 정리에 실패해도 앱은 계속 동작합니다.
        }
    }

    log(level: LogLevel, message: string, context: {galleryId?: string; postNo?: number} = {}): void {
        const entry: LogEntry = {time: Date.now(), level, message, ...context};
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        for (const listener of this.listeners) listener(entry);
        const where = context.galleryId ? ` [${context.galleryId}${context.postNo ? `#${context.postNo}` : ""}]` : "";
        void appendFile(this.filePath, `${new Date(entry.time).toISOString()} ${level.toUpperCase()}${where} ${message}\n`).catch(() => {});
    }

    info(message: string, context?: {galleryId?: string; postNo?: number}): void {
        this.log("info", message, context);
    }

    success(message: string, context?: {galleryId?: string; postNo?: number}): void {
        this.log("success", message, context);
    }

    warn(message: string, context?: {galleryId?: string; postNo?: number}): void {
        this.log("warn", message, context);
    }

    error(message: string, context?: {galleryId?: string; postNo?: number}): void {
        this.log("error", message, context);
    }

    recent(): LogEntry[] {
        return [...this.entries];
    }

    subscribe(listener: (entry: LogEntry) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
