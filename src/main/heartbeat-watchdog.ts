/**
 * 메인 프로세스가 멈췄는지 지켜보는 별도 프로세스(Electron utilityProcess)입니다. Windows에서 씁니다.
 * 메인 프로세스가 무한 반복 등에 빠지면 앱 안의 안전장치가 돌지 못하므로, 메인 프로세스의 생존 신호가 오래 끊기면
 * 메인 프로세스를 끝냅니다. Windows는 메인 프로세스가 끝나면 하위 프로세스도 함께 끝납니다.
 */
import {HEARTBEAT_MISSES, HEARTBEAT_MS, HeartbeatMonitor} from "./safety";

const monitor = new HeartbeatMonitor(HEARTBEAT_MISSES);
let mainPid = 0;

process.parentPort.on("message", (event) => {
    const data = event.data as {pid?: unknown} | undefined;
    if (typeof data?.pid === "number") mainPid = data.pid;
    monitor.beat();
});

setInterval(() => {
    if (!monitor.tick() || mainPid === 0) return;
    try {
        process.kill(mainPid, "SIGKILL");
    } catch {
        // 이미 끝났습니다.
    }
    process.exit(0);
}, HEARTBEAT_MS);
