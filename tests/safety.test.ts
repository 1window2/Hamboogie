import {spawn, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {appRoot, CpuGuard, CpuMeter, HeartbeatMonitor, quitDeadline, watchCpu, WATCHDOG_SCRIPT} from "../src/main/safety";

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

describe("CpuMeter", () => {
    it("누적 CPU 시간의 차이로 코어 하나 기준 사용률을 잰다(코어 수로 나누지 않는다)", () => {
        const meter = new CpuMeter();
        expect(meter.measure([{pid: 1, seconds: 10}, {pid: 2, seconds: 5}], 0)).toEqual({total: 0, max: 0});
        // 5초 동안 1번은 15초(코어 3개), 2번은 2.5초(코어 반 개)를 썼습니다.
        const {total, max} = meter.measure([{pid: 1, seconds: 25}, {pid: 2, seconds: 7.5}], 5000);
        expect(Math.round(total)).toBe(350);
        expect(Math.round(max)).toBe(300);
    });

    it("새로 생긴 프로세스는 다음 측정부터 세고, 사라진 프로세스는 잊는다", () => {
        const meter = new CpuMeter();
        meter.measure([{pid: 1, seconds: 0}], 0);
        expect(meter.measure([{pid: 1, seconds: 1}, {pid: 2, seconds: 100}], 1000)).toEqual({total: 100, max: 100});
        expect(meter.measure([{pid: 2, seconds: 100.5}], 2000)).toEqual({total: 50, max: 50});
    });
});

describe("HeartbeatMonitor", () => {
    it("생존 신호가 정한 간격 수만큼 연달아 없을 때만 멈춘 것으로 본다", () => {
        const monitor = new HeartbeatMonitor(3);
        expect([monitor.tick(), monitor.tick()]).toEqual([false, false]);
        monitor.beat();
        expect([monitor.tick(), monitor.tick(), monitor.tick()]).toEqual([false, false, false]);
        expect(monitor.tick()).toBe(true);
    });

    it("잠든다고 알린 뒤에는 다시 생존 신호가 올 때까지 세지 않는다", () => {
        const monitor = new HeartbeatMonitor(2);
        monitor.tick();
        monitor.pause();
        expect([monitor.tick(), monitor.tick(), monitor.tick()]).toEqual([false, false, false]);
        monitor.beat();
        expect([monitor.tick(), monitor.tick(), monitor.tick()]).toEqual([false, false, true]);
    });
});

/** `watchCpu`에 넣을 가짜 측정값입니다. 부를 때마다 프로세스 하나가 `percent`(코어 하나 = 100)만큼 1초씩 더 쓴 것으로 셉니다. */
function fakeUsage(percents: () => number[]): {sample: () => {pid: number; seconds: number}[]; now: () => number} {
    let time = 0;
    const seconds: number[] = [];
    return {
        sample: () => {
            time += 1000;
            return percents().map((percent, index) => {
                seconds[index] = (seconds[index] ?? 0) + percent / 100;
                return {pid: index + 1, seconds: seconds[index]!};
            });
        },
        now: () => time
    };
}

describe("watchCpu", () => {
    afterEach(() => vi.useRealTimers());

    it("앱 전체가 CPU를 오래 많이 쓰면 한 번만 알린다", () => {
        vi.useFakeTimers();
        const onRunaway = vi.fn();
        watchCpu({...fakeUsage(() => [150, 150]), onRunaway, onExecutableGone: vi.fn(), exists: () => true, intervalMs: 1000, appGuard: new CpuGuard(200, 3)});
        vi.advanceTimersByTime(2000);
        expect(onRunaway).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5000);
        expect(onRunaway).toHaveBeenCalledTimes(1);
        expect(onRunaway.mock.calls[0]![1]).toBe("app");
        expect(Math.round(onRunaway.mock.calls[0]![0] as number)).toBe(300);
    });

    it("프로세스 하나가 코어 하나를 오래 붙잡아도 알린다(앱 전체 한도 아래여도)", () => {
        vi.useFakeTimers();
        const onRunaway = vi.fn();
        watchCpu({...fakeUsage(() => [100, 0]), onRunaway, onExecutableGone: vi.fn(), exists: () => true, intervalMs: 1000, processGuard: new CpuGuard(90, 5)});
        vi.advanceTimersByTime(10_000);
        expect(onRunaway).toHaveBeenCalledTimes(1);
        expect(onRunaway.mock.calls[0]![1]).toBe("process");
    });

    it("실행 파일이 사라지면 CPU와 상관없이 바로 알린다", () => {
        vi.useFakeTimers();
        const onExecutableGone = vi.fn();
        const onRunaway = vi.fn();
        let present = true;
        watchCpu({...fakeUsage(() => [0]), onRunaway, onExecutableGone, exists: () => present, intervalMs: 1000});
        vi.advanceTimersByTime(3000);
        expect(onExecutableGone).not.toHaveBeenCalled();
        present = false;
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(5000);
        expect(onExecutableGone).toHaveBeenCalledTimes(1);
        expect(onRunaway).not.toHaveBeenCalled();
    });

    it("평소처럼 쉬거나 잠깐 바쁜 정도면 아무것도 하지 않는다", () => {
        vi.useFakeTimers();
        const onRunaway = vi.fn();
        let tick = 0;
        // 대부분 쉬다가 가끔 1초 동안 코어 하나를 다 씁니다(사진 줄이기 등).
        const stop = watchCpu({...fakeUsage(() => [tick++ % 10 === 0 ? 100 : 2, 1]), onRunaway, onExecutableGone: vi.fn(), exists: () => true, intervalMs: 1000});
        vi.advanceTimersByTime(3_600_000);
        stop();
        expect(onRunaway).not.toHaveBeenCalled();
    });
});

