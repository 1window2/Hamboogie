import type {AccountConfig, Settings} from "@shared/types";

/** 계정 탭에서 바로 저장하는 계정 추가·삭제입니다. */
export type AccountChange = {kind: "add"; account: AccountConfig} | {kind: "remove"; id: string};

/** 설정에 계정 추가·삭제를 적용합니다. 삭제하면 갤러리의 대기 계정에서도 뺍니다. */
export function applyAccountChange(settings: Settings, change: AccountChange): Settings {
    if (change.kind === "add") {
        if (settings.accounts.some((account) => account.id === change.account.id)) return settings;
        return {...settings, accounts: [...settings.accounts, change.account]};
    }
    return {
        ...settings,
        accounts: settings.accounts.filter((account) => account.id !== change.id),
        galleries: settings.galleries.map((gallery) => gallery.accountIds.includes(change.id)
            ? {...gallery, accountIds: gallery.accountIds.filter((id) => id !== change.id)}
            : gallery)
    };
}

/**
 * 계정 추가·삭제를 저장한 뒤의 초안입니다. 그사이 고치던 초안에 같은 변경만 적용하므로, 저장하지 않은 다른 변경은 저장되지 않은 채로 남습니다.
 * 새 계정은 저장된(main이 다듬은) 값을 넣어, 다른 변경이 없으면 초안이 저장된 설정과 같아지게 합니다.
 */
export function draftAfterAccountChange(draft: Settings, saved: Settings, change: AccountChange): Settings {
    if (change.kind === "add") {
        const account = saved.accounts.find((item) => item.id === change.account.id) ?? change.account;
        return applyAccountChange(draft, {kind: "add", account});
    }
    return applyAccountChange(draft, change);
}
