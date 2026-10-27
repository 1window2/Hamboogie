import {copyFileSync, existsSync, mkdirSync} from "node:fs";
import {join} from "node:path";
import {app, BrowserWindow, dialog, ipcMain, nativeImage, net, Notification, powerMonitor, powerSaveBlocker, shell, type IpcMainInvokeEvent} from "electron";
import {PROVIDERS} from "@shared/settings";
import type {AccountConfig, AppState, DcconPackage, SecretKey, Settings} from "@shared/types";
import type {DCInside, DeviceCredentials} from "@green-1052/dcinside.js";
import {AccountManager} from "./dc/accounts";
import {AppIdBackoff} from "./dc/app-id-backoff";
import {checkGallery} from "./dc/gallery-check";
import {Logger} from "./logger";
import {sendDiscordNotice} from "./notify/discord";
import {Engine} from "./pipeline/engine";
import {LlmUsage} from "./llm/usage";
import {flushAllJson, HistoryStore, JudgmentLog, Ledger, SecretStore, SettingsStore, UsageStore} from "./store";
import {createTray} from "./tray";
import {startUpdater, type Updater} from "./updater";
import {errorMessage} from "@shared/errors";
import {DcconImages} from "./dc/dccon-images";
import {loadPostImages, type ShrinkImage} from "./dc/post-images";

/** 앱 화면에서 온 IPC만 받는 등록 함수입니다. */
export type TrustedHandle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void;

/** 두 주소의 출처(프로토콜, 호스트, 포트)가 같은지 봅니다. 앞부분만 비교하면 `localhost:51730`이 `localhost:5173`을 통과합니다. */
function sameOrigin(a: string, b: string): boolean {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

/** 기본 브라우저로 열어도 되는 주소입니다: 디시 글과 갤러리, 이 저장소의 GitHub 페이지. */
function isAllowedExternalUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:") return false;
        if (/(^|\.)dcinside\.com$/.test(url.hostname)) return true;
        return url.hostname === "github.com" && url.pathname.startsWith("/1window2/Hamboogie/");
    } catch {
        return false;
    }
}

/** LLM에 보낼 사진의 긴 변(px)입니다. 캡처 속 글자는 읽히면서 토큰은 너무 많이 쓰지 않는 크기입니다. */
const POST_IMAGE_EDGE = 1024;

/** 사진을 긴 변 기준으로 줄여 JPEG로 바꿉니다. Electron이 읽지 못하는 형식(움직이는 GIF 등 일부)은 빠집니다. */
const shrinkImage: ShrinkImage = (bytes) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return null;
    const {width, height} = image.getSize();
    const scale = Math.min(1, POST_IMAGE_EDGE / Math.max(width, height));
    const resized = scale < 1 ? image.resize({width: Math.round(width * scale), height: Math.round(height * scale), quality: "good"}) : image;
    return {mimeType: "image/jpeg", data: resized.toJPEG(80).toString("base64")};
};

