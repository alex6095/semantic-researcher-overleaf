declare module 'node-diff3' {
    export type MergeRegion<T> = {
        ok?: T[];
        conflict?: {
            a: T[];
            o: T[];
            b: T[];
        };
    };

    export function diff3Merge<T>(
        a: T[],
        original: T[],
        b: T[],
        options?: {excludeFalseConflicts?: boolean},
    ): MergeRegion<T>[];
}
