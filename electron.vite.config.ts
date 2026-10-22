import {resolve} from "node:path";
import {defineConfig} from "electron-vite";
import react from "@vitejs/plugin-react";

const shared = {"@shared": resolve("src/shared")};

export default defineConfig({
    main: {
        resolve: {alias: shared}
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
        plugins: [react()]
    }
});
