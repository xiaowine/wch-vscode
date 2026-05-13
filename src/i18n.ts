import { messages, type MessageKey } from "./i18n/zh-cn";

type MessageValues = Record<string, string | number | boolean | undefined>;

export function t(key: MessageKey, values: MessageValues = {}): string {
    const message = messages[key];
    return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
        const value = values[name];
        return value === undefined ? placeholder : String(value);
    });
}
