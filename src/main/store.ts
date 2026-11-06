import {join} from "node:path";
import {safeStorage} from "electron";
import {defaultSettings, HISTORY_LIMIT, normalizeSettings} from "@shared/settings";
import {normalizeText} from "@shared/text";
import type {HistoryEntry, SecretKey, Settings} from "@shared/types";
import type {UsageRecord} from "./llm/usage";
import {flushJson, LineFile, quarantine, readJsonFile, readList, writeJson} from "./files";
import type {JudgmentRecord} from "./pipeline/engine";

export {flushAllJson} from "./files";

/** 일반 설정입니다. 비밀 정보는 들어 있지 않습니다. */
export class SettingsStore {
    private readonly path: string;
    private current: Settings;
    /** 마지막으로 파일에 쓰인(또는 읽어 온) 설정입니다. 저장에 실패하면 이 설정으로 되돌립니다. */
    private written: Settings;
    /** 설정을 읽으며 버리거나 바로잡은 것입니다. 앱이 켜진 뒤 로그에 남깁니다(로거보다 먼저 만들어질 수 있어 모아 둡니다). */
    readonly loadNotes: string[] = [];

    constructor(dir: string) {
        this.path = join(dir, "settings.json");
        this.current = this.load();
        this.written = this.current;
    }

    /**
     * 저장된 설정을 읽습니다. 깨졌거나(JSON이 아님) 형태가 망가진 설정 파일이면 남겨 두고 기본 설정으로 시작합니다.
     * 그대로 두면 다음 저장 때 기본 설정으로 덮어써 갤러리·계정 설정을 잃습니다.
     */
    private load(): Settings {
        const read = readJsonFile(this.path);
        if (read.state === "missing") return defaultSettings();
        if (read.state === "ok" && read.value && typeof read.value === "object" && !Array.isArray(read.value)) {
            const saved = read.value as Record<string, unknown>;
            // 형태가 틀린 항목(목록이 아닌 갤러리·계정 목록 등)은 다듬으면서 버려지므로, 다음 저장 때 덮어써 잃기 전에 원본을 남겨 둡니다.
            const malformed = [
                ...["galleries", "accounts"].filter((key) => key in saved && !Array.isArray(saved[key])),
                ...["llm", "autoStop"].filter((key) => key in saved && (typeof saved[key] !== "object" || saved[key] === null))
            ];
            try {
                const settings = normalizeSettings({...defaultSettings(), ...saved as Partial<Settings>});
                this.noteDropped(saved, settings);
                if (malformed.length > 0) {
                    quarantine(this.path);
                    this.loadNotes.push(`설정 파일의 ${malformed.join(", ")} 항목 형태가 맞지 않아 기본값으로 시작했습니다. 원본은 settings.json.broken-… 파일로 남겨 두었습니다.`);
                }
                return settings;
            } catch {
                // 아래에서 남겨 둡니다.
            }
        }
        quarantine(this.path);
        this.loadNotes.push("설정 파일이 깨져 기본 설정으로 시작했습니다. 원본은 settings.json.broken-… 파일로 남겨 두었습니다.");
        return defaultSettings();
    }

