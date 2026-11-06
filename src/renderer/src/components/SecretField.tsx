import {useState} from "react";
import {isCommitEnter} from "./keys";
import {useConfirm, type ConfirmOptions} from "./ConfirmDialog";

interface Props {
    label: string;
    /** 이미 저장된 값이 있는지입니다. 값 자체는 화면으로 받지 않습니다. */
    saved: boolean;
    /** 저장합니다. 성공하면 true입니다. 성공했을 때만 입력칸을 비웁니다. */
    onSave(value: string): Promise<boolean>;
    /** 있으면 저장된 값이 있을 때 "지우기" 버튼을 보여주고, 누르면 이 내용으로 먼저 묻습니다. */
    clear?: {confirm: Omit<ConfirmOptions, "danger">; onClear(): Promise<boolean>};
    autoComplete?: string;
    /** 앞뒤 공백을 지우고 저장합니다(API 키). 비밀번호는 공백도 글자일 수 있어 그대로 둡니다. */
    trim?: boolean;
}

/**
 * 비밀번호나 API 키처럼 저장한 뒤 다시 보여주지 않는 값의 입력칸입니다. 저장에 실패하면 입력한 값을 그대로 두고
 * 실패했다고 알립니다(자세한 까닭은 위쪽 오류 안내에 나옵니다). 입력칸에서 Enter를 눌러도 저장합니다.
 */
export function SecretField({label, saved, onSave, clear, autoComplete = "off", trim = false}: Props) {
    const [value, setValue] = useState("");
    // 빈 값을 저장하면 저장된 값이 지워지므로, 공백만 입력했을 때는 저장하지 않습니다.
    const input = trim ? value.trim() : value;
    const [busy, setBusy] = useState(false);
    /** 마지막 저장이나 지우기가 실패했으면 그 동작입니다. */
    const [failed, setFailed] = useState<"save" | "clear" | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    async function finish(kind: "save" | "clear", action: () => Promise<boolean>, onSuccess?: () => void) {
        setBusy(true);
        setFailed(null);
        try {
            if (await action()) onSuccess?.();
            else setFailed(kind);
        } finally {
            setBusy(false);
        }
    }

    function save() {
        if (!input || busy) return;
        void finish("save", () => onSave(input), () => setValue(""));
    }

    async function remove() {
        if (!clear || busy) return;
        if (await confirm({...clear.confirm, danger: true})) void finish("clear", clear.onClear);
    }

    return (
        <label className="field">
            <span>{label} {saved && <em className="ok-text">(저장됨)</em>}</span>
            <div className="row">
                <input type="password" value={value} autoComplete={autoComplete} placeholder={saved ? "바꾸려면 새로 입력" : ""}
                       onChange={(event) => {
                           setValue(event.target.value);
                           setFailed(null);
                       }}
                       onKeyDown={(event) => isCommitEnter(event) && save()}/>
                <button type="button" className="button small" disabled={!input || busy} onClick={save}>저장</button>
                {clear && saved && <button type="button" className="button danger small" disabled={busy} onClick={() => void remove()}>지우기</button>}
            </div>
            {failed === "save" && <small className="error-text" role="alert">저장하지 못했습니다. 입력한 값은 그대로 두었습니다. 위쪽 오류 안내를 확인한 뒤 다시 저장하세요.</small>}
            {failed === "clear" && <small className="error-text" role="alert">지우지 못했습니다. 위쪽 오류 안내를 확인하세요.</small>}
            {confirmDialog}
        </label>
    );
}
