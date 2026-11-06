import {readFileSync} from "node:fs";
import {Menu, nativeImage, Tray, type NativeImage} from "electron";
import trayIconPath from "../../resources/tray.png?asset";
import runningIconPath from "../../resources/trayTemplate.png?asset";
import runningIcon2xPath from "../../resources/trayTemplate@2x.png?asset";
import stoppedIconPath from "../../resources/trayStoppedTemplate.png?asset";
import stoppedIcon2xPath from "../../resources/trayStoppedTemplate@2x.png?asset";

export interface TrayActions {
    showWindow(): void;
    running(): boolean;
    watching(): number;
    start(): void;
    stop(): void;
    quit(): void;
}

/**
 * macOS 메뉴 막대용 템플릿 이미지입니다. 검은색과 투명도만 있어서, macOS가 메뉴 막대 색(밝음·어두움)에 맞춰 칠합니다.
 * 메뉴 막대는 16pt라 1배(16px)와 2배(32px) 이미지를 한 이미지에 함께 넣어 화면 배율에 맞는 것을 쓰게 합니다.
 */
function templateImage(path: string, path2x: string): NativeImage {
    const image = nativeImage.createFromBuffer(readFileSync(path), {scaleFactor: 1});
    image.addRepresentation({scaleFactor: 2, buffer: readFileSync(path2x)});
    image.setTemplateImage(true);
    return image;
}

/** 창을 닫아도 감시가 계속되도록 트레이(macOS는 메뉴 막대)에 아이콘을 둡니다. */
export function createTray(actions: TrayActions): {update(): void} {
    // macOS는 다른 메뉴 막대 앱처럼 단색 아이콘을 쓰고, 멈추면 아이콘을 흐리게(40%) 그려 감시 중과 구분합니다.
    // Windows 트레이는 보통 컬러 아이콘이라 기존 아이콘을 그대로 씁니다.
    const icons = process.platform === "darwin"
        ? {running: templateImage(runningIconPath, runningIcon2xPath), stopped: templateImage(stoppedIconPath, stoppedIcon2xPath)}
        : null;
    const tray = new Tray(icons?.stopped ?? nativeImage.createFromPath(trayIconPath));
    tray.on("click", () => actions.showWindow());
    let shownRunning = false;

    function update(): void {
        const running = actions.running();
        // 상태가 바뀔 때만 이미지를 바꿉니다(update는 상태가 바뀔 때마다 자주 불립니다).
        if (icons && running !== shownRunning) tray.setImage(running ? icons.running : icons.stopped);
        shownRunning = running;
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
