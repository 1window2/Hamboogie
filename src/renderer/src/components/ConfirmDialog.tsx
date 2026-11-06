import {useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode} from "react";
import {createPortal} from "react-dom";

export interface ConfirmOptions {
    title: string;
    /** 제목 아래에 보여줄 설명입니다. */
    message?: ReactNode;
    /** 확인 버튼 글자입니다. 무엇을 하는지 드러나게 씁니다(예: "삭제"). */
    confirmLabel: string;
    /** 지우기처럼 되돌릴 수 없는 일이면 확인 버튼을 빨갛게 보여줍니다. */
    danger?: boolean;
}

interface Props extends ConfirmOptions {
    onConfirm(): void;
    onCancel(): void;
}

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** 확인 창을 닫은 뒤 포커스를 옮긴 요소가 사라지는지 이만큼 지켜봅니다(저장이 끝나 카드가 사라지는 때까지). */
const FOCUS_WATCH_MS = 5000;

/**
 * 확인 창을 닫은 뒤 포커스를 연 요소로 돌려줍니다. 연 요소가 사라졌거나(삭제) 누를 수 없게 됐으면, 아직 남아 있는 가장 가까운
 * 상위 요소 안의 첫 버튼·입력칸으로 옮깁니다. 확인한 뒤 저장이 끝나서야 그 요소가 사라지는 경우(계정 삭제 등)도 있어,
 * 옮긴 요소가 잠시 뒤 사라지면 한 번 더 옮깁니다.
 */
function restoreFocus(opener: HTMLElement | null): void {
    const ancestors: HTMLElement[] = [];
    for (let node = opener?.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node);
    let focused: HTMLElement | null = null;
    const apply = () => {
        // 그사이 다른 확인 창이 열렸으면 그 창이 포커스를 맡습니다.
        if (document.querySelector(".modal")) return;
        const usable = opener?.isConnected && !(opener as HTMLButtonElement).disabled;
        focused = usable ? opener : ancestors.map((node) => node.isConnected ? node.querySelector<HTMLElement>(FOCUSABLE) : null).find(Boolean) ?? null;
        focused?.focus();
    };
    setTimeout(apply);
    const root = document.getElementById("root");
    if (!root) return;
    const observer = new MutationObserver(() => {
        if (focused && !focused.isConnected && (document.activeElement === document.body || document.activeElement === null)) apply();
    });
    observer.observe(root, {childList: true, subtree: true});
    setTimeout(() => observer.disconnect(), FOCUS_WATCH_MS);
}

/**
 * 앱 안에서 띄우는 확인 창입니다. 열리면 취소 버튼으로 포커스를 옮기고(Enter를 잘못 눌러 지워지지 않게), 닫히면 연 버튼으로 돌려줍니다.
 * Esc나 바깥 클릭은 취소이고, Enter는 포커스가 있는 버튼을 누릅니다. Tab은 창 안에서만 돕니다.
 *
 * 창은 body 아래에 그립니다. 입력칸을 감싼 label 안에서 열어도, 창 안을 누른 클릭이 그 입력칸으로 넘어가지 않게 하기 위해서입니다.
 */
export function ConfirmDialog({title, message, confirmLabel, danger, onConfirm, onCancel}: Props) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const messageId = useId();

    // 연 요소는 그릴 때 기억합니다(개발 모드의 StrictMode는 effect를 두 번 돌려, 두 번째에는 이미 취소 버튼에 포커스가 가 있습니다).
    const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);

    useEffect(() => {
        // 뒤쪽 화면은 포커스도 클릭도 받지 않게 합니다(스크린 리더도 창만 읽습니다).
        const root = document.getElementById("root");
        if (root) root.inert = true;
        cancelRef.current?.focus();
        return () => {
            if (root) root.inert = false;
        };
    }, []);

    // 닫히면 연 요소로 포커스를 돌려줍니다. 개발 모드의 StrictMode가 열려 있는 동안 정리 함수를 한 번 더 불러도, 창이 열려 있으면 옮기지 않습니다.
    useEffect(() => () => restoreFocus(opener), [opener]);

    function onKeyDown(event: KeyboardEvent) {
        if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
        }
        if (event.key !== "Tab") return;
        const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        // 창 자체(글자를 누른 뒤)에 포커스가 있으면 첫 버튼이나 마지막 버튼으로 옮깁니다. 그냥 두면 창 밖으로 빠져나갑니다.
        if (!items.includes(document.activeElement as HTMLElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    return createPortal(
        <div className="modal-backdrop" onKeyDown={onKeyDown} onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
            {/* 창 안의 글자를 눌러도 포커스가 창에 남아 Esc와 Tab이 계속 먹도록 창 자체도 포커스를 받게 합니다. */}
            <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby={titleId} aria-describedby={message ? messageId : undefined}>
                <h2 id={titleId}>{title}</h2>
                {message && <div id={messageId} className="modal-message">{message}</div>}
                <div className="modal-actions">
                    <button ref={cancelRef} type="button" className="button" onClick={onCancel}>취소</button>
                    <button type="button" className={danger ? "button danger solid" : "button primary"} onClick={onConfirm}>{confirmLabel}</button>
                </div>
            </div>
        </div>,
        document.body
    );
}

/**
 * `window.confirm`처럼 쓰는 확인 창입니다. `confirm(...)`은 확인을 누르면 true, 취소하면 false로 끝납니다.
 * 돌려받은 `dialog`를 화면 어딘가에 그려 둬야 창이 보입니다.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
    const [pending, setPending] = useState<{options: ConfirmOptions; resolve(confirmed: boolean): void} | null>(null);
    const pendingRef = useRef(pending);
    pendingRef.current = pending;

    // 창이 열린 채로 화면이 사라지면(탭 이동 등) 취소한 것으로 끝냅니다.
    useEffect(() => () => pendingRef.current?.resolve(false), []);

    const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
        // 이미 열린 창이 있으면 그 창은 취소로 닫고 새로 엽니다.
        pendingRef.current?.resolve(false);
        setPending({options, resolve});
    }), []);

    function close(confirmed: boolean) {
        pending?.resolve(confirmed);
        setPending(null);
    }

    const dialog = pending && <ConfirmDialog {...pending.options} onConfirm={() => close(true)} onCancel={() => close(false)}/>;
    return [confirm, dialog];
}
