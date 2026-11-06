import {spawn, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {appRoot, CpuGuard, quitDeadline, watchCpu, WATCHDOG_SCRIPT} from "../src/main/safety";

describe("CpuGuard", () => {
    it("한도를 넘는 상태가 정한 횟수만큼 이어질 때만 끄라고 한다", () => {
        const guard = new CpuGuard(200, 3);
        expect([250, 300].map((percent) => guard.record(percent))).toEqual([false, false]);
        expect(guard.record(201)).toBe(true);
    });

    it("중간에 한 번이라도 한도 아래로 내려가면 다시 센다", () => {
        const guard = new CpuGuard(200, 3);
        expect([300, 300, 50, 300, 300].map((percent) => guard.record(percent))).toEqual([false, false, false, false, false]);
        expect(guard.record(300)).toBe(true);
    });

    it("잴 수 없는 값은 한도 아래로 본다", () => {
        const guard = new CpuGuard(200, 1);
        expect(guard.record(Number.NaN)).toBe(false);
    });
});

describe("quitDeadline", () => {
    afterEach(() => vi.useRealTimers());

    it("처음 부른 때부터 정한 시간이 지나면 한 번만 끝낸다", () => {
        vi.useFakeTimers();
        const exit = vi.fn();
        const start = quitDeadline(exit, 5000);
        start();
        vi.advanceTimersByTime(3000);
        start();
        vi.advanceTimersByTime(2000);
        expect(exit).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(10_000);
        expect(exit).toHaveBeenCalledTimes(1);
    });
});

describe("watchCpu", () => {
    afterEach(() => vi.useRealTimers());

    it("CPU를 오래 많이 쓰면 한 번만 알린다", () => {
        vi.useFakeTimers();
        const onRunaway = vi.fn();
        watchCpu({cpuPercent: () => 400, onRunaway, onExecutableGone: vi.fn(), exists: () => true, intervalMs: 1000, guard: new CpuGuard(200, 3)});
        vi.advanceTimersByTime(2000);
        expect(onRunaway).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5000);
        expect(onRunaway).toHaveBeenCalledTimes(1);
        expect(onRunaway).toHaveBeenCalledWith(400);
    });

    it("실행 파일이 사라지면 CPU와 상관없이 바로 알린다", () => {
        vi.useFakeTimers();
        const onExecutableGone = vi.fn();
        const onRunaway = vi.fn();
        let present = true;
        watchCpu({cpuPercent: () => 0, onRunaway, onExecutableGone, exists: () => present, intervalMs: 1000});
        vi.advanceTimersByTime(3000);
        expect(onExecutableGone).not.toHaveBeenCalled();
        present = false;
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(5000);
        expect(onExecutableGone).toHaveBeenCalledTimes(1);
        expect(onRunaway).not.toHaveBeenCalled();
    });

    it("평소처럼 쉬고 있으면 아무것도 하지 않는다", () => {
        vi.useFakeTimers();
        const onRunaway = vi.fn();
        const stop = watchCpu({cpuPercent: () => 3, onRunaway, onExecutableGone: vi.fn(), exists: () => true, intervalMs: 1000});
        vi.advanceTimersByTime(600_000);
        stop();
        expect(onRunaway).not.toHaveBeenCalled();
    });
});

/**
 * 감시 스크립트를 실제로 돌려, `target` 프로세스가 끝날 때까지(최대 `timeoutMs`) 기다립니다. 끝났으면 true입니다.
 * 감시 프로세스는 앱이 끝난 뒤 정리를 마치고 스스로 끝나므로, 그것까지 기다립니다.
 */
async function runWatchdog(target: number, exe: string, limit: number, need: number, timeoutMs: number, root = "/nonexistent-root"): Promise<boolean> {
    const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "test", String(target), exe, root, String(limit), String(need), "1", "1"], {stdio: "ignore"});
    const watchdogExit = new Promise((resolve) => watchdog.on("exit", resolve));
    const alive = () => {
        try {
            process.kill(target, 0);
            return true;
        } catch {
            return false;
        }
    };
    try {
        await waitFor(() => !alive(), timeoutMs);
        if (alive()) return false;
        await Promise.race([watchdogExit, new Promise((resolve) => setTimeout(resolve, 6000))]);
        return true;
    } finally {
        watchdog.kill("SIGKILL");
    }
}

/** 앱 폴더(Test.app)와 실행 파일, 하위 프로세스처럼 쓸 스크립트(그대로 계속 도는 셸 스크립트)를 만듭니다. */
function fakeApp(): {root: string; exe: string; helper: string} {
    const root = join(mkdtempSync(join(tmpdir(), "hamboogie-watchdog-")), "Test.app");
    mkdirSync(join(root, "Contents", "MacOS"), {recursive: true});
    const exe = join(root, "Contents", "MacOS", "app");
    writeFileSync(exe, "");
    const helper = join(root, "Contents", "MacOS", "helper");
    writeFileSync(helper, "#!/bin/sh\nwhile :; do sleep 1; done\n", {mode: 0o755});
    return {root, exe, helper};
}

/** 명령줄에 `text`가 든 프로세스가 있는지입니다(pgrep는 자기 자신을 빼고 찾습니다). */
function running(text: string): boolean {
    return spawnSync("pgrep", ["-f", text]).status === 0;
}

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
    const started = Date.now();
    while (!condition() && Date.now() - started < timeoutMs) await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("appRoot", () => {
    it("macOS는 .app 번들, 그 밖에는 실행 파일이 든 폴더다", () => {
        expect(appRoot("/Volumes/Hamboogie 1.3.5/Hamboogie.app/Contents/MacOS/Hamboogie")).toBe("/Volumes/Hamboogie 1.3.5/Hamboogie.app");
        expect(appRoot("/opt/Hamboogie/hamboogie")).toBe("/opt/Hamboogie");
    });
});

