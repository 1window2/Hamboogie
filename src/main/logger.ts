import {LOG_LIMIT} from "@shared/settings";
import type {LogEntry, LogLevel} from "@shared/types";
import {LineFile} from "./files";

/** 로그 파일이 이보다 크면 `.old`로 넘기고 새로 시작합니다. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 로그가 어느 갤러리, 어느 글에 대한 것인지입니다. */
export interface LogContext {
    galleryId?: string;
    postNo?: number;
}

/** 프로그램 내부 로그입니다. 메모리에 최근 기록을 두고 파일에도 덧붙입니다. */
export class Logger {
    private readonly entries: LogEntry[] = [];
    private readonly listeners = new Set<(entry: LogEntry) => void>();
    private readonly file: LineFile;

    constructor(filePath: string) {
        this.file = new LineFile(filePath, MAX_FILE_BYTES);
    }

    log(level: LogLevel, message: string, context: LogContext = {}): void {
        const entry: LogEntry = {time: Date.now(), level, message, ...context};
        this.entries.push(entry);
        if (this.entries.length > LOG_LIMIT) this.entries.splice(0, this.entries.length - LOG_LIMIT);
        for (const listener of this.listeners) listener(entry);
        const where = context.galleryId ? ` [${context.galleryId}${context.postNo ? `#${context.postNo}` : ""}]` : "";
        // 글 제목이나 LLM 판단 근거에 든 줄바꿈으로 가짜 로그 줄이 생기지 않게, 한 기록은 파일에서도 한 줄로 씁니다.
        const oneLine = message.replace(/\r\n|[\r\n\u2028\u2029]/g, " ⏎ ");
        this.file.append(`${new Date(entry.time).toISOString()} ${level.toUpperCase()}${where} ${oneLine}\n`);
    }

    info(message: string, context?: LogContext): void {
        this.log("info", message, context);
    }

    success(message: string, context?: LogContext): void {
        this.log("success", message, context);
    }

    warn(message: string, context?: LogContext): void {
        this.log("warn", message, context);
    }

    error(message: string, context?: LogContext): void {
        this.log("error", message, context);
    }

    /** 남긴 로그가 파일에 다 쓰일 때까지 기다립니다. */
    flush(): Promise<void> {
        return this.file.flush();
    }

    recent(): LogEntry[] {
        return [...this.entries];
    }

    subscribe(listener: (entry: LogEntry) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
