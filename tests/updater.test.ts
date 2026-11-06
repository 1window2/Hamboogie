import {describe, expect, it, vi} from "vitest";

vi.mock("electron", () => ({app: {isPackaged: false, getVersion: () => "1.1.0"}}));
vi.mock("electron-updater", () => ({default: {autoUpdater: {}}}));

const {isNewerVersion, isReleasePage} = await import("../src/main/updater");

describe("isNewerVersion", () => {
    it("버전을 숫자로 비교한다", () => {
        expect(isNewerVersion("v1.10.0", "1.9.2")).toBe(true);
        expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
        expect(isNewerVersion("v1.0.0", "1.1.0")).toBe(false);
        expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    });
});

describe("isReleasePage", () => {
    it("이 저장소의 릴리스 페이지만 받는다", () => {
        expect(isReleasePage("https://github.com/1window2/Hamboogie/releases/tag/v1.3.5")).toBe(true);
        expect(isReleasePage("https://github.com/1window2/Hamboogie/releases/latest")).toBe(true);
    });

    it("'../'로 다른 곳을 가리키거나, http, 다른 호스트, 포트를 쓴 주소는 받지 않는다", () => {
        for (const url of [
            "https://github.com/1window2/Hamboogie/releases/../../../evil/x",
            "https://github.com/1window2/Hamboogie/releases/%2e%2e/%2e%2e/%2e%2e/evil/x",
            "http://github.com/1window2/Hamboogie/releases/tag/v1.3.5",
            "https://evil.example/1window2/Hamboogie/releases/tag/v1.3.5",
            "https://github.com.evil.example/1window2/Hamboogie/releases/tag/v1.3.5",
            "https://github.com:8443/1window2/Hamboogie/releases/tag/v1.3.5",
            "https://github.com/1window2/HamboogieEvil/releases/tag/v1.3.5",
            "주소 아님",
            undefined
        ]) {
            expect(isReleasePage(url), String(url)).toBe(false);
        }
    });
});
