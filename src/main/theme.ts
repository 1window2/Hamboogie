import {join} from "node:path";
import {nativeTheme} from "electron";
import {readJsonFile, writeJson} from "./files";

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_LABELS: Record<ThemeChoice, string> = {system: "시스템 설정 따르기", light: "밝게", dark: "어둡게"};

/**
 * 화면 테마(시스템 설정 따르기, 밝게, 어둡게)입니다. 메뉴 막대(트레이) 메뉴에서 고릅니다.
 * 설정 화면이 저장할 때 덮어쓰지 않도록 설정 파일과 따로 ui.json에 둡니다.
 * Electron의 테마를 바꾸면 앱 화면의 밝음·어두움(prefers-color-scheme)도 그대로 따라갑니다.
 */
export class ThemeStore {
    private readonly path: string;
    private current: ThemeChoice = "system";

    constructor(dir: string, private readonly onError: (message: string) => void) {
        this.path = join(dir, "ui.json");
        try {
            const read = readJsonFile(this.path);
            const theme = read.state === "ok" ? (read.value as {theme?: unknown} | null)?.theme : undefined;
            if (theme === "light" || theme === "dark") this.current = theme;
        } catch (error) {
            onError(`화면 테마 설정을 읽지 못해 시스템 설정을 따릅니다: ${(error as Error).message}`);
        }
        nativeTheme.themeSource = this.current;
    }

    get choice(): ThemeChoice {
        return this.current;
    }

    set(choice: ThemeChoice): void {
        this.current = choice;
        nativeTheme.themeSource = choice;
        writeJson(this.path, {theme: choice}).catch((error: unknown) => this.onError(`화면 테마 설정을 저장하지 못했습니다: ${(error as Error).message}`));
    }
}