async function main(): Promise<void> {
    // 개발 모드 오프라인(npm run dev:offline): 디시 대신 가짜 클라이언트를 쓰고, 진짜 기록을 더럽히지 않도록
    // 데이터 폴더를 따로 씁니다. 설정과 API 키만 처음 한 번 복사해 옵니다. 배포 빌드에서는 이 분기가 빠집니다.
    const offline = import.meta.env.DEV && process.argv.includes("--offline");
    if (offline) {
        const realDir = app.getPath("userData");
        const offlineDir = join(realDir, "offline");
        mkdirSync(offlineDir, {recursive: true});
        for (const file of ["settings.json", "secrets.json"]) {
            if (!existsSync(join(offlineDir, file)) && existsSync(join(realDir, file))) copyFileSync(join(realDir, file), join(offlineDir, file));
        }
        app.setPath("userData", offlineDir);
    }
    // 앱이 두 개 뜨면 감시 엔진도 두 개가 되어 같은 글에 댓글이 두 번 달릴 수 있으므로 하나만 실행합니다.
    // 데이터 폴더 단위로 잠그므로, 오프라인 모드(별도 폴더)는 일반 실행과 함께 켤 수 있습니다.
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    // Windows는 앱 식별자를 정해야 알림(트레이 안내 등)이 제대로 뜹니다. electron-builder의 appId와 같게 둡니다.
    if (process.platform === "win32") app.setAppUserModelId("io.github.1window2.hamboogie");
    await app.whenReady();
    // 개발 모드에서는 Dock에 Electron 기본 아이콘 대신 앱 아이콘을 보여줍니다. 배포 빌드는 설치 파일의 아이콘을 씁니다.
    if (import.meta.env.DEV && process.platform === "darwin") app.dock?.setIcon(join(app.getAppPath(), "build/icon.png"));
    const dataDir = app.getPath("userData");
    const logger = new Logger(join(dataDir, "hamboogie.log"));
    const settingsStore = new SettingsStore(dataDir);
    const secrets = new SecretStore(dataDir);
    const ledger = new Ledger(dataDir);
    const history = new HistoryStore(dataDir);
    const usageStore = new UsageStore(dataDir);
    const judgments = new JudgmentLog(dataDir);
    let fakeClient: ((credentials?: DeviceCredentials) => DCInside) | undefined;
    if (offline) {
        const {blockDcinsideRequests, createFakeClientFactory} = await import("./dev/offline");
        blockDcinsideRequests((host) => logger.error(`오프라인 모드에서 디시 요청을 막았습니다: ${host}`));
        fakeClient = createFakeClientFactory((message) => logger.info(`[오프라인] ${message}`));
        logger.warn("오프라인 모드입니다. 디시 대신 가짜 글과 가짜 계정을 씁니다.");
    }
    // app_id 발급 거절은 IP 단위라 읽기용 클라이언트와 계정들이 대기 상태를 함께 씁니다.
    const appId = new AppIdBackoff();
    const accounts = new AccountManager(secrets, fakeClient, appId);
    // 글은 로그인된 계정으로만 읽습니다. 로그인된 계정이 없으면 디시에 요청하지 않습니다.
    // 갤러리마다 그 갤러리의 대기 계정으로만 읽습니다(테스트용 계정만 쓰는 갤러리를 메인 계정으로 읽지 않게).
    const readingAccount = (accountIds: string[]) => accounts.readingClient(settingsStore.get().accounts, accountIds);
    const engine = new Engine({
        reader: (gallery) => readingAccount(gallery.accountIds)?.client ?? null,
        onReaderLoginExpired: async (client, reason) => {
            // 그사이 이미 다른 이유로 내려놓은 계정이면 할 일이 없습니다.
            const accountId = accounts.accountOf(client);
            if (!accountId) return "none";
            const outcome = await accounts.recoverLogin(accountId, reason) ? "recovered" : accounts.isRetrying(accountId) ? "retrying" : "expired";
            tray?.update();
            return outcome;
        },
        resetReader: async (gallery) => {
            const account = readingAccount(gallery.accountIds);
            if (account) await accounts.refreshDevice(account.accountId);
        },
        appId,
        accounts,
        ledger,
        history,
        secrets,
        logger,
        settings: () => settingsStore.get(),
        onStateChanged: () => pushState(),
        // 인터페이스가 켜져 있는지만이 아니라 실제로 인터넷에 닿는지 봅니다. 디시가 아닌 연결 확인용 주소를 씁니다.
        // 연결 확인용 주소 두 곳 중 하나라도 응답하면 연결된 것으로 봅니다(한 곳이 막힌 망 대비).
        checkNetwork: async () => {
            if (!net.isOnline()) return false;
            const probe = (url: string) => fetch(url, {signal: AbortSignal.timeout(5000)})
                .then((response) => (response.status === 204 ? true : Promise.reject(new Error(String(response.status)))));
            return Promise.any([probe("https://www.gstatic.com/generate_204"), probe("https://cp.cloudflare.com/generate_204")]).catch(() => false);
        },
        desktopNotice: (title, body) => {
            if (Notification.isSupported()) new Notification({title, body}).show();
        },
        recordJudgment: (record) => judgments.append(record),
        postImages: (urls) => loadPostImages(urls, shrinkImage),
        usage: new LlmUsage(() => usageStore.load(), (record) => {
            usageStore.save(record);
            pushState();
        })
    });

    let window: BrowserWindow | null = null;

    function state(): AppState {
        const settings = settingsStore.get();
        const secretsSet: AppState["secretsSet"] = {};
        for (const provider of PROVIDERS) secretsSet[`llm:${provider}`] = secrets.has(`llm:${provider}`);
        return {
            settings,
            accounts: settings.accounts.map((account) => ({
                ...account,
                hasPassword: secrets.has(`account:${account.id}`),
                status: accounts.status(account.id)
            })),
            secretsSet,
            running: engine.running,
            watching: engine.watching,
            galleryStatus: engine.galleryStatus(),
            version: app.getVersion(),
            offline,
            llmUsage: engine.llmUsage(),
            autoStopAt: engine.autoStopAt,
            update: updater?.state() ?? {state: "idle"}
        };
    }

    let tray: {update(): void} | null = null;
    let updater: Updater | null = null;

    // 감시하는 동안에는 자리를 비워도 컴퓨터가 저절로 잠들지 않게 합니다(잠들면 감시가 멈춥니다).
    // 화면은 꺼져도 됩니다. 노트북 덮개를 닫아 잠드는 것은 막을 수 없습니다.
    let sleepBlocker: number | null = null;
    function syncSleepBlocker(): void {
        if (engine.running && sleepBlocker === null) {
            sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
        } else if (!engine.running && sleepBlocker !== null) {
            powerSaveBlocker.stop(sleepBlocker);
            sleepBlocker = null;
        }
    }

    // 잠들면 확인을 멈추고, 깨어나면 네트워크가 붙은 뒤에 이어갑니다(5분 넘게 잤으면 그사이 글은 버림, 1분 안에 네트워크가 없으면 감시 중지).
    powerMonitor.on("suspend", () => {
        engine.suspend();
        pushState();
    });
    // 깨어남 신호가 빠지는 경우에 대비해, 화면 잠금을 풀거나 사용자가 돌아왔을 때도 깨어난 것으로 봅니다(이미 이어가는 중이면 무시).
    for (const event of ["resume", "unlock-screen", "user-did-become-active"] as const) {
        powerMonitor.on(event as "resume", () => void engine.resume().finally(() => pushState()));
    }

    function pushState(): void {
        syncSleepBlocker();
        window?.webContents.send("state", state());
        tray?.update();
    }

    logger.subscribe((entry) => window?.webContents.send("log", entry));
    history.subscribe((entry) => window?.webContents.send("history", entry));

    // 앱 화면(개발 서버 또는 앱에 들어 있는 index.html)에서 온 요청만 받습니다.
    // 창이 다른 페이지로 넘어가는 것은 아래에서 막지만, 혹시 다른 페이지가 preload API를 쓰려 해도 거절합니다.
    // 배포 빌드는 환경 변수로 다른 페이지를 띄울 수 없게, 개발 서버 주소를 개발 모드에서만 씁니다.
    const rendererUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
    const fromApp = (event: IpcMainInvokeEvent): boolean => {
        const url = event.senderFrame?.url ?? "";
        return rendererUrl ? sameOrigin(url, rendererUrl) : url.startsWith("file://") && url.includes("/renderer/index.html");
    };
    const handle: TrustedHandle = (channel, listener) => {
        ipcMain.handle(channel, (event, ...args) => {
            if (!fromApp(event)) throw new Error("허용되지 않은 화면에서 온 요청입니다.");
            return listener(event, ...args);
        });
    };

    // 개발 모드 전용 테스트 실행입니다. 배포 빌드에서는 이 분기와 모듈이 통째로 빠집니다.
    if (import.meta.env.DEV) {
        const {registerDevTestIpc} = await import("./dev/test-run");
        registerDevTestIpc({engine, accounts, logger, settings: () => settingsStore.get()}, handle);
    }

    handle("getState", () => state());
    handle("getLogs", () => logger.recent());
    handle("getHistory", () => history.all());
    handle("installUpdate", () => updater?.install());
    handle("saveSettings", async (_event, next: Settings) => {
        const before = settingsStore.get().accounts;
        // 먼저 저장해 봅니다. 저장이 실패하면 지운 계정의 비밀번호도 지우지 않습니다.
        await settingsStore.save(next);
        const saved = settingsStore.get().accounts;
        for (const account of before) {
            const after = saved.find((item) => item.id === account.id);
            if (!after) await accounts.remove(account.id);
            // 로그인된 계정의 아이디를 바꿨으면 예전 아이디의 세션을 버립니다(다시 로그인해야 새 아이디로 쓰입니다).
            else if (after.loginId !== account.loginId) accounts.logout(account.id);
        }
        engine.syncGalleries();
        engine.refreshAutoStop();
        pushState();
        return state();
    });
    handle("setSecret", async (_event, key: SecretKey, value: string) => {
        const valid = PROVIDERS.some((provider) => key === `llm:${provider}`)
            || (key.startsWith("account:") && settingsStore.get().accounts.some((account) => key === `account:${account.id}`));
        if (!valid) throw new Error("알 수 없는 항목입니다.");
        await secrets.set(key, value);
        return state();
    });
    async function loginAccount(account: AccountConfig, otp?: string): Promise<void> {
        const pending = accounts.login(account, otp);
        pushState();
        const status = await pending;
        if (status.state === "logged_in") {
            logger.success(`${status.nickname} (${account.loginId}) 로그인 성공`);
            if (status.dcconError) logger.warn(`${account.loginId} 보유 디시콘을 불러오지 못했습니다: ${status.dcconError}`);
        }
        else if (status.state === "otp_required") logger.warn(`${account.loginId} ${status.message}`);
        else if (status.state === "error") logger.error(`${account.loginId} ${status.message}`);
        pushState();
    }

    // 기본 디시콘을 고르는 화면용입니다. 목록은 로그인할 때 불러 둔 것이라 디시에 요청하지 않고,
    // 이미지는 그 계정이 가진 디시콘의 이미지만 받습니다.
    const dcconImages = new DcconImages();
    handle("getDccons", (_event, accountId: string): DcconPackage[] => {
        const packages = new Map<number, DcconPackage>();
        for (const dccon of accounts.ownedDccons(accountId)) {
            const entry = packages.get(dccon.packageIdx) ?? {packageIdx: dccon.packageIdx, title: dccon.packageTitle, items: []};
            entry.items.push({detailIdx: dccon.detailIdx, title: dccon.title, img: dccon.img ?? ""});
            packages.set(dccon.packageIdx, entry);
        }
        return [...packages.values()];
    });
    handle("getDcconImages", (_event, accountId: string, urls: string[]) => {
        const owned = new Set(accounts.ownedDccons(accountId).flatMap((dccon) => (dccon.img ? [dccon.img] : [])));
        return dcconImages.load((Array.isArray(urls) ? urls : []).filter((url) => typeof url === "string" && owned.has(url)));
    });
    handle("login", async (_event, accountId: string, otp?: string) => {
        const account = settingsStore.get().accounts.find((item) => item.id === accountId);
        if (!account) throw new Error("계정을 찾을 수 없습니다.");
        if (otp !== undefined && !/^\d{6}$/.test(otp)) throw new Error("OTP는 숫자 6자리입니다.");
        await loginAccount(account, otp);
        return state();
    });
    handle("checkGallery", (_event, galleryId: string, accountIds: string[]) => {
        // 로그인하지 않은 채로는 디시에 요청하지 않고, 그 갤러리의 대기 계정으로만 확인합니다.
        const account = readingAccount(Array.isArray(accountIds) ? accountIds.filter((id) => typeof id === "string") : []);
        if (!account) throw new Error("갤러리를 확인하려면 대기 계정을 먼저 지정하고, 그 계정으로 로그인하세요.");
        if (!appId.canTry()) throw new Error("디시 앱 인증 대기 중이라 지금은 확인할 수 없습니다. 잠시 후 다시 시도하세요.");
        return checkGallery(account.client, galleryId, appId);
    });
    handle("start", () => {
        engine.start();
        pushState();
        return state();
    });
    handle("stop", () => {
        engine.stop();
        pushState();
        return state();
    });
    handle("testWebhook", async () => {
        try {
            await sendDiscordNotice(settingsStore.get().discordWebhookUrl, {
                title: "Hamboogie 알림 테스트",
                description: "이 메시지가 보이면 Discord 웹훅이 정상적으로 연결된 것입니다."
            });
            return {ok: true, message: "테스트 알림을 보냈습니다."};
        } catch (error) {
            return {ok: false, message: errorMessage(error)};
        }
    });

    // 창을 닫으면 앱을 끄지 않고 트레이로 내려 감시를 계속합니다. 끄려면 트레이 메뉴의 "종료"를 씁니다.
    let quitting = false;
    let toldAboutTray = false;

    async function createWindow(): Promise<BrowserWindow> {
        const created = new BrowserWindow({
            width: 1100,
            height: 780,
            minWidth: 860,
            minHeight: 600,
            title: "Hamboogie",
            webPreferences: {
                preload: join(import.meta.dirname, "../preload/index.cjs"),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false
            }
        });
        created.on("closed", () => {
            if (window === created) window = null;
        });
        created.on("close", (event) => {
            if (quitting) return;
            event.preventDefault();
            created.hide();
            if (!toldAboutTray && Notification.isSupported()) {
                toldAboutTray = true;
                new Notification({title: "Hamboogie", body: "창을 닫아도 트레이에서 계속 실행됩니다. 끄려면 트레이 메뉴에서 종료를 누르세요."}).show();
            }
        });
        // 외부 링크는 앱 안이 아니라, 정해진 사이트(디시 글, 이 저장소의 릴리스)만 기본 브라우저로 엽니다.
        created.webContents.setWindowOpenHandler(({url}) => {
            if (isAllowedExternalUrl(url)) void shell.openExternal(url);
            return {action: "deny"};
        });
        // 앱 화면이 다른 페이지(창에 끌어다 놓은 파일 등)로 넘어가지 않게 합니다.
        created.webContents.on("will-navigate", (event, url) => {
            if (!rendererUrl || !sameOrigin(url, rendererUrl)) event.preventDefault();
        });
        if (rendererUrl) await created.loadURL(rendererUrl);
        else await created.loadFile(join(import.meta.dirname, "../renderer/index.html"));
        return created;
    }

    function showWindow(): void {
        // 창이 어떤 이유로든 없어졌으면 새로 만듭니다.
        if (!window) {
            void createWindow().then((created) => {
                window = created;
            });
            return;
        }
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
    }

    // 끄기 전에 밀린 파일 쓰기(처리한 글 기록 등)를 마칩니다. 처리한 글 기록을 잃으면 다시 켰을 때 같은 글에 또 댓글을 달 수 있습니다.
    let flushed = false;
    app.on("before-quit", (event) => {
        quitting = true;
        engine.stop();
        if (flushed) return;
        event.preventDefault();
        void flushAllJson().finally(() => {
            flushed = true;
            app.quit();
        });
    });
    // 창이 모두 없어져도 트레이에서 계속 실행합니다. (리스너가 없으면 Electron이 앱을 끕니다)
    app.on("window-all-closed", () => {});
    app.on("second-instance", showWindow);
    app.on("activate", showWindow);

    tray = createTray({
        showWindow,
        running: () => engine.running,
        watching: () => engine.watching,
        start: () => {
            engine.start();
            pushState();
        },
        stop: () => {
            engine.stop();
            pushState();
        },
        quit: () => app.quit()
    });

    window = await createWindow();
    // 업데이트 설치는 창을 먼저 닫으므로, 트레이로 숨기지 않고 실제로 종료하도록 표시합니다.
    updater = startUpdater(() => pushState(), () => {
        quitting = true;
    });

    // 비밀번호가 저장된 계정은 앱을 켤 때 자동으로 로그인합니다. OTP 토큰이 없으면 OTP 입력을 기다립니다.
    // 실패하면 줄을 설 수 없으니 Discord로도 알립니다.
    const failed: string[] = [];
    for (const account of settingsStore.get().accounts) {
        if (!account.loginId || !secrets.has(`account:${account.id}`)) continue;
        await loginAccount(account);
        const status = accounts.status(account.id);
        // 네트워크가 아직 없을 때처럼 일시적인 오류면 자동으로 다시 로그인하므로 알리지 않습니다.
        if (status.state === "otp_required" || (status.state === "error" && status.retryAt === undefined)) failed.push(`${account.loginId}: ${status.message}`);
    }
    if (failed.length > 0) await engine.alert("계정 자동 로그인 실패", `앱에서 다시 로그인해야 줄을 설 수 있습니다.\n${failed.join("\n")}`);
}

// 시작하다 오류가 나면 창도 트레이도 없이 떠 있게 되므로, 알리고 끝냅니다.
main().catch((error: unknown) => {
    dialog.showErrorBox("Hamboogie를 시작하지 못했습니다", errorMessage(error));
    app.exit(1);
});
