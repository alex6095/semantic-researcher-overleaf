export function safeJsonStringify(value: unknown): string | undefined {
    try {
        const seen = new WeakSet<object>();
        return JSON.stringify(value, (_key, nestedValue) => {
            if (typeof nestedValue==='object' && nestedValue!==null) {
                if (seen.has(nestedValue)) {
                    return '[Circular]';
                }
                seen.add(nestedValue);
            }
            if (typeof nestedValue==='function') {
                return `[Function ${nestedValue.name || 'anonymous'}]`;
            }
            if (typeof nestedValue==='bigint') {
                return nestedValue.toString();
            }
            return nestedValue;
        });
    } catch {
        return undefined;
    }
}

function fallbackString(value: unknown): string {
    if (typeof value==='object' && value!==null) {
        const keys = Object.keys(value);
        const constructorName = value.constructor?.name;
        const objectName = constructorName && constructorName!=='Object' ? constructorName : 'Object';
        return keys.length===0 ? objectName : `${objectName} with keys: ${keys.join(', ')}`;
    }
    return String(value);
}

function cleanErrorMessage(message: string) {
    return message
        .replace(/\[object Object\]/g, '')
        .replace(/\s+([:,.])/g, '$1')
        .replace(/:\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
        const details: Record<string, unknown> = {};
        const errorRecord = error as Error & {code?: unknown} & Record<string, unknown>;
        if (errorRecord.code!==undefined) {
            details.code = errorRecord.code;
        }
        for (const key of Object.keys(errorRecord)) {
            if (key==='name' || key==='message' || key==='stack' || key==='code') {
                continue;
            }
            details[key] = errorRecord[key];
        }

        const name = error.name && error.name!=='Error' ? `${error.name}: ` : '';
        const message = cleanErrorMessage(error.message || '') || 'Unknown error';
        const detailsText = Object.keys(details).length===0 ? '' : ` ${safeJsonStringify(details) ?? fallbackString(details)}`;
        return `${name}${message}${detailsText}`;
    }

    if (typeof error==='string') {
        return cleanErrorMessage(error) || 'Unknown error';
    }
    if (error===undefined) {
        return 'Unknown error';
    }

    const json = safeJsonStringify(error);
    if (json!==undefined) {
        return json;
    }
    return fallbackString(error);
}
