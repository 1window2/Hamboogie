import {describe, expect, it} from "vitest";
import {parseNonNegativeInt} from "../src/renderer/src/components/number-text";

describe("parseNonNegativeInt", () => {
    it("빈 칸이나 숫자가 아닌 글자는 null로 읽어 값을 바꾸지 않는다", () => {
        expect(parseNonNegativeInt("")).toBeNull();
        expect(parseNonNegativeInt(" ")).toBeNull();
        expect(parseNonNegativeInt("-1")).toBeNull();
        expect(parseNonNegativeInt("1.5")).toBeNull();
    });

    it("앞자리 0이 있어도 정수로 읽는다", () => {
        expect(parseNonNegativeInt("060")).toBe(60);
        expect(parseNonNegativeInt("0")).toBe(0);
    });
});
