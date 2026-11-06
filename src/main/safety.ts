import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {dirname} from "node:path";

/**
 * 앱이 컴퓨터를 붙잡지 않게 하는 안전장치입니다. 실행 중인 dmg를 꺼내 실행 파일이 사라진 앱이 CPU 코어 여러 개를
 * 40분 넘게 쓰며 다른 작업을 멈추게 한 적이 있어, 어떤 경우에도 앱이 스스로 끝나도록 여러 겹으로 둡니다.
 * - 종료 신호(SIGTERM 등)를 받으면 정상 종료하고, 어떤 경로로 끄든 정해진 시간 안에 안 꺼지면 바로 끝냅니다.
 * - 앱 안에서 CPU 사용률과 실행 파일을 주기적으로 확인합니다.
 * - macOS·Linux는 앱 밖에 작은 감시 프로세스(셸)를 두어, 앱이 멈춰 앱 안의 확인이 돌지 못하거나 실행 파일이 사라져도 끝냅니다.
 *   Windows는 실행 중인 실행 파일이 사라질 수 없으므로, 메인 프로세스가 멈추면 끝내는 감시 프로세스(`heartbeat-watchdog`)만 둡니다.
 */

/** 끄기 시작한 뒤 이 시간 안에 꺼지지 않으면 저장을 기다리지 않고 바로 끝냅니다. */
export const QUIT_DEADLINE_MS = 5000;

/** CPU 사용률을 확인하는 간격입니다. */
export const CPU_CHECK_MS = 5000;

/**
 * 앱 전체(모든 프로세스) CPU 사용률이 이 값(코어 하나 = 100)을 넘는 상태가 `CPU_OVER_CHECKS`번(1분) 이어지면 끝냅니다.
 * 이 앱은 평소 거의 쉬고 있고 사진을 줄일 때도 1초 안에 끝나므로, 코어 두 개를 1분 동안 쓰는 일은 고장일 때뿐입니다.
 */
export const CPU_LIMIT_PERCENT = 200;
export const CPU_OVER_CHECKS = 12;

/** 프로세스 하나가 코어 하나를 이만큼(%) 넘게 쓰는 상태가 `PROCESS_OVER_CHECKS`번(10분) 이어져도 끝냅니다(무한 반복에 빠진 화면 등). */
export const PROCESS_LIMIT_PERCENT = 90;
export const PROCESS_OVER_CHECKS = 120;

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

/** 프로세스 하나가 시작한 뒤 쓴 CPU 시간(초)입니다. */
export interface ProcessCpu {
    pid: number;
    seconds: number;
}

/**
 * 프로세스별 누적 CPU 시간의 차이로 사용률(코어 하나 = 100)을 잽니다. Electron의 `percentCPUUsage`는 코어 수로 나눈 값이라
 * 코어가 많으면 크게 줄어 보이므로 쓰지 않습니다. 처음 보는 프로세스는 다음 측정부터 셉니다.
 */
export class CpuMeter {
    private last = new Map<number, {seconds: number; at: number}>();

