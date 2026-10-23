/** 오류를 로그와 화면에 쓸 문장으로 바꿉니다. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
