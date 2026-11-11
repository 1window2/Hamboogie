import type {AccountStatus, GalleryRole} from "@shared/types";

/** 매니저는 "주딱", 부매니저는 "파딱"입니다. */
const LABELS: Record<GalleryRole, string> = {manager: "주딱", submanager: "파딱"};

/** 이 계정이 이 갤러리에서 맡은 완장입니다. 완장이 아니거나 아직 알아내지 못했으면 null입니다. */
export function galleryRole(status: AccountStatus, galleryId: string): GalleryRole | null {
    if (status.state !== "logged_in" || !galleryId) return null;
    return status.managedGalleries?.find((gallery) => gallery.galleryId === galleryId)?.role ?? null;
}

/** 주딱·파딱 표시입니다. 대기 계정 목록에서 한눈에 띄도록 색을 채워 그립니다. */
export function RoleBadge({role}: {role: GalleryRole}) {
    return <span className={`role-badge ${role}`} title={role === "manager" ? "매니저" : "부매니저"}>{LABELS[role]}</span>;
}
