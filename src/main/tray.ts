import {readFileSync} from "node:fs";
import {Menu, nativeImage, Tray} from "electron";
import trayIconPath from "../../resources/tray.png?asset";

export interface TrayActions {
    showWindow(): void;
    running(): boolean;
    watching(): number;
    start(): void;
    stop(): void;
    quit(): void;
}

/** 창을 닫아도 감시가 계속되도록 트레이(macOS는 메뉴 막대)에 아이콘을 둡니다. */
export function createTray(actions: TrayActions): {update(): void} {
    // 아이콘은 32px입니다. macOS 메뉴 막대는 16pt라 2배율 이미지로 읽어야 선명합니다.
    const image = process.platform === "darwin"
        ? nativeImage.createFromBuffer(readFileSync(trayIconPath), {scaleFactor: 2})
        : nativeImage.createFromPath(trayIconPath);
    const tray = new Tray(image);
    tray.on("click", () => actions.showWindow());

    function update(): void {
        const running = actions.running();
        tray.setToolTip(running ? `Hamboogie · 감시 중 (갤러리 ${actions.watching()}개)` : "Hamboogie · 멈춤");
        tray.setContextMenu(Menu.buildFromTemplate([
            {label: "Hamboogie 열기", click: () => actions.showWindow()},
            {type: "separator"},
            running
                ? {label: "감시 멈추기", click: () => actions.stop()}
                : {label: "감시 시작", click: () => actions.start()},
            {type: "separator"},
            {label: "종료", click: () => actions.quit()}
        ]));
    }

    update();
    return {update};
}