    /** 앱 전체 합과 가장 많이 쓴 프로세스 하나의 사용률입니다. */
    measure(processes: ProcessCpu[], now: number): {total: number; max: number} {
        let total = 0;
        let max = 0;
        const next = new Map<number, {seconds: number; at: number}>();
        for (const {pid, seconds} of processes) {
            next.set(pid, {seconds, at: now});
            const before = this.last.get(pid);
            if (!before || now <= before.at || seconds < before.seconds) continue;
            const percent = ((seconds - before.seconds) / ((now - before.at) / 1000)) * 100;
            total += percent;
            max = Math.max(max, percent);
        }
        this.last = next;
        return {total, max};
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
    /** 앱의 모든 프로세스가 지금까지 쓴 CPU 시간입니다. */
    sample(): ProcessCpu[];
    /** CPU를 오래 많이 써서 끌 때 부릅니다. `percent`는 한도를 넘은 사용률(코어 하나 = 100)입니다. */
    onRunaway(percent: number, scope: "app" | "process"): void;
    /** 실행 파일이 사라졌을 때 부릅니다. */
    onExecutableGone(): void;
    executable?: string;
    exists?: (path: string) => boolean;
    now?: () => number;
    intervalMs?: number;
    appGuard?: CpuGuard;
    processGuard?: CpuGuard;
}

/** 앱 안에서 CPU 사용률과 실행 파일을 주기적으로 확인합니다. 멈추는 함수를 돌려줍니다. */
export function watchCpu(options: CpuWatchOptions): () => void {
    const {sample, onRunaway, onExecutableGone, executable = process.execPath, exists = existsSync, now = Date.now, intervalMs = CPU_CHECK_MS} = options;
    const appGuard = options.appGuard ?? new CpuGuard();
    const processGuard = options.processGuard ?? new CpuGuard(PROCESS_LIMIT_PERCENT, PROCESS_OVER_CHECKS);
    const meter = new CpuMeter();
    let tripped = false;
    const check = () => {
        if (tripped) return;
        if (!exists(executable)) {
            tripped = true;
            onExecutableGone();
            return;
        }
        const {total, max} = meter.measure(sample(), now());
        // 두 판단 모두 이번 값을 넣어야 이어진 횟수가 맞으므로 둘 다 먼저 기록합니다.
        const appOver = appGuard.record(total);
        const processOver = processGuard.record(max);
        if (appOver || processOver) {
            tripped = true;
            onRunaway(appOver ? total : max, appOver ? "app" : "process");
        }
    };
    check();
    const timer = setInterval(check, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

/**
 * 메인 프로세스의 생존 신호를 세는 판단입니다. 정해진 간격마다 `tick`을 부르고, 그사이 `beat`가 한 번도 없었던 간격이
 * `limit`번 이어지면 메인 프로세스가 멈춘 것으로 봅니다. 시각이 아니라 간격 수로 세어, 컴퓨터가 잠들었다 깨어나도 잘못 판단하지 않습니다.
 */
export class HeartbeatMonitor {
    private beaten = true;
    private missed = 0;

    constructor(private readonly limit: number) {}

    beat(): void {
        this.beaten = true;
    }

    /** 간격 하나가 지났습니다. 멈춘 것으로 볼 때가 되면 true입니다. */
    tick(): boolean {
        this.missed = this.beaten ? 0 : this.missed + 1;
        this.beaten = false;
        return this.missed >= this.limit;
    }
}

/** 메인 프로세스가 생존 신호를 보내는 간격과, 신호가 끊긴 채 이만큼(5분) 지나면 멈춘 것으로 보는 간격 수입니다. */
export const HEARTBEAT_MS = 5000;
export const HEARTBEAT_MISSES = 60;

/** 앱 밖 감시 프로세스가 확인하는 간격(초)입니다. 실행 파일이 사라지면 곧바로 CPU를 붙잡으므로 짧게 둡니다. */
export const WATCHDOG_CHECK_SECONDS = 2;

/**
 * 앱 밖 감시 프로세스가 돌리는 셸 스크립트입니다.
 * 인자: 앱 pid, 실행 파일 경로, 앱 폴더(macOS는 .app 번들), 앱 전체 CPU 한도(%)와 이어진 횟수, 프로세스 하나의 CPU 한도(%)와 이어진 횟수,
 * 확인 간격(초), 종료 유예(초).
 * - 앱과 하위 프로세스의 CPU 합이나 프로세스 하나의 CPU가 한도를 넘는 상태가 이어지면 종료 신호를 보내고, 유예 시간 뒤에도 살아 있으면
 *   하위 프로세스까지 강제로 끝냅니다. 앱이 멈춰 앱 안의 확인이 돌지 못하는 경우도 이것으로 끝냅니다.
 * - 실행 파일이 사라졌으면(실행 중인 dmg를 꺼냄 등) 같은 방법으로 끝내고, 앱 폴더에서 실행된 프로세스를 모두 끝냅니다.
 * - 앱이 어떻게 끝났든(스스로 죽은 경우 포함) 끝나기 전에, 앱 폴더에서 실행되어 고아로 남은 하위 프로세스(Electron의 --type= 프로세스)를
 *   정리합니다. 메인 프로세스만 죽고 하위 프로세스가 남아 CPU를 붙잡은 일이 있었기 때문입니다.
 * - 터미널에서 실행한 앱의 Ctrl+C나 터미널 닫기에 함께 끝나지 않습니다(그 신호를 앱이 받지 못할 만큼 멈췄을 수 있어서입니다).
 * 시스템 기본 명령(sh, ps, pgrep, awk, kill, sleep)만 씁니다.
 */
export const WATCHDOG_SCRIPT = `
trap '' INT HUP
pid=$1; exe=$2; root=$3; limit=$4; need=$5; plimit=$6; pneed=$7; gap=$8; grace=$9; over=0; pover=0
# 이 감시 프로세스도 앱의 하위 프로세스이므로 하위 프로세스를 고를 때 자기 자신($$)은 뺍니다.
children() { ps -A -o pid= -o ppid= | awk -v p="$pid" -v me="$$" '$1 != me && $2 == p { print $1 }'; }
# 명령줄이 앱 폴더 경로로 시작하는 프로세스만 고릅니다(이 감시 프로세스, 그 경로를 인자로 받은 다른 프로그램은 빠집니다).
from_root() { ps -A -o pid= -o command= | awk -v r="$root/" '{ p = $1; sub(/^ *[0-9]+ +/, ""); if (index($0, r) == 1) print p }'; }
orphans() { ps -A -o pid= -o ppid= -o command= | awk -v r="$root/" '$2 == 1 { p = $1; sub(/^ *[0-9]+ +[0-9]+ +/, ""); if (index($0, r) == 1 && index($0, "--type=")) print p }'; }
# 앱이 살아 있는지입니다. 끝났지만 부모가 거두지 않은 프로세스(zombie)는 끝난 것으로 봅니다.
alive() { st=$(ps -o stat= -p "$pid" 2>/dev/null); case "$st" in ""|*Z*) return 1 ;; esac; return 0; }
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
  while alive && [ "$waited" -lt "$grace" ]; do sleep 1; waited=$((waited + 1)); done
  kill -KILL "$pid" $kids $(children) 2>/dev/null
  cleanup
}
while alive; do
  [ -e "$exe" ] || stop
  list=$(pgrep -d, -P "$pid")
  usage=$(ps -o %cpu= -p "$pid\${list:+,$list}" | awk '{ s += $1; if ($1 > m) m = $1 } END { printf "%d %d", s, m }')
  total=\${usage% *}; most=\${usage#* }
  if [ "\${total:-0}" -gt "$limit" ]; then over=$((over + 1)); else over=0; fi
  if [ "\${most:-0}" -gt "$plimit" ]; then pover=$((pover + 1)); else pover=0; fi
  [ "$over" -ge "$need" ] && stop
  [ "$pover" -ge "$pneed" ] && stop
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
    // 한도를 넘는 상태가 앱 안의 확인과 같은 시간(1분, 10분) 동안 이어질 때 끕니다.
    const checks = (count: number) => String(Math.ceil((CPU_CHECK_MS * count) / 1000 / WATCHDOG_CHECK_SECONDS));
    try {
        const child = spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "hamboogie-watchdog", String(pid), executable, appRoot(executable),
            String(CPU_LIMIT_PERCENT), checks(CPU_OVER_CHECKS), String(PROCESS_LIMIT_PERCENT), checks(PROCESS_OVER_CHECKS),
            String(WATCHDOG_CHECK_SECONDS), String(QUIT_DEADLINE_MS / 1000)], {cwd: "/", stdio: "ignore"});
        child.on("error", () => {});
        child.unref();
    } catch {
        // 감시 프로세스를 띄우지 못해도 앱 안의 확인은 그대로 돕니다.
    }
}
