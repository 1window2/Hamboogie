import {chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync} from "node:fs";
import {appendFile, chmod, rename, stat, writeFile} from "node:fs/promises";
import {basename, dirname, join} from "node:path";

/** 데이터 파일은 계정 비밀번호(암호화됨), 웹훅 주소, 글 내용, 로그인 아이디가 들어 있어 이 사용자만 읽을 수 있게 둡니다. */
const PRIVATE_MODE = 0o600;

/** 깨진 파일의 백업을 이만큼만 남깁니다. 삭제한 계정의 비밀 정보가 백업에 끝없이 남지 않게 합니다. */
const BROKEN_BACKUPS_KEPT = 3;

export type JsonRead = {state: "missing"} | {state: "ok"; value: unknown} | {state: "broken"};

/**
 * JSON 파일을 읽습니다. 없는 파일과 깨진 파일(JSON이 아님)을 구분합니다. 파일을 읽는 것 자체가 실패하면(권한, 다른 프로그램이 잠금 등)
 * 깨진 파일로 보지 않고 오류를 던집니다. 잠깐 읽지 못한 멀쩡한 파일을 깨진 것으로 옮겨 빈 설정으로 시작하지 않게 하기 위해서입니다.
 */
export function readJsonFile(path: string): JsonRead {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {state: "missing"};
        throw new Error(`${basename(path)} 파일을 읽지 못했습니다: ${(error as Error).message}`);
    }
    try {
        return {state: "ok", value: JSON.parse(text) as unknown};
    } catch {
        return {state: "broken"};
    }
}

/**
 * 깨졌거나 형태가 다른 파일을 `이름.broken-시각`으로 남겨 둡니다. 다음 저장 때 덮어써서 남은 내용까지 잃지 않게 하기 위해서입니다.
 * 백업은 최근 몇 개만 남기고 지웁니다.
 */
export function quarantine(path: string): void {
    try {
        renameSync(path, `${path}.broken-${Date.now()}`);
    } catch {
        // 옮기지 못해도 빈 상태로 시작합니다.
        return;
    }
    try {
        const prefix = `${basename(path)}.broken`;
        const backups = readdirSync(dirname(path)).filter((name) => name.startsWith(prefix)).sort();
        for (const old of backups.slice(0, Math.max(0, backups.length - BROKEN_BACKUPS_KEPT))) unlinkSync(join(dirname(path), old));
    } catch {
        // 정리하지 못해도 앱은 계속 동작합니다.
    }
}

/**
 * 목록 파일(처리한 글, 줄 서기 기록)을 읽습니다. 깨졌거나 목록이 아니면 남겨 두고 빈 목록으로 시작합니다.
 * 형태가 다른 파일 때문에 앱이 켜지지 않거나, 다음 저장 때 남은 내용까지 덮어쓰지 않게 하기 위해서입니다.
 */
export function readList<T>(path: string, valid: (item: unknown) => item is T): T[] {
    const read = readJsonFile(path);
    if (read.state === "missing") return [];
    if (read.state === "ok" && Array.isArray(read.value)) return read.value.filter(valid);
    quarantine(path);
    return [];
}

interface PendingWrite {
    content: string;
    /** 이 내용(또는 그보다 최신 내용)이 쓰이길 기다리는 호출들입니다. */
    waiters: {resolve(): void; reject(error: unknown): void}[];
}

interface FileWriter {
    /** 아직 쓰지 않은 최신 내용입니다. */
    pending: PendingWrite | null;
    /** 진행 중인 쓰기입니다. 끝나면 pending까지 모두 쓴(또는 써 본) 상태입니다. 실패해도 거부되지 않습니다. */
    writing: Promise<void> | null;
}

const writers = new Map<string, FileWriter>();

/**
 * 임시 파일에 쓴 뒤 바꿔치기합니다. 같은 파일에 대한 쓰기는 하나씩 처리하고, 쓰는 동안 밀린 요청은
 * 최신 내용 하나로 합칩니다. 동시에 저장해도 내용이 깨지지 않고, 연달아 기록해도 파일을 매번 다시 쓰지 않습니다.
 * 돌려준 Promise는 이 호출의 내용(또는 그보다 최신 내용)이 디스크에 쓰였을 때 끝나고, 그 쓰기가 실패하면 거부됩니다.
 * 앞 쓰기가 실패해도 밀린 최신 내용은 이어서 써 봅니다.
 */
