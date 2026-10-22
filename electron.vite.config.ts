import {resolve} from "node:path";
import {defineConfig} from "electron-vite";
import react from "@vitejs/plugin-react";

const shared = {"@shared": resolve("src/shared")};

export default defineConfig({
    main: {
        resolve: {alias: shared},
        // 라이브러리를 node_modules째로 싣지 않고 쓰는 코드만 묶어서 설치 파일을 줄입니다.
        build: {externalizeDeps: false, minify: true}
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
