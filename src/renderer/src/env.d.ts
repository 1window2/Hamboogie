import type {HamboogieApi} from "@shared/types";

declare global {
    interface Window {
        hamboogie: HamboogieApi;
    }
}

export {};