export function writeJson(path: string, value: unknown): Promise<void> {
    let writer = writers.get(path);
    if (!writer) {
        writer = {pending: null, writing: null};
        writers.set(path, writer);
    }
    const content = JSON.stringify(value, null, 2);
    const done = new Promise<void>((resolve, reject) => {
        const waiters = [...writer.pending?.waiters ?? [], {resolve, reject}];
        writer.pending = {content, waiters};
    });
    writer.writing ??= drain(path, writer);
    return done;
}

async function drain(path: string, writer: FileWriter): Promise<void> {
    while (writer.pending !== null) {
        const {content, waiters} = writer.pending;
        writer.pending = null;
        try {
            const temp = `${path}.tmp`;
            await writeFile(temp, content, {encoding: "utf8", mode: PRIVATE_MODE});
            // 지난번에 남은 임시 파일을 다시 쓴 경우에도 권한을 맞춥니다(mode는 새로 만들 때만 적용됩니다).
            await chmod(temp, PRIVATE_MODE);
            await rename(temp, path);
            for (const waiter of waiters) waiter.resolve();
        } catch (error) {
            for (const waiter of waiters) waiter.reject(error);
        }
    }
    writer.writing = null;
}

/** 이 파일에 밀린 쓰기가 모두 끝날 때까지 기다립니다. */
export function flushJson(path: string): Promise<void> {
    return writers.get(path)?.writing ?? Promise.resolve();
}

/** 모든 파일에 밀린 쓰기가 끝날 때까지 기다립니다. 앱을 끄기 전에 부릅니다. */
export function flushAllJson(): Promise<void> {
    return Promise.all([...writers.keys()].map(flushJson)).then(() => {});
}

/**
 * 한 줄씩 덧붙이는 파일입니다(로그, 판단 기록). 줄은 남긴 순서대로 쓰고, 파일이 `maxBytes`를 넘으면
 * `.old`로 넘기고 새로 씁니다. 앱을 오래 켜 두어도 파일이 끝없이 커지지 않게, 켤 때뿐 아니라 쓰는 동안에도 확인합니다.
 */
export class LineFile {
    /** 파일 쓰기 순서입니다. 줄마다 따로 쓰면 거의 동시에 남긴 줄의 순서가 뒤바뀌므로, 앞 줄을 다 쓴 뒤에 씁니다. */
    private writing: Promise<void> = Promise.resolve();
    /** 마지막으로 크기를 확인한 뒤 덧붙인 바이트 수입니다. 매번 파일 크기를 묻지 않으려고 셉니다. */
    private size = 0;

    constructor(private readonly path: string, private readonly maxBytes: number) {
        try {
            if (!existsSync(path)) return;
            // 예전 버전이 권한 없이 만든 파일도 이 사용자만 읽을 수 있게 맞춥니다.
            chmodSync(path, PRIVATE_MODE);
            this.size = statSync(path).size;
            if (this.size > maxBytes) this.rotateSync();
        } catch {
            // 파일 정리에 실패해도 이어서 씁니다.
        }
    }

    private rotateSync(): void {
        renameSync(this.path, `${this.path}.old`);
        this.size = 0;
    }

    append(line: string): void {
        this.writing = this.writing.then(async () => {
            if (this.size > this.maxBytes) {
                await rename(this.path, `${this.path}.old`).catch(() => {});
                this.size = 0;
            }
            await appendFile(this.path, line, {encoding: "utf8", mode: PRIVATE_MODE});
            this.size += Buffer.byteLength(line);
            // 다른 프로그램이 파일을 지웠거나 바꿨을 수 있어 가끔 실제 크기로 맞춥니다.
            if (this.size > this.maxBytes) this.size = (await stat(this.path).catch(() => null))?.size ?? this.size;
        }).catch(() => {});
    }

    /** 남긴 줄이 파일에 다 쓰일 때까지 기다립니다. 앱을 끄기 전에 부릅니다. */
    flush(): Promise<void> {
        return this.writing;
    }
}