    /** 다듬으며 버린 계정·갤러리·모델 이름을 기록합니다. 설정이 사라진 까닭을 로그에서 알 수 있게 합니다. */
    private noteDropped(saved: Record<string, unknown>, settings: Settings): void {
        for (const [key, kept] of [["accounts", settings.accounts.length], ["galleries", settings.galleries.length]] as const) {
            const before = Array.isArray(saved[key]) ? saved[key].length : 0;
            if (before > kept) this.loadNotes.push(`설정 파일의 ${key} 중 ${before - kept}개는 형식이 맞지 않아 버렸습니다.`);
        }
        // 1.3.5부터 너무 긴 키워드(30자 넘음)와 넘치는 키워드는 저장하지 않습니다. 예전 버전에서 저장한 것이 말없이 사라지지 않게 남깁니다.
        const savedGalleries = Array.isArray(saved.galleries) ? saved.galleries as Partial<Record<string, unknown>>[] : [];
        for (const gallery of settings.galleries) {
            const original = savedGalleries.find((item) => item?.id === gallery.id);
            for (const [field, label] of [["keywords", "키워드"], ["excludeKeywords", "제외 키워드"]] as const) {
                const before = original?.[field];
                if (!Array.isArray(before)) continue;
                const kept = new Set(gallery[field]);
                const dropped = before.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim() !== "" && !kept.has(normalizeText(keyword).trim()));
                if (dropped.length > 0) this.loadNotes.push(`${gallery.galleryId || "(ID 없음)"} 갤러리의 ${label} 중 저장하지 않는 것(너무 길거나, 겹치거나, 개수를 넘음): ${dropped.join(", ")}`);
            }
        }
        const models = (saved.llm as {models?: Record<string, unknown>} | undefined)?.models;
        for (const [provider, model] of Object.entries(settings.llm.models)) {
            const original = models?.[provider];
            if (typeof original === "string" && original.trim() !== "" && original.trim() !== model) {
                this.loadNotes.push(`${provider} 모델 이름이 올바르지 않아 기본 모델(${model})을 씁니다.`);
            }
        }
    }

    get(): Settings {
        return this.current;
    }

    async save(settings: Settings): Promise<Settings> {
        const next = normalizeSettings(settings);
        this.current = next;
        try {
            await writeJson(this.path, next);
            this.written = next;
        } catch (error) {
            // 파일에 쓰지 못했으면 마지막으로 파일에 쓰인 설정으로 되돌립니다(그사이 다른 저장이 있었으면 그 설정을 둡니다).
            if (this.current === next) this.current = this.written;
            throw error;
        }
        return next;
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
    /** 저장을 부른 횟수와, 그중 파일에 쓰인 마지막 차례입니다. 쓰기에 실패한 값이 뒤의 저장과 함께 쓰였는지 볼 때 씁니다. */
    private setCount = 0;
    private writtenCount = 0;

    constructor(dir: string) {
        this.path = join(dir, "secrets.json");
        this.data = {};
        const read = readJsonFile(this.path);
        if (read.state === "missing") return;
        // 객체가 아니면(배열 등) 깨진 것으로 보고, 다음 저장 때 덮어써서 남은 내용까지 잃지 않도록 남겨 둡니다.
        if (read.state !== "ok" || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) {
            quarantine(this.path);
            return;
        }
        // 값은 암호화한 문자열이어야 합니다. 손으로 고친 파일 등에서 다른 값은 버립니다.
        for (const [key, value] of Object.entries(read.value)) if (typeof value === "string") this.data[key] = value;
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
        const sequence = ++this.setCount;
        const previous = this.data[key];
        let next: string | undefined;
        if (value) {
            this.ensureAvailable();
            next = safeStorage.encryptString(value).toString("base64");
            this.data[key] = next;
        } else {
            delete this.data[key];
        }
        try {
            await writeJson(this.path, this.data);
            this.writtenCount = Math.max(this.writtenCount, sequence);
        } catch (error) {
            // 뒤이어 저장한 다른 항목과 함께 이 값도 쓰였으면 저장된 것입니다.
            await flushJson(this.path);
            if (this.writtenCount > sequence) return;
            // 파일에 쓰지 못했으면 되돌립니다. 화면에 "(저장됨)"으로 보였다가 앱을 다시 켜면 사라지지 않게 합니다.
            // 그사이 같은 항목을 다시 저장했으면 그 값을 둡니다.
            if (this.data[key] === next) {
                if (previous === undefined) delete this.data[key];
                else this.data[key] = previous;
            }
            throw error;
        }
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
        this.keys = readList(this.path, (key): key is string => typeof key === "string");
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
    private readonly file: LineFile;

    constructor(dir: string) {
        this.file = new LineFile(join(dir, "judgments.jsonl"), JUDGMENT_LOG_BYTES);
    }

    append(record: JudgmentRecord): void {
        this.file.append(`${JSON.stringify(record)}\n`);
    }

    /** 남긴 기록이 파일에 다 쓰일 때까지 기다립니다. */
    flush(): Promise<void> {
        return this.file.flush();
    }
}

/** 오늘 보낸 LLM 요청 수를 저장합니다(무료 등급 하루 한도를 앱을 다시 켜도 이어서 세기 위해). */
export class UsageStore {
    private readonly path: string;

    constructor(dir: string) {
        this.path = join(dir, "llm-usage.json");
    }

    load(): UsageRecord | null {
        let read: ReturnType<typeof readJsonFile>;
        try {
            read = readJsonFile(this.path);
        } catch {
            // 읽지 못하면 오늘 쓴 수를 0부터 셉니다(한도 계산만 어긋나고 다른 데이터는 잃지 않습니다).
            return null;
        }
        if (read.state !== "ok" || !read.value || typeof read.value !== "object") return null;
        const {resetAt, count} = read.value as {resetAt?: unknown; count?: unknown};
        // 손상되거나 손으로 고친 값(음수, 무한대)으로 하루 한도 계산이 틀어지지 않게 합니다.
        if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
        return {resetAt, count};
    }

    save(record: UsageRecord): void {
        void writeJson(this.path, record).catch(() => {});
    }
}

/** 줄 서기 기록입니다. 최근 `HISTORY_LIMIT`건만 남깁니다. */
export class HistoryStore {
    private readonly path: string;
    private readonly entries: HistoryEntry[];
    private readonly listeners = new Set<(entry: HistoryEntry) => void>();

    constructor(dir: string) {
        this.path = join(dir, "history.json");
        this.entries = readList(this.path, (entry): entry is HistoryEntry => typeof entry === "object" && entry !== null);
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
