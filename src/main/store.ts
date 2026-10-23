import {existsSync, readFileSync} from "node:fs";
import {rename, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {safeStorage} from "electron";
import {defaultSettings, normalizeSettings} from "@shared/settings";
import type {SecretKey, Settings} from "@shared/types";

function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return fallback;
    }
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * 임시 파일에 쓴 뒤 바꿔치기합니다. 같은 파일에 대한 쓰기는 순서대로 하나씩 처리해서,
 * 동시에 저장할 때 임시 파일이 겹쳐 써져 내용이 깨지는 일을 막습니다.
 */
function writeJson(path: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value, null, 2);
    const write = async () => {
        const temp = `${path}.tmp`;
        await writeFile(temp, content, "utf8");
        await rename(temp, path);
    };
    const next = (writeQueues.get(path) ?? Promise.resolve()).catch(() => {}).then(write);
    writeQueues.set(path, next);
    return next;
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
        this.data = readJson<Record<string, string>>(this.path, {});
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

    async removeByPrefix(prefix: string): Promise<void> {
        for (const key of Object.keys(this.data)) if (key.startsWith(prefix)) delete this.data[key];
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

    /** 기록을 되돌립니다. 예약한 줄 서기가 실행되지 못하고 취소됐을 때 씁니다. */
    release(galleryId: string, postNo: number): void {
        const key = Ledger.key(galleryId, postNo);
        if (!this.set.delete(key)) return;
        this.keys.splice(this.keys.indexOf(key), 1);
        void writeJson(this.path, this.keys).catch(() => {});
    }
}
