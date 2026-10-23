import {copyFileSync, existsSync, mkdirSync} from "node:fs";
import {join} from "node:path";
import {app, BrowserWindow, ipcMain, Notification, shell, type IpcMainInvokeEvent} from "electron";
import type {AccountConfig, AppState, LlmProviderId, SecretKey, Settings} from "@shared/types";
import type {DCInside, DeviceCredentials} from "@green-1052/dcinside.js";
import {AccountManager, createReader, persistReader} from "./dc/accounts";
import {AppIdBackoff} from "./dc/app-id-backoff";
import {checkGallery} from "./dc/gallery-check";
import {Logger} from "./logger";
import {sendDiscordNotice} from "./notify/discord";
import {Engine} from "./pipeline/engine";
import {HistoryStore, Ledger, SecretStore, SettingsStore} from "./store";
import {createTray} from "./tray";
import {startUpdater, type Updater} from "./updater";

const PROVIDERS: LlmProviderId[] = ["gemini", "openai", "claude"];

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
    // 읽기용 기기는 로그인된 계정이 없을 때만 씁니다. 계정이 있으면 그 계정으로 읽어서 앱 인증(app_id)을 하나만 받습니다.
    let reader = fakeClient ? fakeClient() : createReader(secrets);
    const readingAccount = () => accounts.readingClient(settingsStore.get().accounts);
    let readerUsed = false;
    const engine = new Engine({
        reader: () => {
            const account = readingAccount();
            if (account) return account.client;
            readerUsed = true;
            return reader;
        },
        onReadSucceeded: async () => {
            const account = readingAccount();
            if (account) accounts.markAppIdOk(account.accountId);
            // 따로 쓴 읽기용 기기는 app_id를 받은 뒤 저장해야 다음 실행 때 다시 발급받지 않습니다.
            else if (readerUsed) await persistReader(secrets, reader);
        },
        resetReader: async () => {
            const account = readingAccount();
            if (account) await accounts.refreshDevice(account.accountId);
            else reader = fakeClient ? fakeClient() : createReader(secrets, true);
        },
        appId,
        accounts,
        ledger,
        history,
        secrets,
        logger,
        settings: () => settingsStore.get(),
        onStateChanged: () => pushState()
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
            update: updater?.state() ?? {state: "idle"}
        };
    }

    let tray: {update(): void} | null = null;
    let updater: Updater | null = null;

    function pushState(): void {
        window?.webContents.send("state", state());
        tray?.update();
    }

    logger.subscribe((entry) => window?.webContents.send("log", entry));
    history.subscribe((entry) => window?.webContents.send("history", entry));

    // 개발 모드 전용 테스트 실행입니다. 배포 빌드에서는 이 분기와 모듈이 통째로 빠집니다.
    if (import.meta.env.DEV) {
        const {registerDevTestIpc} = await import("./dev/test-run");
        registerDevTestIpc({engine, accounts, logger, settings: () => settingsStore.get(), reader: () => readingAccount()?.client ?? reader});
    }

    // 앱 화면(개발 서버 또는 앱에 들어 있는 index.html)에서 온 요청만 받습니다.
    // 창이 다른 페이지로 넘어가는 것은 아래에서 막지만, 혹시 다른 페이지가 preload API를 쓰려 해도 거절합니다.
    const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
    const fromApp = (event: IpcMainInvokeEvent): boolean => {
        const url = event.senderFrame?.url ?? "";
        return rendererUrl ? url.startsWith(rendererUrl) : url.startsWith("file://") && url.includes("/renderer/index.html");
    };
    const handle = <A extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: A) => R) => {
        ipcMain.handle(channel, (event, ...args) => {
            if (!fromApp(event)) throw new Error("허용되지 않은 화면에서 온 요청입니다.");
            return listener(event, ...(args as A));
        });
    };

    handle("getState", () => state());
    handle("getLogs", () => logger.recent());
    handle("getHistory", () => history.all());
    handle("installUpdate", () => updater?.install());
    handle("saveSettings", async (_event, next: Settings) => {
        const removed = settingsStore.get().accounts.filter((account) => !next.accounts.some((item) => item.id === account.id));
        for (const account of removed) await accounts.remove(account.id);
        await settingsStore.save(next);
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

    handle("login", async (_event, accountId: string, otp?: string) => {
        const account = settingsStore.get().accounts.find((item) => item.id === accountId);
        if (!account) throw new Error("계정을 찾을 수 없습니다.");
        if (otp !== undefined && !/^\d{6}$/.test(otp)) throw new Error("OTP는 숫자 6자리입니다.");
        await loginAccount(account, otp);
        return state();
    });
    handle("checkGallery", (_event, galleryId: string) => checkGallery(readingAccount()?.client ?? reader, galleryId));
    handle("start", () => {
        engine.start();
        tray?.update();
        return state();
    });
    handle("stop", () => {
        engine.stop();
        tray?.update();
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
            return {ok: false, message: error instanceof Error ? error.message : String(error)};
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
        // 외부 링크는 앱 안이 아니라 기본 브라우저로 엽니다.
        // 정해진 사이트(디시 글, 이 저장소의 릴리스)만 기본 브라우저로 엽니다.
        created.webContents.setWindowOpenHandler(({url}) => {
            if (isAllowedExternalUrl(url)) void shell.openExternal(url);
            return {action: "deny"};
        });
        // 앱 화면이 다른 페이지(창에 끌어다 놓은 파일 등)로 넘어가지 않게 합니다.
        created.webContents.on("will-navigate", (event, url) => {
            if (!rendererUrl || !url.startsWith(rendererUrl)) event.preventDefault();
        });
        if (process.env["ELECTRON_RENDERER_URL"]) await created.loadURL(process.env["ELECTRON_RENDERER_URL"]);
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

    app.on("before-quit", () => {
        quitting = true;
        engine.stop();
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
        if (status.state === "otp_required" || status.state === "error") failed.push(`${account.loginId}: ${status.message}`);
    }
    if (failed.length > 0) await engine.alert("계정 자동 로그인 실패", `앱에서 다시 로그인해야 줄을 설 수 있습니다.\n${failed.join("\n")}`);
}

void main();
