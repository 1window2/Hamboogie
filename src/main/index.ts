import {join} from "node:path";
import {app, BrowserWindow, ipcMain, Notification, shell} from "electron";
import type {AccountConfig, AppState, LlmProviderId, SecretKey, Settings} from "@shared/types";
import {AccountManager, createReader, persistReader} from "./dc/accounts";
import {checkGallery} from "./dc/gallery-check";
import {Logger} from "./logger";
import {sendDiscordNotice} from "./notify/discord";
import {Engine} from "./pipeline/engine";
import {Ledger, SecretStore, SettingsStore} from "./store";
import {createTray} from "./tray";

const PROVIDERS: LlmProviderId[] = ["gemini", "openai", "claude"];

async function main(): Promise<void> {
    // 앱이 두 개 뜨면 감시 엔진도 두 개가 되어 같은 글에 댓글이 두 번 달릴 수 있으므로 하나만 실행합니다.
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    await app.whenReady();
    // 개발 모드에서는 Dock에 Electron 기본 아이콘 대신 앱 아이콘을 보여줍니다. 배포 빌드는 설치 파일의 아이콘을 씁니다.
    if (import.meta.env.DEV && process.platform === "darwin") app.dock?.setIcon(join(app.getAppPath(), "build/icon.png"));
    const dataDir = app.getPath("userData");
    const logger = new Logger(join(dataDir, "hamboogie.log"));
    const settingsStore = new SettingsStore(dataDir);
    const secrets = new SecretStore(dataDir);
    const ledger = new Ledger(dataDir);
    const accounts = new AccountManager(secrets);
    let reader = createReader(secrets);
    const engine = new Engine({
        reader: () => reader,
        onReaderReady: () => persistReader(secrets, reader),
        resetReader: async () => {
            reader = createReader(secrets, true);
        },
        accounts,
        ledger,
        secrets,
        logger,
        settings: () => settingsStore.get(),
        onAccountsChanged: () => pushState()
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
            watching: engine.watching
        };
    }

    let tray: {update(): void} | null = null;

    function pushState(): void {
        window?.webContents.send("state", state());
        tray?.update();
    }

    logger.subscribe((entry) => window?.webContents.send("log", entry));

    // 개발 모드 전용 테스트 실행입니다. 배포 빌드에서는 이 분기와 모듈이 통째로 빠집니다.
    if (import.meta.env.DEV) {
        const {registerDevTestIpc} = await import("./dev/test-run");
        registerDevTestIpc({engine, accounts, logger, settings: () => settingsStore.get()});
    }

    ipcMain.handle("getState", () => state());
    ipcMain.handle("getLogs", () => logger.recent());
    ipcMain.handle("saveSettings", async (_event, next: Settings) => {
        const removed = settingsStore.get().accounts.filter((account) => !next.accounts.some((item) => item.id === account.id));
        for (const account of removed) await accounts.remove(account.id);
        await settingsStore.save(next);
        return state();
    });
    ipcMain.handle("setSecret", async (_event, key: SecretKey, value: string) => {
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

    ipcMain.handle("login", async (_event, accountId: string, otp?: string) => {
        const account = settingsStore.get().accounts.find((item) => item.id === accountId);
        if (!account) throw new Error("계정을 찾을 수 없습니다.");
        if (otp !== undefined && !/^\d{6}$/.test(otp)) throw new Error("OTP는 숫자 6자리입니다.");
        await loginAccount(account, otp);
        return state();
    });
    ipcMain.handle("checkGallery", (_event, galleryId: string) => checkGallery(reader, galleryId));
    ipcMain.handle("start", () => {
        engine.start();
        tray?.update();
        return state();
    });
    ipcMain.handle("stop", () => {
        engine.stop();
        tray?.update();
        return state();
    });
    ipcMain.handle("testWebhook", async () => {
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
        created.webContents.setWindowOpenHandler(({url}) => {
            if (url.startsWith("https://")) void shell.openExternal(url);
            return {action: "deny"};
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
