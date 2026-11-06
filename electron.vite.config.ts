import {resolve} from "node:path";
import {defineConfig} from "electron-vite";
import react from "@vitejs/plugin-react";

const shared = {"@shared": resolve("src/shared")};

export default defineConfig({
    main: {
        resolve: {alias: shared},
        // 라이브러리를 node_modules째로 싣지 않고 쓰는 코드만 묶어서 설치 파일을 줄입니다.
        // lib 모드에서는 minify가 이름만 줄이고 공백은 남기므로, 출력 단계에서 공백까지 줄입니다.
        // heartbeat-watchdog는 메인 프로세스가 멈췄는지 지켜보는 별도 프로세스(utilityProcess)의 진입점입니다.
        build: {
            externalizeDeps: false,
            minify: true,
            rolldownOptions: {
                input: {index: resolve("src/main/index.ts"), "heartbeat-watchdog": resolve("src/main/heartbeat-watchdog.ts")},
                output: {minify: true}
            }
        }
    },
    preload: {
        resolve: {alias: shared},
        build: {
            // 샌드박스 preload는 CommonJS만 불러올 수 있습니다.
            rollupOptions: {output: {format: "cjs", entryFileNames: "[name].cjs"}}
        }
    },
    renderer: {
        resolve: {alias: shared},
        plugins: [react()],
        build: {minify: true}
    }
});
