import {existsSync, readFileSync, renameSync, statSync} from "node:fs";
import {appendFile, rename, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {safeStorage} from "electron";
import {defaultSettings, normalizeSettings} from "@shared/settings";
import type {HistoryEntry, SecretKey, Settings} from "@shared/types";

function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return fallback;
    }
}

interface FileWriter {
    /** 아직 쓰지 않은 최신 내용입니다. */
    pending: string | null;
    /** 진행 중인 쓰기입니다. 끝나면 pending까지 모두 쓴 상태입니다. */
    writing: Promise<void> | null;
}

const writers = new Map<string, FileWriter>();

/**
 * 임시 파일에 쓴 뒤 바꿔치기합니다. 같은 파일에 대한 쓰기는 하나씩 처리하고, 쓰는 동안 밀린 요청은
 * 최신 내용 하나로 합칩니다. 동시에 저장해도 내용이 깨지지 않고, 연달아 기록해도 파일을 매번 다시 쓰지 않습니다.
 * 돌려준 Promise는 이 호출의 내용(또는 그보다 최신 내용)이 디스크에 쓰였을 때 끝납니다.
 */
function writeJson(path: string, value: unknown): Promise<void> {
    let writer = writers.get(path);
    if (!writer) {
        writer = {pending: null, writing: null};
        writers.set(path, writer);
    }
    writer.pending = JSON.stringify(value, null, 2);
    writer.writing ??= drain(path, writer);
    return writer.writing;
}

async function drain(path: string, writer: FileWriter): Promise<void> {
    try {
        while (writer.pending !== null) {
            const content = writer.pending;
            writer.pending = null;
            const temp = `${path}.tmp`;
            // 계정 비밀번호(암호화됨), 웹훅 주소, 처리 기록이 들어 있어 이 사용자만 읽을 수 있게 둡니다.
            await writeFile(temp, content, {encoding: "utf8", mode: 0o600});
            await rename(temp, path);
        }
    } finally {
        writer.writing = null;
    }
}

/** 이 파일에 밀린 쓰기가 모두 끝날 때까지 기다립니다. */
function flushJson(path: string): Promise<void> {
    return writers.get(path)?.writing?.catch(() => {}) ?? Promise.resolve();
}

/** 모든 파일에 밀린 쓰기가 끝날 때까지 기다립니다. 앱을 끄기 전에 부릅니다. */
export function flushAllJson(): Promise<void> {
    return Promise.all([...writers.keys()].map(flushJson)).then(() => {});
}

/** 일반 설정입니다. 비밀 정보는 들어 있지 않습니다. */
export class SettingsStore {
    private readonly path: string;
    private current: Settings;

    constructor(dir: string) {
        this.path = join(dir, "settings.json");
        const saved = readJson<Partial<Settings>>(this.path, {});
        this.current = normalizeSettings({...defaultSettings(), ...saved});
    }

    get(): Settings {
        return this.current;
    }

    async save(settings: Settings): Promise<Settings> {
        this.current = normalizeSettings(settings);
        await writeJson(this.path, this.current);
        return this.current;
    }
}

/** 내부 전용 비밀 정보입니다. renderer에서는 설정할 수 없습니다. */
export type InternalSecretKey = `device:${string}` | `otp:${string}`;

/**
 * 계정 비밀번호, OTP 토큰, LLM API 키, 디바이스 인증 정보를 OS 보안 저장소(Windows DPAPI, macOS 키체인)로 암호화해 둡니다.
 */
export class SecretStore {
    private readonly path: string;
    private readonly data: Record<string, string>;

    constructor(dir: string) {
        this.path = join(dir, "secrets.json");
        const loaded = readJson<unknown>(this.path, {});
        // 객체가 아니면(배열 등) 깨진 것으로 보고 비웁니다. 아래에서 백업합니다.
        this.data = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded as Record<string, string> : {};
        // 파일이 깨져서 읽지 못했다면, 다음 저장 때 덮어써서 남은 내용까지 잃지 않도록 백업해 둡니다.
        if (existsSync(this.path) && Object.keys(this.data).length === 0) {
            try {
                if (readFileSync(this.path, "utf8").trim() !== "{}") renameSync(this.path, `${this.path}.broken-${Date.now()}`);
            } catch {
                // 백업에 실패해도 앱은 계속 동작합니다.
            }
        }
    }

    private ensureAvailable(): void {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("이 컴퓨터에서 OS 암호화 저장소를 사용할 수 없습니다.");
    }

    has(key: string): boolean {
        return key in this.data;
    }

