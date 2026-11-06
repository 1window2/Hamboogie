import {describe, expect, it} from "vitest";
import {imageDimensions, isDecodableSize} from "../src/main/dc/image-size";

/** 바이트 배열을 이어 붙입니다. 숫자는 한 바이트, 글자는 ASCII 바이트들입니다. */
function bytes(...parts: (number | string | number[])[]): Uint8Array {
    const out: number[] = [];
    for (const part of parts) {
        if (typeof part === "number") out.push(part);
        else if (typeof part === "string") out.push(...Array.from(part, (char) => char.charCodeAt(0)));
        else out.push(...part);
    }
    return new Uint8Array(out);
}

const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const u32be = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u32le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** PNG 서명과 IHDR 덩어리 앞부분(가로·세로까지)입니다. */
const png = (width: number, height: number) => bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(width), u32be(height), [8, 6, 0, 0, 0]);
const gif = (width: number, height: number) => bytes("GIF89a", u16le(width), u16le(height), [0, 0, 0]);
/** APP0(JFIF) 표식 뒤에 SOF0이 오는 JPEG 머리입니다. */
const jpeg = (width: number, height: number) => bytes(
    [0xff, 0xd8],
    [0xff, 0xe0], u16be(16), "JFIF", [0, 1, 1, 0], u16be(1), u16be(1), [0, 0],
    [0xff, 0xc0], u16be(17), [8], u16be(height), u16be(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
);
const riff = (chunk: string, payload: number[]) => bytes("RIFF", u32le(4 + 8 + payload.length), "WEBP", chunk, u32le(payload.length), payload);

describe("사진 크기 읽기", () => {
    it("PNG, GIF, JPEG의 가로·세로를 머리 부분에서 읽는다", () => {
        expect(imageDimensions(png(640, 480))).toEqual({width: 640, height: 480});
        expect(imageDimensions(gif(320, 200))).toEqual({width: 320, height: 200});
        expect(imageDimensions(jpeg(1024, 768))).toEqual({width: 1024, height: 768});
    });

    it("WebP는 VP8, VP8L, VP8X 덩어리마다 다른 자리에서 읽는다", () => {
        // VP8: 프레임 태그 3바이트, 시작 코드 9d 01 2a 뒤에 14비트 가로·세로
        expect(imageDimensions(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(600), 0, 0]))).toEqual({width: 800, height: 600});
        // VP8L: 서명 0x2f 뒤 32비트에 (가로-1) 14비트, (세로-1) 14비트
        const bits = (300 - 1) | ((150 - 1) << 14);
        expect(imageDimensions(riff("VP8L", [0x2f, ...u32le(bits), 0, 0, 0, 0, 0, 0]))).toEqual({width: 300, height: 150});
        // VP8X: 플래그 4바이트 뒤 24비트 (가로-1), (세로-1)
        expect(imageDimensions(riff("VP8X", [0, 0, 0, 0, ...u24le(2000 - 1), ...u24le(1000 - 1)]))).toEqual({width: 2000, height: 1000});
    });

    it("모르는 형식이나 너무 짧은 머리는 읽지 못한다", () => {
        expect(imageDimensions(bytes("hello world, not an image"))).toBeNull();
        expect(imageDimensions(new Uint8Array(0))).toBeNull();
        expect(imageDimensions(png(10, 10).subarray(0, 20))).toBeNull();
        expect(imageDimensions(riff("ABCD", Array.from({length: 12}, () => 0)))).toBeNull();
    });
});

describe("풀어도 되는 크기", () => {
    it("작은 파일이라도 풀면 너무 커지는 사진은 거른다", () => {
        expect(isDecodableSize(png(65535, 65535))).toBe(false);
        expect(isDecodableSize(png(1000, 1000))).toBe(true);
        expect(isDecodableSize(png(0, 10))).toBe(false);
    });

    it("크기를 읽지 못하면 풀지 않는다", () => {
        expect(isDecodableSize(bytes("<html>"))).toBe(false);
        expect(isDecodableSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00]))).toBe(false);
    });
});
