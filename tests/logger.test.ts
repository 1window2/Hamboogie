import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {Logger} from "../src/main/logger";

it("거의 동시에 남긴 로그도 남긴 순서대로 파일에 쓴다", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hamboogie-log-")), "test.log");
    const logger = new Logger(file);
    for (let i = 0; i < 200; i++) logger.info(`줄 ${i}`);
    await logger.flush();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => Number(/줄 (\d+)$/.exec(line)![1]));
    expect(lines).toEqual(Array.from({length: 200}, (_, i) => i));
});
