/**
 * 사진 파일의 머리 부분에서 가로·세로 픽셀 수를 읽습니다(PNG, JPEG, GIF, WebP). 사진을 실제로 풀기 전에 크기를 봐서,
 * 파일은 작아도 풀면 메모리를 몇 GB씩 차지하는 사진(아주 큰 해상도의 단색 PNG 등)을 걸러내려고 씁니다. 읽지 못하면 null입니다.
 */
export function imageDimensions(bytes: Uint8Array): {width: number; height: number} | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
    // PNG: 8바이트 서명 뒤 첫 덩어리(IHDR)에 가로·세로가 있습니다.
    if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
        return {width: view.getUint32(16), height: view.getUint32(20)};
    }
    // GIF: 논리 화면 크기(작은 끝 순서)입니다.
    if (bytes.length >= 10 && ascii(0, 3) === "GIF") {
        return {width: view.getUint16(6, true), height: view.getUint16(8, true)};
    }
    // WebP: RIFF 안의 VP8(손실), VP8L(무손실), VP8X(확장) 덩어리마다 적는 자리가 다릅니다.
    if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
        const chunk = ascii(12, 4);
        if (chunk === "VP8 ") return {width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
        if (chunk === "VP8L") {
            const bits = view.getUint32(21, true);
            return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1};
        }
        if (chunk === "VP8X") {
            const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
            const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
            return {width, height};
        }
        return null;
    }
    // JPEG: 표식(0xFF..)을 따라가다 프레임 시작(SOF0~SOF15, DHT·JPG·DAC 제외)에서 세로·가로를 읽습니다.
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) return null;
            const marker = bytes[offset + 1]!;
            // 채우기 바이트와 길이가 없는 표식은 건너뜁니다.
            if (marker === 0xff) {
                offset++;
                continue;
            }
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2;
                continue;
            }
            const length = view.getUint16(offset + 2);
            if (length < 2) return null;
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return {width: view.getUint16(offset + 7), height: view.getUint16(offset + 5)};
            }
            offset += 2 + length;
        }
    }
    return null;
}

/** 풀어도 되는 사진의 최대 픽셀 수(약 4천만, 풀면 160MB 정도)와 한 변의 최대 길이입니다. */
export const IMAGE_PIXELS_MAX = 40_000_000;
export const IMAGE_EDGE_MAX = 16_384;

/** 크기를 읽을 수 있고, 풀어도 메모리를 너무 많이 쓰지 않는 사진인지입니다. */
export function isDecodableSize(bytes: Uint8Array): boolean {
    const size = imageDimensions(bytes);
    if (!size || size.width <= 0 || size.height <= 0) return false;
    return size.width <= IMAGE_EDGE_MAX && size.height <= IMAGE_EDGE_MAX && size.width * size.height <= IMAGE_PIXELS_MAX;
}