describe.skipIf(process.platform === "win32")("앱 밖 감시 프로세스", () => {
    it("실행 파일이 사라지면 앱 프로세스를 끝낸다", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hamboogie-watchdog-"));
        const exe = join(dir, "app");
        writeFileSync(exe, "");
        const app = spawn("/bin/sleep", ["60"], {stdio: "ignore"});
        try {
            rmSync(exe);
            expect(await runWatchdog(app.pid!, exe, 100_000, 100, 8000)).toBe(true);
        } finally {
            app.kill("SIGKILL");
            rmSync(dir, {recursive: true, force: true});
        }
    }, 15_000);

    it("실행 파일이 사라지면 고아가 된 하위 프로세스까지 앱 폴더에서 나온 프로세스를 모두 끝낸다", async () => {
        const {root, exe, helper} = fakeApp();
        const app = spawn("/bin/sleep", ["60"], {stdio: "ignore"});
        // 앱 폴더 안 경로로 실행된 하위 프로세스(앱이 끝난 뒤 남은 Renderer 같은 것)입니다.
        const orphan = spawn(helper, ["leftover"], {stdio: "ignore"});
        try {
            await waitFor(() => running(`${helper} leftover`));
            rmSync(exe);
            expect(await runWatchdog(app.pid!, exe, 100_000, 100, 8000, root)).toBe(true);
            await waitFor(() => !running(`${helper} leftover`));
            expect(running(`${helper} leftover`)).toBe(false);
        } finally {
            app.kill("SIGKILL");
            orphan.kill("SIGKILL");
            rmSync(dirname(root), {recursive: true, force: true});
        }
    }, 20_000);

    it("감시 프로세스가 앱의 하위 프로세스여도(실제 앱처럼) 자기를 끝내지 않고, 종료 신호를 무시하는 앱을 끝낸다", async () => {
        const {root, exe} = fakeApp();
        // 앱이 감시 프로세스를 띄운 뒤 종료 신호를 무시하며 계속 돕니다(고장 난 앱). 무시 설정이 감시 프로세스에 물려지지 않도록 감시 프로세스를 먼저 띄웁니다.
        const app = spawn("/bin/sh", ["-c", `/bin/sh -c "$WD" hamboogie-watchdog $$ "$EXE" "$ROOT" 100000 100 1 1 & trap '' TERM; while :; do sleep 1; done`],
            {stdio: "ignore", env: {...process.env, WD: WATCHDOG_SCRIPT, EXE: exe, ROOT: root}});
        const appExit = new Promise((resolve) => app.on("exit", (_code, signal) => resolve(signal)));
        try {
            await waitFor(() => running("hamboogie-watchdog"));
            rmSync(exe);
            await expect(Promise.race([appExit, new Promise((resolve) => setTimeout(() => resolve("남음"), 10_000))])).resolves.toBe("SIGKILL");
        } finally {
            app.kill("SIGKILL");
            rmSync(dirname(root), {recursive: true, force: true});
        }
    }, 20_000);

    it("앱이 스스로 끝나면 고아로 남은 하위 프로세스(--type=)를 정리하고, 다른 프로세스는 건드리지 않는다", async () => {
        const {root, exe, helper} = fakeApp();
        // 부모 셸이 바로 끝나, 하위 프로세스는 고아(부모 pid 1)가 됩니다. 하나는 Electron 하위 프로세스처럼 --type=을 붙입니다.
        spawn("/bin/sh", ["-c", `"${helper}" --type=renderer & "${helper}" keep & exit`], {stdio: "ignore"});
        try {
            await waitFor(() => running(`${helper} --type=renderer`) && running(`${helper} keep`));
            const app = spawn("/bin/sleep", ["1"], {stdio: "ignore"});
            const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "test", String(app.pid), exe, root, "100000", "100", "1", "1"], {stdio: "ignore"});
            await new Promise((resolve) => watchdog.on("exit", resolve));
            expect(running(`${helper} --type=renderer`)).toBe(false);
            expect(running(`${helper} keep`)).toBe(true);
        } finally {
            spawnSync("pkill", ["-9", "-f", helper]);
            rmSync(dirname(root), {recursive: true, force: true});
        }
    }, 20_000);

    it("CPU 한도를 넘는 상태가 이어지면 종료 신호를 보내고, 안 끝나면 강제로 끝낸다", async () => {
        // 종료 신호를 무시하고 CPU를 쓰는 프로세스(이번 사고처럼 정상 종료가 안 되는 앱)입니다.
        const app = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], {stdio: "ignore"});
        try {
            expect(await runWatchdog(app.pid!, "/bin/sh", 30, 2, 12_000)).toBe(true);
        } finally {
            app.kill("SIGKILL");
        }
    }, 20_000);

    it("평범한 프로세스는 건드리지 않고, 앱이 끝나면 스스로 끝난다", async () => {
        const app = spawn("/bin/sleep", ["4"], {stdio: "ignore"});
        const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "test", String(app.pid), "/bin/sleep", "/nonexistent-root", "200", "3", "1", "1"], {stdio: "ignore"});
        const appExit = new Promise<number | null>((resolve) => app.on("exit", (code) => resolve(code)));
        const watchdogExit = new Promise<number | null>((resolve) => watchdog.on("exit", (code) => resolve(code)));
        // 앱이 제때(4초) 정상적으로 끝나고, 감시 프로세스도 뒤따라 끝납니다.
        expect(await appExit).toBe(0);
        expect(await watchdogExit).toBe(0);
    }, 15_000);
});
