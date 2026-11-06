import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {dirname} from "node:path";

/**
 * 앱이 컴퓨터를 붙잡지 않게 하는 안전장치입니다. 실행 중인 dmg를 꺼내 실행 파일이 사라진 앱이 CPU 코어 여러 개를
 * 40분 넘게 쓰며 다른 작업을 멈추게 한 적이 있어, 어떤 경우에도 앱이 스스로 끝나도록 여러 겹으로 둡니다.
 * - 종료 신호(SIGTERM 등)를 받으면 정상 종료하고, 어떤 경로로 끄든 정해진 시간 안에 안 꺼지면 바로 끝냅니다.
 * - 앱 안에서 CPU 사용률과 실행 파일을 주기적으로 확인합니다.
 * - macOS·Linux는 앱 밖에 작은 감시 프로세스를 두어, 앱이 멈춰 앱 안의 확인이 돌지 못해도 끝냅니다.
 */

/** 끄기 시작한 뒤 이 시간 안에 꺼지지 않으면 저장을 기다리지 않고 바로 끝냅니다. */
export const QUIT_DEADLINE_MS = 5000;

/** CPU 사용률을 확인하는 간격입니다. */
export const CPU_CHECK_MS = 5000;

/**
 * 앱 전체(모든 프로세스) CPU 사용률이 이 값(코어 하나 = 100)을 넘는 상태가 `CPU_OVER_CHECKS`번 이어지면 끝냅니다.
 * 이 앱은 평소 거의 쉬고 있고 사진을 줄일 때도 1초 안에 끝나므로, 코어 두 개를 1분 동안 쓰는 일은 고장일 때뿐입니다.
 */
export const CPU_LIMIT_PERCENT = 200;
export const CPU_OVER_CHECKS = 12;

/** CPU 사용률을 이어서 보고, 한도를 넘는 상태가 계속되는지 판단합니다. */
export class CpuGuard {
    private over = 0;

    constructor(private readonly limit = CPU_LIMIT_PERCENT, private readonly checks = CPU_OVER_CHECKS) {}

    /** 이번에 잰 사용률을 넣습니다. 한도를 넘는 상태가 정한 횟수만큼 이어졌으면 true입니다. */
    record(percent: number): boolean {
        this.over = Number.isFinite(percent) && percent > this.limit ? this.over + 1 : 0;
        return this.over >= this.checks;
    }
}

/** 종료 신호를 받으면 `quit`을 부릅니다. Electron은 이 신호를 받아도 앱을 끄지 않아, 직접 받아 정상 종료합니다. */
export function handleQuitSignals(quit: (signal: NodeJS.Signals) => void): void {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => quit(signal));
}

/** 처음 부를 때 타이머를 걸어, `ms` 안에 앱이 끝나지 않으면 `exit`을 부릅니다. 여러 번 불러도 타이머는 하나입니다. */
export function quitDeadline(exit: () => void, ms = QUIT_DEADLINE_MS): () => void {
    let started = false;
    return () => {
        if (started) return;
        started = true;
        setTimeout(exit, ms).unref();
    };
}

export interface CpuWatchOptions {
    /** 앱 전체 CPU 사용률(코어 하나 = 100)입니다. */
    cpuPercent(): number;
    /** CPU를 오래 많이 써서 끌 때 부릅니다. */
    onRunaway(percent: number): void;
    /** 실행 파일이 사라졌을 때 부릅니다. */
    onExecutableGone(): void;
    executable?: string;
    exists?: (path: string) => boolean;
    intervalMs?: number;
    guard?: CpuGuard;
}

