import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {Ledger} from "../src/main/store";

describe("Ledger", () => {
    it("빠르게 연달아 기록해도 파일이 깨지지 않고, 다시 열면 모두 남아 있다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-ledger-"));
        const ledger = new Ledger(dir);
        for (let no = 1; no <= 300; no++) expect(ledger.claim("gf2", no)).toBe(true);
        expect(ledger.claim("gf2", 1)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const saved = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as string[];
        expect(saved).toHaveLength(300);
        const reopened = new Ledger(dir);
        expect(reopened.has("gf2", 300)).toBe(true);
        expect(reopened.claim("gf2", 150)).toBe(false);
    });
});

describe("Ledger.release", () => {
    it("되돌린 기록은 다시 기록할 수 있고, 다시 열어도 빠져 있다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-ledger-"));
        const ledger = new Ledger(dir);
        ledger.claim("gf2", 1);
        ledger.claim("gf2", 2);
        ledger.release("gf2", 1);
        expect(ledger.has("gf2", 1)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(new Ledger(dir).has("gf2", 1)).toBe(false);
        expect(new Ledger(dir).has("gf2", 2)).toBe(true);
        expect(ledger.claim("gf2", 1)).toBe(true);
    });
});
