/** 머리글 로고(버거 말풍선)입니다. 색은 테마 색(--brand-logo)을 따라, 밝은 화면은 디시 파랑, 어두운 화면은 아이보리로 칠합니다. */
export function Logo({size}: {size: number}) {
    return (
        <svg className="brand-logo" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
            <path fillRule="evenodd" d="M7 14 H25 Q26 14 26 13 C26 8.6 21.6 5.5 16 5.5 C10.4 5.5 6 8.6 6 13 Q6 14 7 14 Z
                M16 8.2 m-1.3 0 a1.3 0.8 0 1 0 2.6 0 a1.3 0.8 0 1 0 -2.6 0 Z
                M12.2 9.6 m-1.3 0 a1.3 0.8 0 1 0 2.6 0 a1.3 0.8 0 1 0 -2.6 0 Z
                M19.8 9.6 m-1.3 0 a1.3 0.8 0 1 0 2.6 0 a1.3 0.8 0 1 0 -2.6 0 Z"/>
            <rect x="5" y="15.5" width="22" height="3.4" rx="1.7"/>
            <path d="M7 20.4 H25 Q26 20.4 26 21.4 V22.4 Q26 24.6 23.8 24.6 H13.4 L10 27.6 Q9.2 28.2 9.2 27.2 V24.6 H8.2 Q6 24.6 6 22.4 V21.4 Q6 20.4 7 20.4 Z"/>
        </svg>
    );
}
