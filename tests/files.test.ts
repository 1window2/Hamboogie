import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {flushJson, LineFile, quarantine, readJsonFile, writeJson} from "../src/main/files";

const temp = () => mkdtempSync(join(tmpdir(), "hamboogie-files-"));
const mode = (path: string) => statSync(path).mode & 0o777;

describe("readJsonFile", () => {
    it("없는 파일, 읽은 값, 깨진 파일을 구분한다", () => {
        const dir = temp();
        expect(readJsonFile(join(dir, "none.json"))).toEqual({state: "missing"});
        writeFileSync(join(dir, "ok.json"), JSON.stringify({count: 3}));
        expect(readJsonFile(join(dir, "ok.json"))).toEqual({state: "ok", value: {count: 3}});
        writeFileSync(join(dir, "broken.json"), "{\"count\": 3");
        expect(readJsonFile(join(dir, "broken.json"))).toEqual({state: "broken"});
    });

    it("읽는 것 자체가 실패하면(폴더 등) 깨진 파일로 보지 않고 오류를 던진다", () => {
        const dir = temp();
        expect(() => readJsonFile(dir)).toThrow("파일을 읽지 못했습니다");
    });
});

describe("quarantine", () => {
    it("깨진 파일을 '이름.broken-시각'으로 옮겨 둔다", () => {
        const dir = temp();
        const path = join(dir, "settings.json");
        writeFileSync(path, "{");
        quarantine(path);
        expect(existsSync(path)).toBe(false);
        const backups = readdirSync(dir).filter((name) => name.startsWith("settings.json.broken-"));
        expect(backups).toHaveLength(1);
        expect(backups[0]).toMatch(/^settings\.json\.broken-\d+$/);
        expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe("{");
    });

    it("백업은 최근 3개만 남기고, 다른 파일의 백업은 건드리지 않는다", () => {
        const dir = temp();
        const path = join(dir, "secrets.json");
        for (const at of [1700000000001, 1700000000002, 1700000000003, 1700000000004]) writeFileSync(`${path}.broken-${at}`, String(at));
        writeFileSync(join(dir, "ledger.json.broken-1700000000000"), "다른 파일");
        writeFileSync(path, "[");
        quarantine(path);
        const backups = readdirSync(dir).filter((name) => name.startsWith("secrets.json.broken-")).sort();
        expect(backups).toHaveLength(3);
        expect(backups.slice(0, 2)).toEqual(["secrets.json.broken-1700000000003", "secrets.json.broken-1700000000004"]);
        expect(readFileSync(join(dir, backups[2]!), "utf8")).toBe("[");
        expect(existsSync(join(dir, "ledger.json.broken-1700000000000"))).toBe(true);
    });
});

describe("LineFile", () => {
    it("쓰는 동안 크기가 한도를 넘으면 켤 때가 아니어도 .old로 넘기고 새로 쓴다", async () => {
        const path = join(temp(), "test.log");
        const file = new LineFile(path, 100);
        const line = (index: number) => `${String(index).padStart(2, "0")} ${"x".repeat(56)}\n`;
        file.append(line(1));
        file.append(line(2));
        await file.flush();
        expect(existsSync(`${path}.old`)).toBe(false);
        file.append(line(3));
        await file.flush();
        expect(readFileSync(`${path}.old`, "utf8")).toBe(line(1) + line(2));
        expect(readFileSync(path, "utf8")).toBe(line(3));
    });

    it("켤 때 이미 한도를 넘은 파일은 .old로 넘긴다", async () => {
        const path = join(temp(), "test.log");
        writeFileSync(path, "y".repeat(200));
        const file = new LineFile(path, 100);
        file.append("새 줄\n");
        await file.flush();
        expect(readFileSync(`${path}.old`, "utf8")).toBe("y".repeat(200));
        expect(readFileSync(path, "utf8")).toBe("새 줄\n");
    });

    it("새로 만드는 파일은 이 사용자만 읽게 만들고, 이미 있는 파일도 권한을 맞춘다", async () => {
        const dir = temp();
        const created = join(dir, "new.log");
        const file = new LineFile(created, 1000);
        file.append("줄\n");
        await file.flush();
        expect(mode(created)).toBe(0o600);

        const existing = join(dir, "old.log");
        writeFileSync(existing, "예전 줄\n");
        chmodSync(existing, 0o644);
        new LineFile(existing, 1000);
        expect(mode(existing)).toBe(0o600);
    });
});

describe("writeJson", () => {
    it("쓰기가 실패하면 그 호출만 실패로 알리고, 다음 쓰기는 다시 해 본다", async () => {
        const dir = temp();
        const path = join(dir, "settings.json");
        // 임시 파일 자리에 폴더가 있어 쓰기가 실패합니다.
        mkdirSync(`${path}.tmp`);
        const first = writeJson(path, {count: 1});
        const second = writeJson(path, {count: 2});
        await expect(first).rejects.toThrow();
        await expect(second).rejects.toThrow();
        await flushJson(path);
        rmSync(`${path}.tmp`, {recursive: true});
        await writeJson(path, {count: 3});
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({count: 3});
        expect(mode(path)).toBe(0o600);
    });
});