    /** 복호화하지 못하면(다른 앱 이름으로 저장됐거나 OS 암호화 키가 바뀐 경우) null을 돌려줍니다. */
    get(key: SecretKey | InternalSecretKey): string | null {
        const encrypted = this.data[key];
        if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
        try {
            return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
        } catch {
            return null;
        }
    }

    async set(key: SecretKey | InternalSecretKey, value: string): Promise<void> {
        if (value) {
            this.ensureAvailable();
            this.data[key] = safeStorage.encryptString(value).toString("base64");
        } else {
            delete this.data[key];
        }
        await writeJson(this.path, this.data);
    }
}

const LEDGER_LIMIT = 5000;

/**
 * 이미 처리한 글 목록입니다. 글 하나에 댓글이 두 번 달리지 않도록, 줄 서기를 시도하기 전에 먼저 기록합니다.
 */
export class Ledger {
    private readonly path: string;
    private readonly keys: string[];
    private readonly set: Set<string>;

    constructor(dir: string) {
        this.path = join(dir, "ledger.json");
        this.keys = readJson<string[]>(this.path, []);
        this.set = new Set(this.keys);
    }

    private static key(galleryId: string, postNo: number): string {
        return `${galleryId}:${postNo}`;
    }

    has(galleryId: string, postNo: number): boolean {
        return this.set.has(Ledger.key(galleryId, postNo));
    }

    /** 처음 기록하면 true, 이미 있으면 false를 돌려줍니다. */
    claim(galleryId: string, postNo: number): boolean {
        const key = Ledger.key(galleryId, postNo);
        if (this.set.has(key)) return false;
        this.set.add(key);
        this.keys.push(key);
        if (this.keys.length > LEDGER_LIMIT) {
            for (const old of this.keys.splice(0, this.keys.length - LEDGER_LIMIT)) this.set.delete(old);
        }
        void writeJson(this.path, this.keys).catch(() => {});
        return true;
    }

    /** 밀린 저장이 끝날 때까지 기다립니다. */
    flush(): Promise<void> {
        return flushJson(this.path);
    }
}

const JUDGMENT_LOG_BYTES = 5 * 1024 * 1024;

/**
 * 나눔으로 판단된 글의 LLM 요청 내용과 판단 원문을 한 줄에 하나씩 쌓습니다(judgments.jsonl).
 * 놓친 글이나 잘못 선 글을 나중에 되짚는 데 씁니다. 5MB를 넘으면 .old로 바꾸고 새로 씁니다.
 */
export class JudgmentLog {
    private readonly path: string;

    constructor(dir: string) {
        this.path = join(dir, "judgments.jsonl");
    }

    append(record: unknown): void {
        try {
            if (existsSync(this.path) && statSync(this.path).size > JUDGMENT_LOG_BYTES) renameSync(this.path, `${this.path}.old`);
        } catch {
            // 바꾸지 못해도 이어서 씁니다.
        }
        void appendFile(this.path, `${JSON.stringify(record)}\n`, {encoding: "utf8", mode: 0o600}).catch(() => {});
    }
}

/** 오늘 보낸 LLM 요청 수를 저장합니다(무료 등급 하루 한도를 앱을 다시 켜도 이어서 세기 위해). */
export class UsageStore {
    private readonly path: string;

    constructor(dir: string) {
        this.path = join(dir, "llm-usage.json");
    }

    load(): {resetAt: number; count: number} | null {
        const saved = readJson<{resetAt?: unknown; count?: unknown} | null>(this.path, null);
        if (!saved || typeof saved.resetAt !== "number" || typeof saved.count !== "number") return null;
        return {resetAt: saved.resetAt, count: saved.count};
    }

    save(record: {resetAt: number; count: number}): void {
        void writeJson(this.path, record).catch(() => {});
    }
}

const HISTORY_LIMIT = 500;

/** 줄 서기 기록입니다. 최근 500건만 남깁니다. */
export class HistoryStore {
    private readonly path: string;
    private readonly entries: HistoryEntry[];
    private readonly listeners = new Set<(entry: HistoryEntry) => void>();

    constructor(dir: string) {
        this.path = join(dir, "history.json");
        this.entries = readJson<HistoryEntry[]>(this.path, []);
    }

    add(entry: HistoryEntry): void {
        this.entries.push(entry);
        if (this.entries.length > HISTORY_LIMIT) this.entries.splice(0, this.entries.length - HISTORY_LIMIT);
        void writeJson(this.path, this.entries).catch(() => {});
        for (const listener of this.listeners) listener(entry);
    }

    /** 밀린 저장이 끝날 때까지 기다립니다. */
    flush(): Promise<void> {
        return flushJson(this.path);
    }

    all(): HistoryEntry[] {
        return [...this.entries];
    }

    subscribe(listener: (entry: HistoryEntry) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
