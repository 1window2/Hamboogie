import {describe, expect, it, vi} from "vitest";

vi.mock("electron", () => ({app: {isPackaged: false, getVersion: () => "1.1.0"}}));
vi.mock("electron-updater", () => ({default: {autoUpdater: {}}}));

const {isNewerVersion} = await import("../src/main/updater");

describe("isNewerVersion", () => {
    it("버전을 숫자로 비교한다", () => {
        expect(isNewerVersion("v1.10.0", "1.9.2")).toBe(true);
        expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
        expect(isNewerVersion("v1.0.0", "1.1.0")).toBe(false);
        expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    });
});
