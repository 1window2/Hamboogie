import {describe, expect, it} from "vitest";
import {isCommitEnter} from "../src/renderer/src/components/keys";

describe("isCommitEnter", () => {
    it("한글 조합 중에 누른 Enter는 확정으로 보지 않는다", () => {
        expect(isCommitEnter({key: "Enter", keyCode: 13, nativeEvent: {isComposing: false}})).toBe(true);
        expect(isCommitEnter({key: "Enter", keyCode: 229, nativeEvent: {isComposing: true}})).toBe(false);
        expect(isCommitEnter({key: "Enter", keyCode: 229, nativeEvent: {isComposing: false}})).toBe(false);
        expect(isCommitEnter({key: "a", keyCode: 65, nativeEvent: {isComposing: false}})).toBe(false);
    });
});