/**
 * 감시 스크립트를 실제로 돌려, `target` 프로세스가 끝날 때까지(최대 `timeoutMs`) 기다립니다. 끝났으면 true입니다.
 * 감시 프로세스는 앱이 끝난 뒤 정리를 마치고 스스로 끝나므로, 그것까지 기다립니다.
 */
async function runWatchdog(target: number, exe: string, limit: number, need: number, timeoutMs: number, root = "/nonexistent-root", processLimit = 100_000): Promise<boolean> {
    const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "test", String(target), exe, root, String(limit), String(need), String(processLimit), String(need), "1", "1"], {stdio: "ignore"});
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

/** 앱 폴더(Test.app)와 실행 파일, 하위 프로세스 이름으로 쓸 경로를 만듭니다. */
function fakeApp(): {root: string; exe: string; helper: string} {
    const root = join(mkdtempSync(join(tmpdir(), "hamboogie-watchdog-")), "Test.app");
    mkdirSync(join(root, "Contents", "MacOS"), {recursive: true});
    const exe = join(root, "Contents", "MacOS", "app");
    writeFileSync(exe, "");
    return {root, exe, helper: join(root, "Contents", "MacOS", "helper")};
}

/**
 * 명령줄이 `name`으로 시작하는(앱 폴더에서 실행된 Electron 하위 프로세스처럼 보이는) 프로세스를 셸 명령으로 띄우는 부분입니다.
 * sleep을 실행하되 프로그램 이름(argv[0])만 바꿉니다.
 */
function as(name: string): string {
    return `perl -e 'exec {"/bin/sleep"} @ARGV' "${name}" 60`;
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
        const orphan = spawn("/bin/sleep", ["60"], {stdio: "ignore", argv0: `${helper} leftover`});
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
        const app = spawn("/bin/sh", ["-c", `/bin/sh -c "$WD" hamboogie-watchdog $$ "$EXE" "$ROOT" 100000 100 100000 100 1 1 & trap '' TERM; while :; do sleep 1; done`],
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
        spawn("/bin/sh", ["-c", `${as(`${helper} --type=renderer`)} & ${as(`${helper} keep`)} & exit`], {stdio: "ignore"});
        try {
            await waitFor(() => running(`${helper} --type=renderer`) && running(`${helper} keep`));
            const app = spawn("/bin/sleep", ["1"], {stdio: "ignore"});
            const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "test", String(app.pid), exe, root, "100000", "100", "100000", "100", "1", "1"], {stdio: "ignore"});
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

    it("프로세스 하나가 코어 하나를 오래 붙잡으면, 앱 전체 한도 아래여도 끝낸다", async () => {
        const app = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], {stdio: "ignore"});
        try {
            expect(await runWatchdog(app.pid!, "/bin/sh", 100_000, 2, 12_000, "/nonexistent-root", 50)).toBe(true);
        } finally {
            app.kill("SIGKILL");
        }
    }, 20_000);

    it("앱이 끝난 뒤 같은 pid를 받은 다른 프로세스는 앱으로 보지 않는다", async () => {
        // 감시를 시작할 때의 시작 시각과 다르면 끝난 것으로 봅니다. 시작 시각을 바꿀 수는 없으므로, 감시 대상이 아닌 프로세스의
        // 시작 시각으로 감시를 시작한 것처럼 스크립트의 저장값을 바꿔 확인합니다.
        const app = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], {stdio: "ignore"});
        const script = WATCHDOG_SCRIPT.replace('started=$(ps -o lstart= -p "$pid" 2>/dev/null)', "started='Thu Jan  1 00:00:00 1970'");
        const watchdog = spawn("/bin/sh", ["-c", script, "test", String(app.pid), "/bin/sh", "/nonexistent-root", "30", "1", "30", "1", "1", "1"], {stdio: "ignore"});
        const watchdogExit = new Promise((resolve) => watchdog.on("exit", resolve));
        try {
            await Promise.race([watchdogExit, new Promise((resolve) => setTimeout(resolve, 8000))]);
            // CPU 한도를 넘었지만 다른 프로세스로 보았으므로 건드리지 않았습니다.
            expect(() => process.kill(app.pid!, 0)).not.toThrow();
        } finally {
            app.kill("SIGKILL");
            watchdog.kill("SIGKILL");
        }
    }, 15_000);

    it("평범한 프로세스는 건드리지 않고, 앱이 끝나면 스스로 끝난다", async () => {
        const app = spawn("/bin/sleep", ["4"], {stdio: "ignore"});
        const watchdog = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "test", String(app.pid), "/bin/sleep", "/nonexistent-root", "200", "3", "90", "3", "1", "1"], {stdio: "ignore"});
        const appExit = new Promise<number | null>((resolve) => app.on("exit", (code) => resolve(code)));
        const watchdogExit = new Promise<number | null>((resolve) => watchdog.on("exit", (code) => resolve(code)));
        // 앱이 제때(4초) 정상적으로 끝나고, 감시 프로세스도 뒤따라 끝납니다.
        expect(await appExit).toBe(0);
        expect(await watchdogExit).toBe(0);
    }, 15_000);
});