/** 앱 안에서 CPU 사용률과 실행 파일을 주기적으로 확인합니다. 멈추는 함수를 돌려줍니다. */
export function watchCpu(options: CpuWatchOptions): () => void {
    const {cpuPercent, onRunaway, onExecutableGone, executable = process.execPath, exists = existsSync, intervalMs = CPU_CHECK_MS} = options;
    const guard = options.guard ?? new CpuGuard();
    let tripped = false;
    const timer = setInterval(() => {
        if (tripped) return;
        if (!exists(executable)) {
            tripped = true;
            onExecutableGone();
            return;
        }
        const percent = cpuPercent();
        if (guard.record(percent)) {
            tripped = true;
            onRunaway(percent);
        }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

/** 앱 밖 감시 프로세스가 확인하는 간격(초)입니다. 실행 파일이 사라지면 곧바로 CPU를 붙잡으므로 짧게 둡니다. */
export const WATCHDOG_CHECK_SECONDS = 2;

/**
 * 앱 밖 감시 프로세스가 돌리는 셸 스크립트입니다.
 * 인자: 앱 pid, 실행 파일 경로, 앱 폴더(macOS는 .app 번들), CPU 한도(%), 이어진 횟수, 확인 간격(초), 종료 유예(초).
 * 앱과 하위 프로세스의 CPU 합이 한도를 넘는 상태가 이어지면 종료 신호를 보내고, 유예 시간 뒤에도 살아 있으면 하위 프로세스까지
 * 강제로 끝냅니다. 실행 파일이 사라졌으면 앱이 정상 종료할 수 없으므로 1초만 기다린 뒤 앱 폴더에서 나온 프로세스를 모두 끝냅니다.
 * 앱이 어떻게 끝났든(스스로 죽은 경우 포함) 끝나기 전에, 앱 폴더에서 나와 고아로 남은 하위 프로세스(Electron의 --type= 프로세스)를
 * 정리합니다. 메인 프로세스만 죽고 하위 프로세스가 남아 CPU를 붙잡는 일이 있었기 때문입니다.
 * 시스템 기본 명령(sh, ps, awk, kill, sleep)만 씁니다.
 */
export const WATCHDOG_SCRIPT = `
pid=$1; exe=$2; root=$3; limit=$4; need=$5; gap=$6; grace=$7; over=0
# 이 감시 프로세스는 앱의 하위 프로세스이고 명령줄에 앱 폴더 경로도 들어 있으므로, 대상을 고를 때 자기 자신($$)은 뺍니다.
children() { ps -A -o pid= -o ppid= | awk -v p="$pid" -v me="$$" '$1 != me && $2 == p { print $1 }'; }
from_root() { ps -A -o pid= -o command= | awk -v r="$root/" -v me="$$" '$1 != me && index($0, r) { print $1 }'; }
orphans() { ps -A -o pid= -o ppid= -o command= | awk -v r="$root/" -v me="$$" '$1 != me && $2 == 1 && index($0, r) && index($0, "--type=") { print $1 }'; }
cleanup() {
  [ -e "$exe" ] || kill -KILL $(from_root) 2>/dev/null
  sleep 2
  kill -KILL $(orphans) 2>/dev/null
  [ -e "$exe" ] || kill -KILL $(from_root) 2>/dev/null
  exit 0
}
stop() {
  kids=$(children)
  kill -TERM "$pid" $kids 2>/dev/null
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$1" ]; do sleep 1; waited=$((waited + 1)); done
  kill -KILL "$pid" $kids $(children) 2>/dev/null
  cleanup
}
while kill -0 "$pid" 2>/dev/null; do
  [ -e "$exe" ] || stop 1
  total=$(ps -A -o pid= -o ppid= -o %cpu= | awk -v p="$pid" '$1 == p || $2 == p { s += $3 } END { printf "%d", s }')
  if [ "\${total:-0}" -gt "$limit" ]; then over=$((over + 1)); else over=0; fi
  [ "$over" -ge "$need" ] && stop "$grace"
  sleep "$gap"
done
cleanup
`;

/** 앱 폴더입니다. macOS는 실행 파일이 든 .app 번들, 그 밖에는 실행 파일이 든 폴더입니다. */
export function appRoot(executable: string): string {
    const bundle = executable.lastIndexOf(".app/");
    return bundle === -1 ? dirname(executable) : executable.slice(0, bundle + 4);
}

/**
 * 앱 밖 감시 프로세스를 띄웁니다(macOS·Linux). 앱이 멈춰 앱 안의 확인이 돌지 못해도 앱을 끝낼 수 있게 하기 위해서입니다.
 * 감시 프로세스는 시스템 셸로 돌아 앱 파일(dmg 등)이 사라져도 영향을 받지 않고, 작업 폴더를 /로 두어 dmg를 꺼내는 것을 막지 않습니다.
 * 앱이 끝나면 다음 확인 때 스스로 끝납니다.
 */
export function startWatchdog(pid = process.pid, executable = process.execPath): void {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    // CPU 한도는 앱 안의 확인과 같은 시간(1분) 동안 이어질 때 끕니다.
    const need = Math.ceil((CPU_CHECK_MS * CPU_OVER_CHECKS) / 1000 / WATCHDOG_CHECK_SECONDS);
    try {
        const child = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "hamboogie-watchdog", String(pid), executable, appRoot(executable),
            String(CPU_LIMIT_PERCENT), String(need), String(WATCHDOG_CHECK_SECONDS), String(QUIT_DEADLINE_MS / 1000)], {cwd: "/", stdio: "ignore"});
        child.on("error", () => {});
        child.unref();
    } catch {
        // 감시 프로세스를 띄우지 못해도 앱 안의 확인은 그대로 돕니다.
    }
}
