import {useEffect, useState} from "react";
import {DEFAULT_DCCONS_MAX} from "@shared/settings";
import {errorMessage} from "@shared/errors";
import type {DcconPackage, DcconRef} from "@shared/types";

interface Props {
    accountId: string;
    selected: DcconRef[];
    onChange(selected: DcconRef[]): void;
}

const same = (a: {packageIdx: number; detailIdx: number}, b: {packageIdx: number; detailIdx: number}) =>
    a.packageIdx === b.packageIdx && a.detailIdx === b.detailIdx;

/**
 * 정해진 문구가 없는 줄에 "줄" 대신 달 기본 디시콘을 고릅니다. 이미지는 고르기를 열고 패키지를 눌렀을 때만 받습니다
 * (디시 이미지 서버에 요청이 나가므로).
 */
export function DefaultDccons({accountId, selected, onChange}: Props) {
    const [open, setOpen] = useState(false);
    const [packages, setPackages] = useState<DcconPackage[] | null>(null);
    const [current, setCurrent] = useState<number | null>(null);
    const [images, setImages] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || packages) return;
        void window.hamboogie.getDccons(accountId).then(setPackages, (caught: unknown) => setError(errorMessage(caught)));
    }, [open, packages, accountId]);

    const imageOf = (ref: {packageIdx: number; detailIdx: number}) => {
        const item = packages?.find((pack) => pack.packageIdx === ref.packageIdx)?.items.find((entry) => entry.detailIdx === ref.detailIdx);
        return item?.img ? images[item.img] : undefined;
    };

    async function load(urls: string[]) {
        const missing = urls.filter((url) => url && !images[url]);
        if (missing.length === 0) return;
        setLoading(true);
        try {
            const loaded = await window.hamboogie.getDcconImages(accountId, missing);
            setImages((prev) => ({...prev, ...loaded}));
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setLoading(false);
        }
    }

    // 고르기를 열면 이미 고른 디시콘의 이미지부터 보여줍니다.
    useEffect(() => {
        if (!open || !packages) return;
        void load(selected.flatMap((ref) => {
            const item = packages.find((pack) => pack.packageIdx === ref.packageIdx)?.items.find((entry) => entry.detailIdx === ref.detailIdx);
            return item?.img ? [item.img] : [];
        }));
    }, [open, packages]);

    function choosePackage(packageIdx: number) {
        setCurrent(packageIdx);
        const pack = packages?.find((item) => item.packageIdx === packageIdx);
        if (pack) void load(pack.items.map((item) => item.img));
    }

    function toggle(pack: DcconPackage, item: DcconPackage["items"][number]) {
        const ref = {packageIdx: pack.packageIdx, detailIdx: item.detailIdx};
        if (selected.some((entry) => same(entry, ref))) {
            onChange(selected.filter((entry) => !same(entry, ref)));
        } else if (selected.length < DEFAULT_DCCONS_MAX) {
            onChange([...selected, {...ref, title: item.title, packageTitle: pack.title}]);
        }
    }

    const pack = packages?.find((item) => item.packageIdx === current);
    return (
        <div className="field">
            <span>기본 디시콘 {selected.length > 0 && <em className="muted">({selected.length}개 중 무작위)</em>}</span>
            <small className="muted">
                글에 정해진 문구나 디시콘이 없으면 "줄" 대신 여기서 고른 디시콘 중 하나를 답니다. 글에 "디시콘 제외"처럼 글자 댓글만
                인정한다고 적혀 있으면 "줄"을 답니다. 고르지 않으면 늘 "줄"입니다.
            </small>
            <div className="row wrap">
                {selected.length === 0 && <span className="muted">고른 디시콘 없음</span>}
                {selected.map((ref) => (
                    <span key={`${ref.packageIdx}:${ref.detailIdx}`} className="chip dccon-chip">
                        {imageOf(ref) && <img src={imageOf(ref)} alt="" width={28} height={28}/>}
                        {ref.packageTitle} {ref.title}
                        <button aria-label={`${ref.packageTitle} ${ref.title} 빼기`} onClick={() => onChange(selected.filter((entry) => !same(entry, ref)))}>×</button>
                    </span>
                ))}
                <button className="button small" onClick={() => setOpen(!open)}>{open ? "닫기" : "디시콘 고르기"}</button>
            </div>
            {open && (
                <div className="dccon-picker">
                    {error && <div className="banner error">{error}</div>}
                    {!packages && !error && <span className="muted">불러오는 중…</span>}
                    {packages && packages.length === 0 && <span className="muted">가진 디시콘이 없습니다.</span>}
                    {packages && packages.length > 0 && (
                        <>
                            <small className="muted">패키지를 누르면 그 패키지의 디시콘 이미지를 디시에서 받아 옵니다.</small>
                            <div className="row wrap">
                                {packages.map((item) => (
                                    <button key={item.packageIdx} className={item.packageIdx === current ? "button small selected" : "button small"}
                                            onClick={() => choosePackage(item.packageIdx)}>
                                        {item.title} ({item.items.length})
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    {pack && (
                        <div className="dccon-grid">
                            {pack.items.map((item) => {
                                const chosen = selected.some((entry) => same(entry, {packageIdx: pack.packageIdx, detailIdx: item.detailIdx}));
                                return (
                                    <button key={item.detailIdx} className={chosen ? "dccon-item selected" : "dccon-item"} title={`${pack.title} ${item.title}`}
                                            onClick={() => toggle(pack, item)}>
                                        {images[item.img] ? <img src={images[item.img]} alt={item.title}/> : <span>{loading ? "…" : item.title}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
