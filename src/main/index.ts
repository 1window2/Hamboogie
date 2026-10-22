import {join} from "node:path";
import {app, BrowserWindow, ipcMain, shell} from "electron";
import type {AppState, LlmProviderId, SecretKey, Settings} from "@shared/types";
import {AccountManager, createReader, persistReader} from "./dc/accounts";
import {Logger} from "./logger";
import {sendDiscordNotice} from "./notify/discord";
import {Engine} from "./pipeline/engine";
import {Ledger, SecretStore, SettingsStore} from "./store";

const PROVIDERS: LlmProviderId[] = ["gemini", "openai", "claude"];

async function main(): Promise<void> {
    await app.whenReady();
    const dataDir = app.getPath("userData");
    const logger = new Logger(join(dataDir, "hamboogie.log"));
    const settingsStore = new SettingsStore(dataDir);
    const secrets = new SecretStore(dataDir);
    const ledger = new Ledger(dataDir);
    const accounts = new AccountManager(secrets);
    const reader = await createReader(secrets);
    const engine = new Engine({
        reader,
        onReaderReady: () => persistReader(secrets, reader),
        accounts,
        ledger,
        secrets,
        logger,
        settings: () => settingsStore.get()
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
            running: engine.running
        };
    }

    function pushState(): void {
        window?.webContents.send("state", state());
    }

    logger.subscribe((entry) => window?.webContents.send("log", entry));

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
    ipcMain.handle("login", async (_event, accountId: string) => {
        const account = settingsStore.get().accounts.find((item) => item.id === accountId);
        if (!account) throw new Error("계정을 찾을 수 없습니다.");
        const pending = accounts.login(account);
        pushState();
        const status = await pending;
        if (status.state === "logged_in") logger.success(`${status.nickname} (${account.loginId}) 로그인 성공`);
        else if (status.state === "error") logger.error(`${account.loginId} ${status.message}`);
        return state();
    });
    ipcMain.handle("start", () => {
        engine.start();
        return state();
    });
    ipcMain.handle("stop", () => {
        engine.stop();
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

    window = new BrowserWindow({
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
    window.on("closed", () => {
        window = null;
    });
    // 외부 링크는 앱 안이 아니라 기본 브라우저로 엽니다.
    window.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith("https://")) void shell.openExternal(url);
        return {action: "deny"};
    });

    if (process.env["ELECTRON_RENDERER_URL"]) await window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    else await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));

    app.on("window-all-closed", () => {
        engine.stop();
        app.quit();
    });
}

void main();
