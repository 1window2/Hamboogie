/** 오류를 로그와 화면에 쓸 문장으로 바꿉니다. */
export function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    // 화면에서 받은 IPC 오류에는 "Error invoking remote method '...': Error: "가 앞에 붙어 옵니다.
    return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
