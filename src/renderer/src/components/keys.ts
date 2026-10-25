/**
 * 입력을 확정하는 Enter인지 봅니다. 한글처럼 입력기(IME)로 글자를 조합하는 중에 누른 Enter는 조합을 끝내는 키라서
 * 무시합니다. 무시하지 않으면 "부기"를 입력하고 Enter를 눌렀을 때, 조합 중이던 "기"가 비운 칸에 다시 확정되며
 * "기"가 한 번 더 추가됩니다. (조합 중 keydown은 `isComposing`이 true이고, 일부 브라우저는 keyCode 229를 줍니다.)
 */
export function isCommitEnter(event: {key: string; keyCode?: number; nativeEvent?: {isComposing?: boolean}}): boolean {
    return event.key === "Enter" && event.nativeEvent?.isComposing !== true && event.keyCode !== 229;
}
