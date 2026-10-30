import {app} from "electron";
import type {UpdateState} from "@shared/types";
import type {AppUpdater} from "electron-updater";

/** 이 앱의 GitHub 저장소입니다. 릴리스를 확인하고, 기본 브라우저로 열어도 되는 주소를 가릴 때 씁니다. */
export const REPO_PATH = "/1window2/Hamboogie";
const RELEASES_API = `https://api.github.com/repos${REPO_PATH}/releases/latest`;
const RELEASES_PAGE = `https://github.com${REPO_PATH}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** "1.10.0" > "1.9.2"처럼 버전을 숫자로 비교합니다. 앞의 v는 무시합니다. */
export function isNewerVersion(candidate: string, current: string): boolean {
    const parse = (version: string) => version.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
    const a = parse(candidate);
    const b = parse(current);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}

export interface Updater {
    state(): UpdateState;
    /** 받아 둔 업데이트를 설치하고 앱을 다시 켭니다. Windows 전용입니다. */
    install(): void;
}

/**
 * 새 버전을 확인합니다. 배포 빌드에서만 동작합니다.
 *
 * - Windows: `startWindowsUpdater`를 봅니다.
 * - macOS: 서명되지 않은 앱은 자동 설치를 할 수 없어서, 최신 릴리스를 확인해 다운로드 페이지만 알려줍니다.
 */
export function startUpdater(onChange: (state: UpdateState) => void, beforeInstall: () => void): Updater {
    let current: UpdateState = {state: "idle"};
    const set = (next: UpdateState) => {
        current = next;
        onChange(next);
    };
    // electron-updater는 Windows 배포 빌드에서만 불러옵니다. macOS와 개발 모드에서는 쓰지 않아 싣지 않습니다.
    let windowsUpdater: Promise<AppUpdater> | null = null;
    const updater: Updater = {
        state: () => current,
        install: () => {
            if (current.state !== "ready" || !windowsUpdater) return;
            beforeInstall();
            void windowsUpdater.then((autoUpdater) => autoUpdater.quitAndInstall());
        }
    };
    if (!app.isPackaged) return updater;

    if (process.platform === "win32") {
        // CommonJS 모듈이라 ESM에서 불러오면 default 아래에 들어 있습니다.
        windowsUpdater = import("electron-updater").then((module) => module.default.autoUpdater);
        windowsUpdater
            .then((autoUpdater) => startWindowsUpdater(autoUpdater, () => current, set))
            .catch((error: unknown) => set({state: "error", message: String(error)}));
        return updater;
    }

    const check = async () => {
        try {
            const response = await fetch(RELEASES_API, {headers: {Accept: "application/vnd.github+json"}});
            if (!response.ok) return;
            const release = await response.json() as {tag_name?: string; html_url?: string};
            if (release.tag_name && isNewerVersion(release.tag_name, app.getVersion())) {
                // 응답에 담긴 주소는 이 저장소의 릴리스 페이지일 때만 씁니다.
                const url = release.html_url?.startsWith(`https://github.com${REPO_PATH}/releases/`) ? release.html_url : RELEASES_PAGE;
                set({state: "available", version: release.tag_name.replace(/^v/, ""), url});
            }
        } catch {
            // 확인에 실패해도 다음 주기에 다시 봅니다.
        }
    };
    void check();
    setInterval(() => void check(), CHECK_INTERVAL_MS);
    return updater;
}

/** Windows: GitHub Release의 latest.yml로 새 버전을 백그라운드에서 받아 두고, 재시작하거나 종료할 때 설치합니다. */
function startWindowsUpdater(
    autoUpdater: AppUpdater,
    current: () => UpdateState,
    set: (next: UpdateState) => void
): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // 받아 둔 업데이트가 있으면, 다음 확인에서 오류가 나거나 같은 버전을 다시 받더라도 설치 버튼을 계속 보여 줍니다.
    const update = (next: UpdateState) => {
        if (current().state === "ready" && next.state !== "ready") return;
        set(next);
    };
    autoUpdater.on("update-available", (info) => update({state: "downloading", version: info.version, percent: 0}));
    autoUpdater.on("download-progress", (progress) => {
        const now = current();
        const percent = Math.round(progress.percent);
        if (now.state === "downloading" && now.percent !== percent) set({...now, percent});
    });
    autoUpdater.on("update-downloaded", (info) => set({state: "ready", version: info.version}));
    autoUpdater.on("error", (error) => update({state: "error", message: error.message}));
    const check = () => void autoUpdater.checkForUpdates().catch((error: unknown) => update({state: "error", message: String(error)}));
    check();
    setInterval(check, CHECK_INTERVAL_MS);
}
